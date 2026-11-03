// Krida for Windows (and for a Mac, mpv_mac.rs): the live site in a window, with mpv playing the picture under it
// (mpv.rs). Everything else is the site itself, so the app has every feature the web has the moment it ships.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod links;
mod mpv;
mod signin;
mod update;

use std::path::PathBuf;

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const SITE: &str = "https://krida-open.vercel.app";

/// Runs first on every page. It tells the site it's in the app (and the start page where Krida is), and makes the
/// page's full screen the window's: the site's own full screen (the player's button, F) and F11, as in a browser,
/// take the whole app full screen from any page, and Esc leaves it. The window can also be full screen while the page
/// isn't: it opens that way when Settings says so (open_fullscreen), and stays that way through a reload, since a page
/// can only go full screen from a press. `isFullscreen` and `setFullscreen` (from 0.1.8) let the site show and leave
/// either, and `fullscreenchange` on window says when it changes.
const BRIDGE: &str = r#"
(() => {
  if (window.kridaDesktop) return;
  const win = () => window.__TAURI__?.window.getCurrentWindow();
  // The window's full screen, as last set or read, and whether the page's took it there: only then does the page
  // leaving its own (a trailer's, or an exit arriving late) leave the window's too.
  let full = false;
  let byPage = false;
  const changed = () => window.dispatchEvent(new Event("kridafullscreenchange"));
  const set = (on) => {
    byPage = false;
    if (on !== full) {
      full = on;
      desktop.fullscreen(on);
    }
    if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    changed();
  };
  const desktop = (window.kridaDesktop = {
    version: "__VERSION__",
    // windows or macos: the site names the app after it.
    platform: "__PLATFORM__",
    // What's new in this version (scripts/release.ts), shown once after an update.
    notes: __NOTES__,
    home: __HOME__,
    // Google sign-in goes through the computer's browser and comes back to the app (signin.rs).
    signIn: true,
    // The window's full screen. Tests replace this, so checking full screen never takes over the screen.
    fullscreen: (on) => win()?.setFullscreen(on).catch(() => {}),
    isFullscreen: () => full || !!document.fullscreenElement,
    setFullscreen: set,
  });
  // What the window is in now, and again whenever the system changes it (a Mac's green button).
  const read = () =>
    win()?.isFullscreen().then((on) => {
      if (on === full) return;
      full = on;
      changed();
    }, () => {});
  read();
  win()?.onResized(read).catch(() => {});
  document.addEventListener("fullscreenchange", () => {
    const on = !!document.fullscreenElement;
    if (on && !full) {
      set(true);
      byPage = true;
    } else if (!on && byPage) set(false);
    else changed();
  });
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.key === "F11") {
      e.preventDefault();
      if (desktop.isFullscreen()) set(false);
      else document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    } else if (e.key === "Escape" && desktop.isFullscreen() && !e.defaultPrevented) {
      // A browser leaves full screen on Esc by itself; WebView2 leaves it to the app. Esc the page used (a menu
      // closing) stays the page's.
      set(false);
    }
  });
})();
"#;

/// Settings' Open in full screen. The app keeps it, not the site, so the window opens full screen before any page
/// loads. A run with its own data folder (a test) keeps its own, so the owner's choice never takes over the screen.
fn open_fullscreen_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = match std::env::var("KRIDA_DATA_DIR") {
        Ok(dir) => PathBuf::from(dir),
        Err(_) => app.path().app_config_dir().ok()?,
    };
    Some(dir.join("open-fullscreen"))
}

#[tauri::command]
fn open_fullscreen(app: AppHandle) -> bool {
    open_fullscreen_file(&app).is_some_and(|file| file.exists())
}

#[tauri::command]
fn set_open_fullscreen(app: AppHandle, on: bool) -> Result<(), String> {
    let file = open_fullscreen_file(&app).ok_or("no folder for settings")?;
    let done = if on {
        file.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::write(&file, ""))
    } else {
        std::fs::remove_file(&file).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) })
    };
    done.map_err(|e| e.to_string())
}

