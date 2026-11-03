// Krida for Windows and for Mac keep themselves up to date. It looks for a newer version as it opens and every 6 hours after, in the
// public krida-open-releases repo, downloads it in
// the background, and installs it when that can't stop a film: at once if it turned up as the app opened, before
// anything played; otherwise when the site's Restart asks, or as the app closes. The site's Check for updates looks at
// once (from 0.1.7). Windows gets the installer, a Mac a new Krida.app. Each is signed with the key in ~/.krida-open, and
// the app refuses one that isn't.
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// Where updates stand, as the site shows it: `state` is idle, checking, current, downloading, ready or failed.
#[derive(Clone, serde::Serialize)]
pub struct Status {
    state: &'static str,
    /// The version found, while downloading and once ready.
    version: Option<String>,
}

#[derive(Default)]
pub struct Updates(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    checking: bool,
    status: Option<Status>,
    ready: Option<(Update, Vec<u8>)>,
}

/// Updates run in an installed app. A debug build (tests, development) only looks where KRIDA_UPDATE_URL says, and a
/// run with its own data folder (a test) never installs, since the installer would replace the Krida in use.
pub fn enabled() -> bool {
    !cfg!(debug_assertions) || std::env::var("KRIDA_UPDATE_URL").is_ok()
}

/// The new version is in place. Windows' installer has closed the app and opens it again itself; a Mac's new Krida.app
/// needs opening.
fn reopen(app: &AppHandle) {
    if !cfg!(windows) {
        app.restart();
    }
}

fn may_install() -> bool {
    std::env::var("KRIDA_DATA_DIR").is_err()
}

/// Looks now and every 6 hours after, while the app is open.
pub fn start(app: &AppHandle) {
    if !enabled() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut first = true;
        loop {
            look(&app, first).await;
            first = false;
            tokio::time::sleep(EVERY).await;
        }
    });
}

async fn look(app: &AppHandle, opening: bool) {
    let updates = app.state::<Updates>();
    {
        let mut inner = updates.0.lock().unwrap();
        // A version already waiting stays the one to install.
        if inner.checking || inner.ready.is_some() {
            return;
        }
        inner.checking = true;
    }
    set(app, "checking", None);
    let found = find(app).await;
    let (state, version) = match found {
        Ok(None) => ("current", None),
        Err(_) => ("failed", None),
        Ok(Some(update)) => {
            let version = update.version.clone();
            set(app, "downloading", Some(version.clone()));
            match update.download(|_, _| {}, || {}).await {
                Ok(bytes) => {
                    // Found as the app opened and nothing has played yet: nothing to interrupt, so it updates now.
                    if opening && !crate::mpv::started() && may_install() && update.install(&bytes).is_ok() {
                        reopen(app);
                    }
                    updates.0.lock().unwrap().ready = Some((update, bytes));
                    ("ready", Some(version))
                }
                Err(_) => ("failed", None),
            }
        }
    };
    updates.0.lock().unwrap().checking = false;
    set(app, state, version);
}

async fn find(app: &AppHandle) -> Result<Option<Update>, String> {
    let mut builder = app.updater_builder().timeout(Duration::from_secs(60));
    if let Ok(url) = std::env::var("KRIDA_UPDATE_URL") {
        builder = builder.endpoints(vec![url.parse().map_err(|_| "KRIDA_UPDATE_URL isn't a link")?]).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

fn set(app: &AppHandle, state: &'static str, version: Option<String>) {
    let status = Status { state, version };
    app.state::<Updates>().0.lock().unwrap().status = Some(status.clone());
    let _ = app.emit("update", status);
}

impl Updates {
    /// Installs a waiting version as the app closes, without opening it again.
    pub fn install_on_exit(&self) {
        if !may_install() {
            return;
        }
        if let Some((update, bytes)) = self.0.lock().unwrap().ready.take() {
            let _ = update.restart_after_install(false).install(&bytes);
        }
    }
}

/// Where updates stand, for the site's Settings and its Restart notice.
#[tauri::command]
pub fn update_status(updates: State<Updates>) -> Status {
    let inner = updates.0.lock().unwrap();
    let idle = Status { state: if enabled() { "idle" } else { "off" }, version: None };
    inner.status.clone().unwrap_or(idle)
}

/// Looks now, when the site's Check for updates asks. Where it gets to arrives as `update` events; a version found
/// waits for Restart, as one found mid-session does.
#[tauri::command]
pub fn update_check(app: AppHandle) {
    if !enabled() {
        return;
    }
    tauri::async_runtime::spawn(async move { look(&app, false).await });
}

/// Installs the waiting version and opens Krida again on it. The app closes, mpv with it.
#[tauri::command]
pub fn update_restart(app: AppHandle, updates: State<Updates>) -> Result<(), String> {
    if !may_install() {
        return Err("a test run doesn't install".into());
    }
    let (update, bytes) = updates.0.lock().unwrap().ready.take().ok_or("no update is waiting")?;
    app.state::<crate::mpv::Mpv>().kill();
    // The app closes as it installs (Windows) or opens again on the new version (a Mac), so this returns only when
    // installing failed, and the update waits for the next try.
    let failed = update.install(&bytes).map_err(|e| e.to_string());
    if failed.is_ok() {
        reopen(&app);
    }
    updates.0.lock().unwrap().ready = Some((update, bytes));
    failed
}
