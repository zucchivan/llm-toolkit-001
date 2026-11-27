use crate::{CGROUP_FD, OWNER_FD, STATUS_FD, errno, gate, stat, syscall_result};
use std::{
    ffi::CString,
    io::{self, Read},
    mem::size_of,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    ptr,
};

const PLACED: u8 = 1;
const EXITED: u8 = 2;
const LAUNCH_ERROR: u8 = 3;
const SIGNALED: u8 = 4;

// Linux UAPI (linux/sched.h). libc 0.2.189's GNU constant is a c_int
// and truncates this flag before it can reach the 64-bit clone3 field.
const CLONE_INTO_CGROUP: u64 = 0x2_0000_0000;

// Linux UAPI struct clone_args, through CLONE_ARGS_SIZE_VER2 (cgroup).
#[repr(C)]
#[derive(Default)]
struct CloneArgs {
    flags: u64,
    pidfd: u64,
    child_tid: u64,
    parent_tid: u64,
    exit_signal: u64,
    stack: u64,
    stack_size: u64,
    tls: u64,
    set_tid: u64,
    set_tid_size: u64,
    cgroup: u64,
}

pub(crate) fn run(command: &[CString]) -> io::Result<()> {
    check_channel(STATUS_FD, libc::O_RDONLY)?;
    check_channel(OWNER_FD, libc::O_WRONLY)?;
    configure_status()?;
    for fd in 0..=2 {
        stat(fd)?;
    }
    let (errors, child_error) = error_pipe()?;
    let argv: Vec<_> = command.iter().map(|arg| arg.as_ptr()).chain([ptr::null()]).collect();
    let child = match place(&argv, child_error.as_raw_fd()) {
        Ok(child) => child,
        Err(error) => {
            report(LAUNCH_ERROR, 0, error.raw_os_error().unwrap_or(libc::EIO))?;
            return Err(error);
        }
    };
    drop(child_error);
    // SAFETY: The launcher has its own descriptor table. Release its copies
    // of the guest streams so their EOF depends only on the guest path.
    for fd in 0..=2 {
        unsafe { libc::close(fd) };
    }

    let outcome = report(PLACED, child, 0).and_then(|()| wait_for_child(child));
    // Even a normal bwrap exit says nothing about lingering lease processes.
    // Revoke and observe the exact cgroup empty before sending a terminal record.
    gate::fence()?;
    let status = match outcome {
        Ok(status) => status,
        Err(error) => {
            // SAFETY: The child pid is returned by clone3. Nonblocking reap
            // is best effort after the independently verified cgroup fence.
            unsafe { libc::waitpid(child, ptr::null_mut(), libc::WNOHANG) };
            return Err(error);
        }
    };
    if let Some(code) = read_child_error(errors)? {
        report(LAUNCH_ERROR, child, code)?;
    } else if libc::WIFEXITED(status) {
        report(EXITED, child, libc::WEXITSTATUS(status))?;
    } else if libc::WIFSIGNALED(status) {
        report(SIGNALED, child, libc::WTERMSIG(status))?;
    } else {
        return Err(errno(libc::EIO));
    }
    Ok(())
}

fn place(argv: &[*const libc::c_char], child_error: libc::c_int) -> io::Result<libc::pid_t> {
    let gate = gate::Gate::lock()?;
    gate.consume()?;
    gate::check_controls()?;
    if !channels_present(0)? {
        drop(gate);
        gate::fence()?;
        return Err(errno(libc::ECANCELED));
    }
    let args = CloneArgs {
        flags: CLONE_INTO_CGROUP,
        exit_signal: libc::SIGCHLD as u64,
        cgroup: CGROUP_FD as u64,
        ..Default::default()
    };
    // SAFETY: The UAPI args and null-terminated pointers are valid. No flags
    // share the stack, memory, or file table. The child only uses raw syscalls
    // before exec or _exit and never returns into Rust cleanup.
    unsafe {
        let pid = syscall_result(libc::syscall(libc::SYS_clone3, &args, size_of::<CloneArgs>()))?;
        if pid == 0 {
            child_exec(argv, child_error);
        }
        Ok(pid as libc::pid_t)
    }
}

unsafe fn child_exec(argv: &[*const libc::c_char], error_fd: libc::c_int) -> ! {
    // SAFETY: All arguments were prepared before clone. Close launcher and
    // unknown descriptors, keeping only stdio and the CLOEXEC error writer.
    unsafe {
        let first = libc::syscall(libc::SYS_close_range, 3u32, error_fd as u32 - 1, 0u32);
        if first != -1
            && libc::syscall(libc::SYS_close_range, error_fd as u32 + 1, u32::MAX, 0u32) != -1
            && libc::signal(libc::SIGPIPE, libc::SIG_DFL) != libc::SIG_ERR
        {
            let environment = [ptr::null()];
            libc::execve(argv[0], argv.as_ptr(), environment.as_ptr());
        }
        let error = (*libc::__errno_location()).to_le_bytes();
        while libc::write(error_fd, error.as_ptr().cast(), error.len()) == -1
            && *libc::__errno_location() == libc::EINTR
        {}
        libc::_exit(126)
    }
}

