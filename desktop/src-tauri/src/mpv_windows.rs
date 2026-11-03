//! mpv on Windows: mpv.exe in a process of its own, drawing into a child window of ours (`--wid`), sunk under the
//! page, and spoken to over a named pipe.

use std::{
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Child, Command},
};
use tauri::{AppHandle, Manager};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, HWND},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
    UI::WindowsAndMessaging::{FindWindowExW, SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE},
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub type Stream = NamedPipeClient;

pub fn ipc_path(generation: u32) -> String {
    format!(r"\\.\pipe\krida-mpv-{}-{}", std::process::id(), generation)
}

pub async fn connect(path: &str) -> std::io::Result<Stream> {
    ClientOptions::new().open(path)
}

/// The app's window, which mpv draws into.
pub fn window(app: &AppHandle) -> Result<isize, String> {
    let window = app.get_webview_window("main").ok_or("the window is gone")?;
    Ok(window.hwnd().map_err(|e| e.to_string())?.0 as isize)
}

/// mpv makes its own window inside ours, on top of the page. It goes to the bottom, under the page.
pub fn sink(_app: &AppHandle, parent: isize) -> bool {
    let class: Vec<u16> = "mpv\0".encode_utf16().collect();
    unsafe {
        let child: HWND = FindWindowExW(parent as HWND, std::ptr::null_mut(), class.as_ptr(), std::ptr::null());
        if child.is_null() {
            return false;
        }
        SetWindowPos(child, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        true
    }
}

/// mpv's window is a child of ours, so it resizes with it.
pub fn follow(_app: &AppHandle) {}

/// A running mpv.exe.
pub struct Player {
    child: Child,
    _job: Job,
}

impl Player {
    /// Starts mpv.exe with `args` (mpv's own `--name=value` options), drawing into `window`.
    pub fn start(app: &AppHandle, window: isize, args: Vec<String>) -> Result<Player, String> {
        let child = Command::new(mpv_exe(app)?)
            .arg(format!("--wid={window}"))
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("couldn't start mpv: {e}"))?;
        let job = Job::kill_on_close(&child)?;
        Ok(Player { child, _job: job })
    }

    pub fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }
}

fn mpv_exe(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app.path().resource_dir().map_err(|e| e.to_string())?.join("mpv").join("mpv.exe");
    if bundled.exists() {
        return Ok(bundled);
    }
    let local = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("mpv").join("mpv.exe");
    if local.exists() {
        return Ok(local);
    }
    Err("mpv.exe is missing from the app".into())
}

/// Closing this ends mpv with it, so a crash of the app can't leave a player running.
struct Job(HANDLE);
unsafe impl Send for Job {}
impl Drop for Job {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

impl Job {
    fn kill_on_close(child: &Child) -> Result<Job, String> {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err("couldn't create a job for mpv".into());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
            Ok(Job(job))
        }
    }
}
