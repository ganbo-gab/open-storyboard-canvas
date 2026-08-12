use std::io;
use std::process::ExitStatus;
#[cfg(test)]
use std::process::Stdio;
use std::time::Duration;

use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

const TERMINATION_GRACE: Duration = Duration::from_millis(750);
const TERMINATION_POLL: Duration = Duration::from_millis(20);

pub(super) struct ProcessTree {
    child: Child,
    #[cfg(unix)]
    process_group_id: i32,
    #[cfg(windows)]
    job: windows::JobObject,
}

impl ProcessTree {
    #[cfg(test)]
    pub(super) fn id(&self) -> Option<u32> {
        self.child.id()
    }

    pub(super) fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }

    pub(super) fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    pub(super) fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    pub(super) async fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait().await
    }

    pub(super) async fn terminate_and_wait(&mut self) -> io::Result<ExitStatus> {
        #[cfg(unix)]
        {
            return self.terminate_unix_and_wait().await;
        }
        #[cfg(windows)]
        {
            return self.terminate_windows_and_wait().await;
        }
        #[cfg(not(any(unix, windows)))]
        {
            self.child.kill().await?;
            self.child.wait().await
        }
    }

    #[cfg(unix)]
    async fn terminate_unix_and_wait(&mut self) -> io::Result<ExitStatus> {
        let mut first_error = signal_process_group(self.process_group_id, libc::SIGTERM).err();
        let deadline = tokio::time::Instant::now() + TERMINATION_GRACE;
        let mut child_status = None;

        loop {
            if child_status.is_none() {
                match self.child.try_wait() {
                    Ok(status) => child_status = status,
                    Err(error) => {
                        first_error.get_or_insert(error);
                        break;
                    }
                }
            }
            match process_group_exists(self.process_group_id) {
                Ok(false) => break,
                Ok(true) => {}
                Err(error) => {
                    first_error.get_or_insert(error);
                    break;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                if let Err(error) = signal_process_group(self.process_group_id, libc::SIGKILL) {
                    first_error.get_or_insert(error);
                    let _ = self.child.start_kill();
                }
                break;
            }
            tokio::time::sleep(TERMINATION_POLL).await;
        }

        let status = match child_status {
            Some(status) => Ok(status),
            None => self.child.wait().await,
        };
        match (first_error, status) {
            (Some(error), _) => Err(error),
            (None, status) => status,
        }
    }

    #[cfg(windows)]
    async fn terminate_windows_and_wait(&mut self) -> io::Result<ExitStatus> {
        let termination = self.job.terminate();
        let status = self.child.wait().await;
        match (termination, status) {
            (Err(error), _) => Err(error),
            (Ok(()), status) => status,
        }
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            let _ = signal_process_group(self.process_group_id, libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            let _ = self.job.terminate();
        }
        let _ = self.child.start_kill();
    }
}

pub(super) fn configure_process_tree(command: &mut Command) {
    command.kill_on_drop(true);
    #[cfg(unix)]
    {
        command.process_group(0);
    }
}

pub(super) fn spawn_process_tree(command: &mut Command) -> io::Result<ProcessTree> {
    configure_process_tree(command);
    #[cfg(windows)]
    {
        return windows::spawn(command);
    }
    #[cfg(not(windows))]
    {
        let child = command.spawn()?;
        #[cfg(unix)]
        {
            let process_group_id = child
                .id()
                .and_then(|id| i32::try_from(id).ok())
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::Other,
                        "spawned process has no valid process id",
                    )
                })?;
            return Ok(ProcessTree {
                child,
                process_group_id,
            });
        }
        #[cfg(not(unix))]
        {
            Ok(ProcessTree { child })
        }
    }
}

