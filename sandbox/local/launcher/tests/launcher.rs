use std::{os::unix::process::ExitStatusExt, process::Command};

fn launcher() -> Command {
    Command::new(env!("CARGO_BIN_EXE_kit-local-launcher"))
}

#[test]
fn unknown_or_reordered_prefix_refuses() {
    let workspace = Workspace::new();
    let directory = File::open(&workspace.0).unwrap();
    let gate = workspace.gate(&directory);
    for args in [
        ["--cgroup-fd=3", "--protocol=1", "--gate-fd=6", "--", "/bin/true"],
        ["--protocol=1", "--cgroup-fd=7", "--gate-fd=6", "--", "/bin/true"],
        ["--protocol=1", "--cgroup-fd=3", "--gate-fd=6", "--", "true"],
        ["--protocol=1", "--cgroup-fd=3", "--gate-fd=6", "--", "/bin/../bin/true"],
    ] {
        let mut session = Session::with_argv(&directory, &gate, &args, true);
        session.eof();
        let status = session.child.wait().unwrap();
        assert_eq!(status.code(), Some(2));
        assert_eq!(status.signal(), None);
    }
}

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{fs::{MetadataExt, OpenOptionsExt}, net::UnixStream, process::CommandExt},
    },
    path::{Path, PathBuf},
    process::{Child, Stdio},
    time::Duration,
};

struct Workspace(PathBuf);

