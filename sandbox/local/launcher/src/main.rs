#[cfg(not(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu")))]
compile_error!("the S2 launcher is qualified for x86_64-unknown-linux-gnu only");

mod gate;
mod launch;

use std::{env, ffi::{CString, OsStr}, io, os::unix::ffi::OsStrExt, process::ExitCode};

const CGROUP_FD: libc::c_int = 3;
const STATUS_FD: libc::c_int = 4;
const OWNER_FD: libc::c_int = 5;
const GATE_FD: libc::c_int = 6;

enum Operation {
    Launch(Vec<CString>),
    Fence,
}

fn invalid() -> io::Error {
    io::Error::from_raw_os_error(libc::EINVAL)
}

fn parse() -> io::Result<Operation> {
    let mut args = env::args_os().skip(1);
    for expected in ["--protocol=1", "--cgroup-fd=3", "--gate-fd=6"] {
        if args.next().as_deref() != Some(OsStr::new(expected)) {
            return Err(invalid());
        }
    }

    match args.next().as_deref().map(|arg| arg.as_bytes()) {
        Some(b"--fence") if args.next().is_none() => Ok(Operation::Fence),
        Some(b"--") => {
            let command = args
                .map(|arg| CString::new(arg.as_bytes()).map_err(|_| invalid()))
                .collect::<io::Result<Vec<_>>>()?;
            let executable = command.first().ok_or_else(invalid)?.as_bytes();
            if executable.first() != Some(&b'/')
                || executable[1..].split(|byte| *byte == b'/')
                    .any(|part| matches!(part, b"" | b"." | b".."))
                || command.len() > 512
            {
                return Err(invalid());
            }
            Ok(Operation::Launch(command))
        }
        _ => Err(invalid()),
    }
}

fn run(operation: Operation) -> io::Result<()> {
    // SAFETY: This single-threaded process owns all its inherited descriptors.
    // The fixed ABI reserves only descriptors 0 through 6.
    syscall_result(unsafe { libc::syscall(libc::SYS_close_range, 7u32, u32::MAX, 0u32) })?;
    match operation {
        Operation::Launch(command) => launch::run(&command),
        Operation::Fence => gate::fence(),
    }
}

fn main() -> ExitCode {
    match parse().and_then(run) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::from(2),
    }
}

pub(crate) fn syscall_result(value: libc::c_long) -> io::Result<libc::c_long> {
    if value < 0 { Err(io::Error::last_os_error()) } else { Ok(value) }
}

pub(crate) fn errno(code: libc::c_int) -> io::Error {
    io::Error::from_raw_os_error(code)
}

pub(crate) fn stat(fd: libc::c_int) -> io::Result<libc::stat> {
    // SAFETY: fstat initializes the output struct on success.
    unsafe {
        let mut info = std::mem::MaybeUninit::uninit();
        syscall_result(libc::fstat(fd, info.as_mut_ptr()).into())?;
        Ok(info.assume_init())
    }
}