fn check_channel(fd: libc::c_int, forbidden_mode: libc::c_int) -> io::Result<()> {
    let kind = stat(fd)?.st_mode & libc::S_IFMT;
    // SAFETY: fcntl checks this fixed descriptor; F_GETFL has no extra argument.
    let flags = syscall_result(unsafe { libc::fcntl(fd, libc::F_GETFL) }.into())? as libc::c_int;
    if !matches!(kind, libc::S_IFIFO | libc::S_IFSOCK) || flags & libc::O_ACCMODE == forbidden_mode {
        return Err(errno(libc::EINVAL));
    }
    if kind == libc::S_IFSOCK {
        check_socket(fd)?;
    }
    Ok(())
}

fn check_socket(fd: libc::c_int) -> io::Result<()> {
    // SAFETY: The output buffers have the lengths advertised to the kernel.
    unsafe {
        let mut socket_type = 0 as libc::c_int;
        let mut length = size_of::<libc::c_int>() as libc::socklen_t;
        syscall_result(libc::getsockopt(
            fd, libc::SOL_SOCKET, libc::SO_TYPE, (&mut socket_type as *mut libc::c_int).cast(), &mut length,
        ).into())?;
        if socket_type != libc::SOCK_STREAM {
            return Err(errno(libc::EINVAL));
        }
        let mut peer: libc::sockaddr_storage = std::mem::zeroed();
        let mut length = size_of::<libc::sockaddr_storage>() as libc::socklen_t;
        syscall_result(libc::getpeername(fd, (&mut peer as *mut libc::sockaddr_storage).cast(), &mut length).into())?;
        if peer.ss_family as libc::c_int != libc::AF_UNIX {
            return Err(errno(libc::EINVAL));
        }
    }
    Ok(())
}

fn channels_present(timeout_ms: libc::c_int) -> io::Result<bool> {
    let mut endpoints = [
        libc::pollfd { fd: OWNER_FD, events: libc::POLLIN, revents: 0 },
        libc::pollfd { fd: STATUS_FD, events: 0, revents: 0 },
    ];
    loop {
        // SAFETY: poll receives both initialized descriptors. Even without
        // asking for status writability it reports a broken status endpoint.
        let ready = unsafe { libc::poll(endpoints.as_mut_ptr(), endpoints.len() as _, timeout_ms) };
        if ready >= 0 {
            // The owner channel carries no payload. Any event on either
            // channel revokes liveness.
            return Ok(ready == 0);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn configure_status() -> io::Result<()> {
    // SAFETY: The process owns its status endpoint. Ignore SIGPIPE in the
    // supervisor so a broken status channel takes the fencing path.
    unsafe {
        let flags = syscall_result(libc::fcntl(STATUS_FD, libc::F_GETFL).into())? as libc::c_int;
        syscall_result(libc::fcntl(STATUS_FD, libc::F_SETFL, flags | libc::O_NONBLOCK).into())?;
        if libc::signal(libc::SIGPIPE, libc::SIG_IGN) == libc::SIG_ERR {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

fn wait_for_child(pid: libc::pid_t) -> io::Result<libc::c_int> {
    loop {
        if !channels_present(10)? {
            return Err(errno(libc::ECANCELED));
        }
        let mut status = 0;
        // SAFETY: pid is the immediate child and status points to writable memory.
        let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if result == pid {
            return Ok(status);
        }
        if result == -1 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

fn error_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut pipe = [0; 2];
    // SAFETY: pipe2 initializes two descriptors on success. OwnedFd takes
    // separate ownership of the two fresh ends.
    unsafe {
        syscall_result(libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK).into())?;
        Ok((OwnedFd::from_raw_fd(pipe[0]), OwnedFd::from_raw_fd(pipe[1])))
    }
}

fn read_child_error(fd: OwnedFd) -> io::Result<Option<libc::c_int>> {
    let mut stream = std::fs::File::from(fd);
    let mut bytes = [0u8; 5];
    let count = stream.read(&mut bytes)?;
    match count {
        0 => Ok(None),
        4 => {
            let error = libc::c_int::from_le_bytes(bytes[..4].try_into().unwrap());
            if error > 0 { Ok(Some(error)) } else { Err(errno(libc::EIO)) }
        }
        _ => Err(errno(libc::EIO)),
    }
}

fn report(event: u8, pid: libc::pid_t, detail: libc::c_int) -> io::Result<()> {
    let mut record = [0u8; 16];
    record[..4].copy_from_slice(b"KLS1");
    record[4] = 1;
    record[5] = event;
    record[8..12].copy_from_slice(&(pid as u32).to_le_bytes());
    record[12..].copy_from_slice(&detail.to_le_bytes());
    // SAFETY: The status channel is validated and the record is a valid buffer.
    // One small write keeps a record indivisible on a pipe.
    loop {
        let written = unsafe { libc::write(STATUS_FD, record.as_ptr().cast(), record.len()) };
        if written == record.len() as libc::ssize_t {
            return Ok(());
        }
        if written < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        return Err(errno(libc::EIO));
    }
}