/// Pages that open inside the app: the start page, Krida itself, and Simkl's sign-in, which comes back to Krida.
fn stays_inside(url: &Url, home: &Url) -> bool {
    if url.origin() == home.origin() || url.scheme() == "tauri" || url.scheme() == "about" {
        return true;
    }
    let host = url.host_str().unwrap_or_default();
    host == "tauri.localhost" || host == "krida-open.vercel.app" || host == "simkl.com" || host.ends_with(".simkl.com")
}

fn main() {
    // KRIDA_URL points the app at another Krida (a QA app on this machine); KRIDA_DATA_DIR keeps its sign-ins apart.
    let home: Url = std::env::var("KRIDA_URL").ok().and_then(|u| u.parse().ok()).unwrap_or_else(|| SITE.parse().unwrap());
    let data_dir = std::env::var("KRIDA_DATA_DIR").ok();
    // Tests place the window off-screen (KRIDA_WINDOW_POS) and can give it a screen's shape (KRIDA_WINDOW_SIZE).
    let pair = |name: &str| {
        let value = std::env::var(name).ok()?;
        let (a, b) = value.split_once(',')?;
        Some((a.trim().parse::<f64>().ok()?, b.trim().parse::<f64>().ok()?))
    };
    let position = pair("KRIDA_WINDOW_POS");
    let (width, height) = pair("KRIDA_WINDOW_SIZE").unwrap_or((1280.0, 800.0));

    let mut builder = tauri::Builder::default();
    // Opening Krida again brings back the open window. A run with its own data folder (a test) stays apart: it neither
    // hands over to nor disturbs the Krida someone is using.
    if data_dir.is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(mpv::Mpv::default())
        .manage(update::Updates::default())
        .invoke_handler(tauri::generate_handler![
            mpv::mpv_load,
            mpv::mpv_warm,
            mpv::mpv_seek,
            mpv::mpv_set,
            mpv::mpv_stop,
            mpv::mpv_frame_light,
            update::update_status,
            update::update_check,
            update::update_restart,
            signin::sign_in_listen,
            signin::sign_in_open,
            open_fullscreen,
            set_open_fullscreen
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                mpv::window_changed(window.app_handle());
            }
        })
        .setup(move |app| {
            let nav_home = home.clone();
            let nav_app = app.handle().clone();
            let popup_app = app.handle().clone();
            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Krida")
                .inner_size(width, height)
                .min_inner_size(720.0, 480.0)
                .theme(Some(tauri::Theme::Dark))
                // See-through, so mpv's picture shows wherever the page is transparent.
                .transparent(true)
                .visible(false)
                .initialization_script(
                    BRIDGE
                        .replace("__VERSION__", env!("CARGO_PKG_VERSION"))
                        .replace("__PLATFORM__", std::env::consts::OS)
                        .replace("__NOTES__", &serde_json::to_string(option_env!("KRIDA_RELEASE_NOTES").unwrap_or("")).unwrap())
                        .replace("__HOME__", &serde_json::to_string(home.as_str()).unwrap()),
                )
                .on_navigation(move |url| {
                    if stays_inside(url, &nav_home) {
                        return true;
                    }
                    let _ = nav_app.opener().open_url(url.as_str(), None::<&str>);
                    false
                })
                .on_new_window(move |url, _features| {
                    let _ = popup_app.opener().open_url(url.as_str(), None::<&str>);
                    tauri::webview::NewWindowResponse::Deny
                })
                .on_page_load(|webview, _payload| {
                    let _ = webview.show();
                });
            if let Some(dir) = &data_dir {
                window = window.data_directory(dir.into());
            }
            if let Some((x, y)) = position {
                window = window.position(x, y).focused(false);
            } else {
                window = window.center().fullscreen(open_fullscreen(app.handle().clone()));
            }
            #[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
            let window = window.build()?;
            // WKWebView paints white under a see-through page unless its own background is cleared too.
            #[cfg(target_os = "macos")]
            window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)))?;
            update::start(app.handle());
            links::start(app.handle(), home.clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Krida");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            app.state::<mpv::Mpv>().kill();
            app.state::<update::Updates>().install_on_exit();
        }
    });
}
