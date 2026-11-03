// Signing in with Google from the app. Google refuses to sign anyone in inside an embedded web view (WebView2,
// WKWebView), so its page opens in the computer's own browser, and Clerk sends that browser back to a page this app
// serves on 127.0.0.1 for as long as it takes (a loopback redirect, as RFC 8252 has native apps do). The app hands the
// site the link it came back on as a `signin` event and comes to the front; the site finishes signing in
// (src/data/appSignIn.ts).
use std::sync::Mutex;
use std::time::Duration;

use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Long enough to pick an account and type a password; a sign-in left longer starts again.
const WAIT: Duration = Duration::from_secs(10 * 60);
const PATH: &str = "/sso-callback";
const PAGE: &str = "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>Krida</title>\
<body style=\"margin:0;display:grid;place-items:center;min-height:100vh;background:#151210;color:#fff;font:17px system-ui,sans-serif\">\
<p>Go back to Krida to finish signing in. You can close this tab.</p>";

/// The one sign-in waiting to come back; a new one replaces it.
static WAITING: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

/// Waits for the browser to come back and answers the link Clerk should send it to.
#[tauri::command]
pub async fn sign_in_listen(app: AppHandle) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let waiting = tauri::async_runtime::spawn(async move {
        let _ = tokio::time::timeout(WAIT, serve(&app, &listener, port)).await;
    });
    if let Some(earlier) = WAITING.lock().unwrap().replace(waiting) {
        earlier.abort();
    }
    Ok(format!("http://127.0.0.1:{port}{PATH}"))
}

/// Opens a sign-in page (Google's, through Clerk) in the computer's browser. Only https: the site can't use this to
/// open anything else on the computer.
#[tauri::command]
pub fn sign_in_open(app: AppHandle, url: String) -> Result<(), String> {
    let parsed: url::Url = url.parse().map_err(|_| "not a link")?;
    if parsed.scheme() != "https" {
        return Err("only https".into());
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| e.to_string())
}

/// Answers the browser until it comes back on the sign-in path (it may ask for a favicon first), then tells the site.
async fn serve(app: &AppHandle, listener: &TcpListener, port: u16) {
    while let Ok((mut stream, _)) = listener.accept().await {
        let Some(target) = request_target(&mut stream).await else { continue };
        if !target.starts_with(PATH) {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        }
        let head = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", PAGE.len());
        let _ = stream.write_all(head.as_bytes()).await;
        let _ = stream.write_all(PAGE.as_bytes()).await;
        let _ = stream.flush().await;
        let _ = app.emit("signin", format!("http://127.0.0.1:{port}{target}"));
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        return;
    }
}

/// The path and query of a GET, from its first line; None for anything else.
async fn request_target(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = vec![0u8; 8192];
    let mut read = 0;
    while !buffer[..read].windows(4).any(|w| w == b"\r\n\r\n") {
        if read == buffer.len() {
            return None;
        }
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer[read..])).await.ok()?.ok()?;
        if n == 0 {
            return None;
        }
        read += n;
    }
    let text = String::from_utf8_lossy(&buffer[..read]);
    let mut parts = text.lines().next()?.split(' ');
    (parts.next()? == "GET").then(|| parts.next().map(str::to_owned))?
}
