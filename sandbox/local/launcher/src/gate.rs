use crate::{CGROUP_FD, GATE_FD, errno, stat, syscall_result};
use std::{
    ffi::CStr,
    fs::File,
    io::{self, Read, Write},
    os::fd::FromRawFd,
    thread,
    time::{Duration, Instant},
};

const READY: u8 = 1;
const SPENT: u8 = 2;
const REVOKED: u8 = 3;
const TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// A process-associated POSIX lock shared by launch and fence invocations.
/// The clone child doesn't inherit it. Both invocations must use this exact inode.
pub(crate) struct Gate;

impl Gate {
    pub(crate) fn lock() -> io::Result<Self> {
        // SAFETY: F_GETFL takes no additional argument and reads FD status.
        let flags = unsafe { syscall_result(libc::fcntl(GATE_FD, libc::F_GETFL).into())? };
        // Linux pwrite appends on an O_APPEND descriptor even with an explicit offset.
        if flags & libc::O_ACCMODE as libc::c_long != libc::O_RDWR as libc::c_long
            || flags & libc::O_APPEND as libc::c_long != 0
        {
            return Err(errno(libc::EINVAL));
        }
        let info = stat(GATE_FD)?;
        // SAFETY: geteuid takes no arguments and has no process side effects.
        let owner = unsafe { libc::geteuid() };
        if info.st_mode & libc::S_IFMT != libc::S_IFREG
            || info.st_mode & 0o7777 != 0o600
            || info.st_uid != owner
            || info.st_nlink != 1
            || info.st_size != 24
        {
            return Err(errno(libc::EINVAL));
        }
        let deadline = Instant::now() + TIMEOUT;
        loop {
            match set_lock(libc::F_WRLCK) {
                Ok(()) => return Ok(Self),
                Err(error) if matches!(error.raw_os_error(), Some(libc::EACCES | libc::EAGAIN | libc::EINTR)) => {
                    if Instant::now() >= deadline {
                        return Err(errno(libc::ETIMEDOUT));
                    }
                    thread::sleep(POLL_INTERVAL);
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub(crate) fn consume(&self) -> io::Result<()> {
        if self.state()? != READY {
            return Err(errno(libc::ECANCELED));
        }
        self.set_state(SPENT)
    }

    fn revoke(&self) -> io::Result<()> {
        self.state()?;
        // Sync even if the byte was already revoked. A previous writer may
        // have died between the write and sync.
        self.set_state(REVOKED)
    }

    fn state(&self) -> io::Result<u8> {
        let cgroup = stat(CGROUP_FD)?;
        // SAFETY: fstatfs writes to the valid output struct on success. pread
        // writes at most the supplied buffer size without changing the offset.
        let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
        let mut record = [0u8; 24];
        let n = unsafe {
            syscall_result(libc::fstatfs(CGROUP_FD, filesystem.as_mut_ptr()).into())?;
            if filesystem.assume_init().f_type != libc::CGROUP2_SUPER_MAGIC
                || cgroup.st_mode & libc::S_IFMT != libc::S_IFDIR
            {
                return Err(errno(libc::EINVAL));
            }
            syscall_result(libc::pread(GATE_FD, record.as_mut_ptr().cast(), record.len(), 0) as _)?
        };
        if n != record.len() as libc::c_long
            || &record[..4] != b"KLG1"
            || record[5..8] != [0; 3]
            || record[8..16] != cgroup.st_dev.to_le_bytes()
            || record[16..24] != cgroup.st_ino.to_le_bytes()
            || !matches!(record[4], READY | SPENT | REVOKED)
        {
            return Err(errno(libc::EINVAL));
        }
        Ok(record[4])
    }

    fn set_state(&self, state: u8) -> io::Result<()> {
        // SAFETY: The one-byte buffer is valid. Caller holds the gate lock.
        unsafe {
            if syscall_result(libc::pwrite(GATE_FD, (&state as *const u8).cast(), 1, 4) as _)? != 1 {
                return Err(errno(libc::EIO));
            }
            syscall_result(libc::fsync(GATE_FD).into())?;
        }
        Ok(())
    }
}

impl Drop for Gate {
    fn drop(&mut self) {
        // Process exit also releases the lock if explicit unlock fails.
        let _ = set_lock(libc::F_UNLCK);
    }
}

fn set_lock(kind: libc::c_int) -> io::Result<()> {
    // SAFETY: The flock is initialized and fcntl uses it only during the call.
    unsafe {
        let mut lock: libc::flock = std::mem::zeroed();
        lock.l_type = kind as _;
        lock.l_whence = libc::SEEK_SET as _;
        syscall_result(libc::fcntl(GATE_FD, libc::F_SETLK, &lock).into())?;
    }
    Ok(())
}

pub(crate) fn fence() -> io::Result<()> {
    Gate::lock()?.revoke()?;
    control(c"cgroup.kill", libc::O_WRONLY)?.write_all(b"1\n")?;
    let deadline = Instant::now() + TIMEOUT;
    while populated()? {
        if Instant::now() >= deadline {
            return Err(errno(libc::ETIMEDOUT));
        }
        thread::sleep(POLL_INTERVAL);
    }
    Ok(())
}

pub(crate) fn check_controls() -> io::Result<()> {
    let mut kind = Vec::with_capacity(16);
    control(c"cgroup.type", libc::O_RDONLY)?.take(32).read_to_end(&mut kind)?;
    if kind != b"domain\n" {
        return Err(errno(libc::EOPNOTSUPP));
    }
    if populated()? {
        return Err(errno(libc::EBUSY));
    }
    // Reserve the kill write for fencing. Kernels with a cgroup kill-sequence
    // bug can kill a clone immediately if its target was killed before launch.
    control(c"cgroup.kill", libc::O_WRONLY)?;
    Ok(())
}

fn populated() -> io::Result<bool> {
    let mut data = Vec::with_capacity(256);
    control(c"cgroup.events", libc::O_RDONLY)?.take(4097).read_to_end(&mut data)?;
    if data.len() > 4096 {
        return Err(errno(libc::EOVERFLOW));
    }
    let mut lines = data.split(|byte| *byte == b'\n').filter(|line| line.starts_with(b"populated "));
    match (lines.next(), lines.next()) {
        (Some(b"populated 0"), None) => Ok(false),
        (Some(b"populated 1"), None) => Ok(true),
        _ => Err(errno(libc::EINVAL)),
    }
}

fn control(name: &CStr, flags: libc::c_int) -> io::Result<File> {
    // SAFETY: The verified cgroup FD is held throughout. On success openat
    // returns a fresh FD whose ownership is transferred to File.
    unsafe {
        let fd = libc::openat(CGROUP_FD, name.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOFOLLOW);
        syscall_result(fd.into())?;
        Ok(File::from_raw_fd(fd))
    }
}
