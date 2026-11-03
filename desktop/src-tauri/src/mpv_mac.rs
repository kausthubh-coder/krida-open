//! mpv on a Mac: libmpv inside the app (the copy a release bundles, desktop/scripts/bundle-mac.mjs; else Homebrew's,
//! `brew install mpv`, or KRIDA_LIBMPV), in a window of its own held
//! under the app's (`sink`). It takes the same options as mpv.exe on Windows and is spoken to the same way, over JSON
//! IPC on a Unix socket.

use std::{
    ffi::{c_char, c_int, c_void, CString},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use objc2::{rc::Retained, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSWindow, NSWindowCollectionBehavior, NSWindowOrderingMode};
use tauri::{AppHandle, Manager};
use tokio::net::UnixStream;

pub type Stream = UnixStream;

pub fn ipc_path(generation: u32) -> String {
    std::env::temp_dir().join(format!("krida-mpv-{}-{}.sock", std::process::id(), generation)).to_string_lossy().into()
}

pub async fn connect(path: &str) -> std::io::Result<Stream> {
    UnixStream::connect(path).await
}

/// The app's window, which mpv's goes under.
pub fn window(app: &AppHandle) -> Result<isize, String> {
    let window = app.get_webview_window("main").ok_or("the window is gone")?;
    Ok(window.ns_window().map_err(|e| e.to_string())? as isize)
}

/// What mpv's window needs to sit under the page: no title bar, never taking focus or clicks, and keeping the size it's
/// given rather than the film's.
const WINDOW: &[&str] = &[
    // How `mpv_window` knows it.
    "--title=krida-mpv",
    "--border=no",
    "--focus-on=never",
    "--auto-window-resize=no",
    "--keepaspect-window=no",
    "--window-dragging=no",
    "--native-fs=no",
    "--macos-menu-shortcuts=no",
];

/// libmpv on a Mac takes no --wid: mpv opens a window of its own. It becomes a child of the app's window, ordered under
/// it and the size of its page, so it moves with it and shows wherever the page is see-through. False until mpv's
/// window is there.
pub fn sink(app: &AppHandle, parent: isize) -> bool {
    on_main(app, move || {
        let mtm = MainThreadMarker::new().expect("on the main thread");
        let parent = unsafe { &*(parent as *const NSWindow) };
        let Some(mpv) = mpv_window(mtm) else { return false };
        if mpv.parentWindow().is_none() {
            mpv.setIgnoresMouseEvents(true);
            mpv.setExcludedFromWindowsMenu(true);
            mpv.setCollectionBehavior(mpv.collectionBehavior() | NSWindowCollectionBehavior::FullScreenAuxiliary);
            unsafe { parent.addChildWindow_ordered(&mpv, NSWindowOrderingMode::Below) };
            // A see-through window lets clicks fall through to what's behind; the page keeps them.
            parent.setIgnoresMouseEvents(false);
        }
        fit(parent, &mpv);
        true
    })
    .unwrap_or(false)
}

/// Keeps mpv's window over the page as the app's window resizes or goes full screen (a child window only moves along).
pub fn follow(app: &AppHandle) {
    let Ok(parent) = window(app) else { return };
    on_main(app, move || {
        let mtm = MainThreadMarker::new().expect("on the main thread");
        if let Some(mpv) = mpv_window(mtm) {
            fit(unsafe { &*(parent as *const NSWindow) }, &mpv);
        }
    });
}

fn fit(parent: &NSWindow, mpv: &NSWindow) {
    mpv.setFrame_display(parent.contentRectForFrameRect(parent.frame()), true);
}

/// mpv's window, by the title it was given (the title bar that would show it is off).
fn mpv_window(mtm: MainThreadMarker) -> Option<Retained<NSWindow>> {
    NSApplication::sharedApplication(mtm).windows().iter().find(|w| w.title().to_string() == "krida-mpv")
}

/// Runs `f` on the main thread, where AppKit wants it, and waits for it. Tauri runs commands that aren't async there.
fn on_main<T: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    if MainThreadMarker::new().is_some() {
        return Some(f());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .ok()?;
    rx.recv().ok()
}

/// libmpv's calls (mpv's client.h), loaded as the first title plays.
struct Lib {
    create: unsafe extern "C" fn() -> *mut c_void,
    set_option_string: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int,
    initialize: unsafe extern "C" fn(*mut c_void) -> c_int,
    wait_event: unsafe extern "C" fn(*mut c_void, f64) -> *const Event,
    command_async: unsafe extern "C" fn(*mut c_void, u64, *const *const c_char) -> c_int,
    terminate_destroy: unsafe extern "C" fn(*mut c_void),
    _lib: libloading::Library,
}

/// mpv_event's start: its id is all this reads.
#[repr(C)]
struct Event {
    event_id: c_int,
}
const MPV_EVENT_SHUTDOWN: c_int = 1;

fn lib() -> Result<&'static Lib, String> {
    static LIB: OnceLock<Result<Lib, String>> = OnceLock::new();
    LIB.get_or_init(|| {
        // A release carries libmpv in Contents/Frameworks, with MoltenVK, the Vulkan driver its picture is drawn
        // through, which the Vulkan loader finds by the file named here.
        let frameworks = std::env::current_exe().ok().and_then(|exe| Some(exe.parent()?.parent()?.join("Frameworks")));
        let bundled = frameworks.as_ref().map(|dir| dir.join("libmpv.2.dylib")).filter(|lib| lib.exists());
        if let (Some(dir), Some(_)) = (&frameworks, &bundled) {
            let icd = dir.join("vulkan/MoltenVK_icd.json");
            std::env::set_var("VK_DRIVER_FILES", &icd);
            std::env::set_var("VK_ICD_FILENAMES", &icd);
        }
        // A release only ever plays through its own copy: one it can't load says why, rather than quietly using
        // whatever else is on the Mac.
        let lib = match (std::env::var("KRIDA_LIBMPV").ok(), bundled) {
            (Some(path), _) => unsafe { libloading::Library::new(path) }.map_err(|e| e.to_string())?,
            (None, Some(path)) => unsafe { libloading::Library::new(path) }.map_err(|e| format!("Krida's own mpv didn't load: {e}"))?,
            (None, None) => ["/opt/homebrew/lib/libmpv.2.dylib", "/usr/local/lib/libmpv.2.dylib"]
                .into_iter()
                .filter(|p| std::path::Path::new(p).exists())
                .find_map(|p| unsafe { libloading::Library::new(p) }.ok())
                .ok_or("mpv isn't installed: brew install mpv")?,
        };
        unsafe {
            macro_rules! get {
                ($name:literal) => {
                    *lib.get($name).map_err(|e| e.to_string())?
                };
            }
            Ok(Lib {
                create: get!(b"mpv_create\0"),
                set_option_string: get!(b"mpv_set_option_string\0"),
                initialize: get!(b"mpv_initialize\0"),
                wait_event: get!(b"mpv_wait_event\0"),
                command_async: get!(b"mpv_command_async\0"),
                terminate_destroy: get!(b"mpv_terminate_destroy\0"),
                _lib: lib,
            })
        }
    })
    .as_ref()
    .map_err(Clone::clone)
}