#[cfg(unix)]
fn signal_process_group(process_group_id: i32, signal: i32) -> io::Result<()> {
    let result = unsafe { libc::kill(-process_group_id, signal) };
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(unix)]
fn process_group_exists(process_group_id: i32) -> io::Result<bool> {
    let result = unsafe { libc::kill(-process_group_id, 0) };
    if result == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(error),
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr;

    use tokio::process::Command;
    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenThread, ResumeThread, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
    };

    use super::ProcessTree;

    pub(super) struct JobObject(OwnedHandle);

    impl JobObject {
        fn new() -> io::Result<Self> {
            let raw = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            let handle = owned_handle(raw)?;
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    handle.as_raw_handle() as HANDLE,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(handle))
        }

        fn assign(&self, child: &tokio::process::Child) -> io::Result<()> {
            let child_handle = child.raw_handle().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::Other,
                    "spawned process handle is unavailable",
                )
            })?;
            let assigned = unsafe {
                AssignProcessToJobObject(self.0.as_raw_handle() as HANDLE, child_handle as HANDLE)
            };
            if assigned == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }

        pub(super) fn terminate(&self) -> io::Result<()> {
            let terminated = unsafe { TerminateJobObject(self.0.as_raw_handle() as HANDLE, 1) };
            if terminated == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
    }

    pub(super) fn spawn(command: &mut Command) -> io::Result<ProcessTree> {
        let job = JobObject::new()?;
        command.creation_flags(CREATE_SUSPENDED);
        let mut child = command.spawn()?;
        let setup = job
            .assign(&child)
            .and_then(|()| resume_initial_thread(&child));
        if let Err(error) = setup {
            let _ = job.terminate();
            let _ = child.start_kill();
            return Err(error);
        }
        Ok(ProcessTree { child, job })
    }

    fn resume_initial_thread(child: &tokio::process::Child) -> io::Result<()> {
        let process_id = child.id().ok_or_else(|| {
            io::Error::new(io::ErrorKind::Other, "spawned process id is unavailable")
        })?;
        let snapshot_raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot_raw == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot_raw as _) };
        let mut entry: THREADENTRY32 = unsafe { zeroed() };
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut has_entry =
            unsafe { Thread32First(snapshot.as_raw_handle() as HANDLE, &mut entry) } != 0;
        while has_entry {
            if entry.th32OwnerProcessID == process_id {
                let thread_raw =
                    unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                let thread = owned_handle(thread_raw)?;
                let previous_count = unsafe { ResumeThread(thread.as_raw_handle() as HANDLE) };
                if previous_count == u32::MAX {
                    return Err(io::Error::last_os_error());
                }
                return Ok(());
            }
            has_entry =
                unsafe { Thread32Next(snapshot.as_raw_handle() as HANDLE, &mut entry) } != 0;
        }
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            "spawned process primary thread is unavailable",
        ))
    }

    fn owned_handle(raw: HANDLE) -> io::Result<OwnedHandle> {
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { OwnedHandle::from_raw_handle(raw as _) })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    const FIXTURE_ENV: &str = "STORYBOARD_PROCESS_TREE_FIXTURE_PID_FILE";

    #[cfg(unix)]
    #[test]
    fn process_tree_fixture() {
        let Some(pid_file) = std::env::var_os(FIXTURE_ENV) else {
            return;
        };
        let mut descendant = std::process::Command::new("/bin/sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        std::fs::write(pid_file, descendant.id().to_string()).unwrap();
        let _ = descendant.wait();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_termination_kills_the_complete_process_group() {
        let temp = tempfile::tempdir().unwrap();
        let pid_file = temp.path().join("descendant.pid");
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "commands::external_agent::process_tree::tests::process_tree_fixture",
                "--nocapture",
            ])
            .env(FIXTURE_ENV, &pid_file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut tree = spawn_process_tree(&mut command).unwrap();
        let leader = i32::try_from(tree.id().unwrap()).unwrap();
        assert_eq!(unsafe { libc::getpgid(leader) }, leader);

        let descendant = wait_for_fixture_pid(&pid_file).await;
        assert!(process_exists(descendant));
        tree.terminate_and_wait().await.unwrap();
        wait_for_process_exit(descendant).await;
        assert!(!process_exists(descendant));
    }

    #[cfg(unix)]
    async fn wait_for_fixture_pid(path: &std::path::Path) -> i32 {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(value) = std::fs::read_to_string(path) {
                if let Ok(pid) = value.parse() {
                    return pid;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "process-tree fixture did not report a descendant pid"
            );
            tokio::time::sleep(TERMINATION_POLL).await;
        }
    }

    #[cfg(unix)]
    async fn wait_for_process_exit(pid: i32) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while process_exists(pid) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(TERMINATION_POLL).await;
        }
    }

    #[cfg(unix)]
    fn process_exists(pid: i32) -> bool {
        let result = unsafe { libc::kill(pid, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}