impl Workspace {
    fn new() -> Self {
        let uuid = fs::read_to_string("/proc/sys/kernel/random/uuid").unwrap();
        let path = std::env::temp_dir().join(format!("kit-s2-{}", uuid.trim()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn gate(&self, directory: &File) -> File {
        let mut gate = OpenOptions::new().read(true).write(true).create_new(true)
            .mode(0o600).open(self.0.join("gate")).unwrap();
        let identity = directory.metadata().unwrap();
        gate.write_all(b"KLG1\x01\x00\x00\x00").unwrap();
        gate.write_all(&identity.dev().to_le_bytes()).unwrap();
        gate.write_all(&identity.ino().to_le_bytes()).unwrap();
        gate.sync_all().unwrap();
        gate
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn dup_high(fd: i32) -> OwnedFd {
    // SAFETY: Duplicate a live test FD above the reserved range. OwnedFd
    // controls the new reference until Command::spawn finishes.
    let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 32) };
    assert!(duplicate >= 32, "{}", io::Error::last_os_error());
    unsafe { OwnedFd::from_raw_fd(duplicate) }
}

fn spawn(command: &mut Command, descriptors: &[(i32, i32)]) -> Child {
    let copies: Vec<_> = descriptors.iter().map(|&(from, to)| (dup_high(from), to)).collect();
    // SAFETY: The post-fork callback only duplicates prearranged descriptors
    // with libc. Nothing in it uses locks or allocates on successful setup.
    unsafe {
        command.pre_exec(move || {
            for (file, dest) in &copies {
                if libc::dup2(file.as_raw_fd(), *dest) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    command.spawn().unwrap()
}

struct Session {
    child: Child,
    status: UnixStream,
    owner: Option<UnixStream>,
}

impl Session {
    fn start(directory: &File, gate: &File, args: &[&str], owner_alive: bool) -> Self {
        let mut argv = vec!["--protocol=1", "--cgroup-fd=3", "--gate-fd=6", "--"];
        argv.extend_from_slice(args);
        Self::with_argv(directory, gate, &argv, owner_alive)
    }

    fn with_argv(directory: &File, gate: &File, argv: &[&str], owner_alive: bool) -> Self {
        let (status, writer) = UnixStream::pair().unwrap();
        let (owner, watcher) = UnixStream::pair().unwrap();
        let owner = if owner_alive { Some(owner) } else { drop(owner); None };
        status.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
        let sentinel = File::open("/dev/null").unwrap();
        let mut command = launcher();
        command.args(argv).env_clear().stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        let child = spawn(&mut command, &[
            (directory.as_raw_fd(), 3), (writer.as_raw_fd(), 4), (watcher.as_raw_fd(), 5),
            (gate.as_raw_fd(), 6), (sentinel.as_raw_fd(), 19),
        ]);
        Self { child, status, owner }
    }

    fn record(&mut self) -> (u8, u32, i32) {
        let mut record = [0; 16];
        self.status.read_exact(&mut record).unwrap();
        assert_eq!(&record[..5], b"KLS1\x01");
        assert_eq!(&record[6..8], b"\0\0");
        (record[5], u32::from_le_bytes(record[8..12].try_into().unwrap()),
            i32::from_le_bytes(record[12..].try_into().unwrap()))
    }

    fn eof(&mut self) {
        assert_eq!(self.status.read(&mut [0]).unwrap(), 0);
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn ordinary_directory_refuses_before_executing() {
    let workspace = Workspace::new();
    let directory = File::open(&workspace.0).unwrap();
    let gate = workspace.gate(&directory);
    let mut session = Session::start(&directory, &gate, &["/bin/sh", "-c", "echo unexpected"], true);
    assert_eq!(session.record(), (3, 0, libc::EINVAL));
    session.eof();
    assert_eq!(session.child.wait().unwrap().code(), Some(2));
    assert_eq!(session.child.stdout.take().unwrap().bytes().count(), 0);
}

struct Cgroup(PathBuf);

impl Cgroup {
    fn new() -> Self {
        let parent = std::env::var_os("KIT_S2_REAL_CGROUP_PARENT")
            .map(PathBuf::from).expect("set KIT_S2_REAL_CGROUP_PARENT to an explicit delegated cgroup-v2 parent");
        assert!(parent.starts_with("/sys/fs/cgroup") && parent != Path::new("/sys/fs/cgroup"));
        assert_eq!(parent.canonicalize().unwrap(), parent);
        let uuid = fs::read_to_string("/proc/sys/kernel/random/uuid").unwrap();
        let path = parent.join(format!("kit-{}", uuid.trim()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn empty(&self) -> bool {
        fs::read_to_string(self.0.join("cgroup.events")).unwrap().lines().any(|line| line == "populated 0")
    }

    fn fresh_fence(&self, workspace: &Workspace) {
        let directory = File::open(&self.0).unwrap();
        let gate = OpenOptions::new().read(true).write(true).open(workspace.0.join("gate")).unwrap();
        let mut command = launcher();
        command.args(["--protocol=1", "--cgroup-fd=3", "--gate-fd=6", "--fence"]).env_clear();
        let mut child = spawn(&mut command, &[(directory.as_raw_fd(), 3), (gate.as_raw_fd(), 6)]);
        assert!(child.wait().unwrap().success());
    }
}

impl Drop for Cgroup {
    fn drop(&mut self) {
        let _ = fs::write(self.0.join("cgroup.kill"), b"1\n");
        for _ in 0..100 {
            if fs::remove_dir(&self.0).is_ok() { return; }
            std::thread::sleep(Duration::from_millis(10));
        }
        eprintln!("could not remove test cgroup {}", self.0.display());
    }
}

#[test]
#[ignore = "run explicitly with an approved delegated cgroup-v2 parent"]
fn real_placement_and_descriptor_closure() {
    for _ in 0..16 {
        let cgroup = Cgroup::new();
        let workspace = Workspace::new();
        let directory = File::open(&cgroup.0).unwrap();
        let gate = workspace.gate(&directory);
        let script = "IFS= read -r group </proc/self/cgroup; printf '%s\\n' \"$group\"; \
            for fd in 3 4 5 6 19; do test ! -e \"/proc/self/fd/$fd\" || exit 77; done";
        let mut session = Session::start(&directory, &gate, &["/bin/sh", "-c", script], true);
        let (event, pid, value) = session.record();
        assert_eq!((event, value), (1, 0));
        assert!(pid > 1);
        assert_eq!(session.record(), (2, pid, 0));
        session.eof();
        assert!(session.child.wait().unwrap().success());
        let mut membership = String::new();
        session.child.stdout.take().unwrap().read_to_string(&mut membership).unwrap();
        assert_eq!(membership.trim(), format!("0::{}", cgroup.0.strip_prefix("/sys/fs/cgroup").map(|p| Path::new("/").join(p)).unwrap().display()));
        assert!(cgroup.empty());
    }
}

#[test]
#[ignore = "run explicitly with an approved delegated cgroup-v2 parent"]
fn real_exec_failure_and_signal_are_distinct() {
    for (args, terminal, detail) in [
        (vec!["/nonexistent-kit-s2-executable"], 3, libc::ENOENT),
        (vec!["/bin/sh", "-c", "kill -TERM $$"], 4, libc::SIGTERM),
    ] {
        let cgroup = Cgroup::new();
        let workspace = Workspace::new();
        let directory = File::open(&cgroup.0).unwrap();
        let gate = workspace.gate(&directory);
        let mut session = Session::start(&directory, &gate, &args, true);
        let (event, pid, value) = session.record();
        assert_eq!((event, value), (1, 0));
        assert_eq!(session.record(), (terminal, pid, detail));
        session.eof();
        assert!(cgroup.empty());
    }
}

#[test]
#[ignore = "run explicitly with an approved delegated cgroup-v2 parent"]
fn real_owner_loss_and_revocation_prevent_late_launch() {
    let cgroup = Cgroup::new();
    let workspace = Workspace::new();
    let directory = File::open(&cgroup.0).unwrap();
    let gate = workspace.gate(&directory);
    let mut initial = Session::start(&directory, &gate, &["/bin/sh", "-c", "echo unexpected"], false);
    assert_eq!(initial.record(), (3, 0, libc::ECANCELED));
    initial.eof();
    assert_eq!(initial.child.stdout.take().unwrap().bytes().count(), 0);
    assert!(cgroup.empty());
    assert_eq!(fs::read(workspace.0.join("gate")).unwrap()[4], 3);

    let fresh = Cgroup::new();
    let fresh_workspace = Workspace::new();
    let fresh_directory = File::open(&fresh.0).unwrap();
    let fresh_gate = fresh_workspace.gate(&fresh_directory);
    fresh.fresh_fence(&fresh_workspace);
    assert!(fresh.empty());
    assert_eq!(fs::read(fresh_workspace.0.join("gate")).unwrap()[4], 3);
    let mut late = Session::start(&fresh_directory, &fresh_gate, &["/bin/sh", "-c", "echo unexpected"], true);
    assert_eq!(late.record(), (3, 0, libc::ECANCELED));
    late.eof();
    assert!(fresh.empty());
    assert_eq!(late.child.stdout.take().unwrap().bytes().count(), 0);
}

#[test]
#[ignore = "run explicitly with an approved delegated cgroup-v2 parent"]
fn real_owner_status_or_launcher_loss_kills_descendants() {
    for loss in ["owner", "status", "launcher"] {
        let cgroup = Cgroup::new();
        let workspace = Workspace::new();
        let directory = File::open(&cgroup.0).unwrap();
        let gate = workspace.gate(&directory);
        let mut session = Session::start(&directory, &gate, &[
            "/bin/sh", "-c", "/bin/sleep 60 & printf ready; wait",
        ], true);
        assert_eq!(session.record().0, 1);
        let mut stdout = session.child.stdout.take().unwrap();
        use std::os::fd::AsFd;
        let mut ready = [0; 5];
        let mut poll = libc::pollfd { fd: stdout.as_fd().as_raw_fd(), events: libc::POLLIN, revents: 0 };
        // SAFETY: poll receives a valid initialized descriptor and an 8s bound.
        assert_eq!(unsafe { libc::poll(&mut poll, 1, 8000) }, 1);
        stdout.read_exact(&mut ready).unwrap();
        assert_eq!(&ready, b"ready");
        assert!(!cgroup.empty());
        if loss == "launcher" {
            session.child.kill().unwrap();
            session.child.wait().unwrap();
            cgroup.fresh_fence(&workspace);
        } else if loss == "status" {
            session.status.shutdown(std::net::Shutdown::Both).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(8);
            while session.child.try_wait().unwrap().is_none() {
                assert!(std::time::Instant::now() < deadline, "status loss did not fence");
                std::thread::sleep(Duration::from_millis(10));
            }
        } else {
            drop(session.owner.take());
            session.eof();
            assert_eq!(session.child.wait().unwrap().code(), Some(2));
        }
        assert!(cgroup.empty());
    }
}

#[test]
#[ignore = "run explicitly with an approved delegated cgroup-v2 parent"]
fn real_substituted_cgroup_refuses_without_running() {
    let expected = Cgroup::new();
    let other = Cgroup::new();
    let workspace = Workspace::new();
    let gate = workspace.gate(&File::open(&expected.0).unwrap());
    let wrong = File::open(&other.0).unwrap();
    let mut session = Session::start(&wrong, &gate, &["/bin/sh", "-c", "echo unexpected"], true);
    assert_eq!(session.record(), (3, 0, libc::EINVAL));
    session.eof();
    assert_eq!(session.child.stdout.take().unwrap().bytes().count(), 0);
    assert!(expected.empty());
    assert!(other.empty());
    assert_eq!(fs::read(workspace.0.join("gate")).unwrap()[4], 1);
}