/// One mpv core. Its thread owns the handle: it starts mpv, waits out its events, and destroys it once mpv has shut
/// down. `done` is set under `gate`, which `kill` holds while it asks mpv to quit, so nothing goes to a handle that's
/// gone. Neither waits on mpv, which may be waiting on the main thread to draw.
struct Core {
    handle: *mut c_void,
    done: AtomicBool,
    gate: Mutex<()>,
}
unsafe impl Send for Core {}
unsafe impl Sync for Core {}

pub struct Player(Arc<Core>);

impl Player {
    /// Starts libmpv with `args` (mpv's own `--name=value` options). `sink` puts its window under `_window`.
    pub fn start(_app: &AppHandle, _window: isize, args: Vec<String>) -> Result<Player, String> {
        let lib = lib()?;
        let handle = unsafe { (lib.create)() };
        if handle.is_null() {
            return Err("couldn't start mpv".into());
        }
        let core = Arc::new(Core { handle, done: AtomicBool::new(false), gate: Mutex::new(()) });
        let options: Vec<(String, String)> = WINDOW
            .iter()
            .map(|o| o.to_string())
            .chain(args)
            .filter_map(|arg| {
                let arg = arg.strip_prefix("--")?;
                let (name, value) = arg.split_once('=').unwrap_or((arg, "yes"));
                Some((name.to_string(), value.to_string()))
            })
            .collect();
        let thread_core = core.clone();
        std::thread::Builder::new()
            .name("mpv".into())
            .spawn(move || run(lib, &thread_core, options))
            .map_err(|e| e.to_string())?;
        Ok(Player(core))
    }

    pub fn running(&mut self) -> bool {
        !self.0.done.load(Ordering::Acquire)
    }

    pub fn kill(&mut self) {
        let _gate = self.0.gate.lock().unwrap();
        if !self.0.done.load(Ordering::Acquire) {
            let quit = CString::new("quit").unwrap();
            let command = [quit.as_ptr(), std::ptr::null()];
            unsafe { (lib().unwrap().command_async)(self.0.handle, 0, command.as_ptr()) };
        }
    }
}

/// Off the main thread, which mpv's drawing calls back to: sets the options, starts mpv, and waits for it to end.
fn run(lib: &Lib, core: &Core, options: Vec<(String, String)>) {
    let started = options.iter().all(|(name, value)| {
        let (n, v) = (CString::new(name.as_str()).unwrap(), CString::new(value.as_str()).unwrap());
        let set = unsafe { (lib.set_option_string)(core.handle, n.as_ptr(), v.as_ptr()) } >= 0;
        if !set {
            eprintln!("mpv refused --{name}={value}");
        }
        set
    }) && unsafe { (lib.initialize)(core.handle) } >= 0;
    while started {
        let event = unsafe { &*(lib.wait_event)(core.handle, -1.0) };
        if event.event_id == MPV_EVENT_SHUTDOWN {
            break;
        }
    }
    {
        let _gate = core.gate.lock().unwrap();
        core.done.store(true, Ordering::Release);
    }
    unsafe { (lib.terminate_destroy)(core.handle) };
}
