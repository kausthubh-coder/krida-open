// Krida's own links, krida://<page> (from 0.1.11): the site's "Open in the desktop app" sends one, and the app opens
// that page of Krida, starting if it isn't open. Only pages of Krida: a link names a path, and the app puts that path
// on its own site. A Mac learns the scheme from the app's Info.plist (tauri.conf.json, plugins.deep-link); Windows from
// the installer and from register_all at each start.
use tauri::{AppHandle, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

const SCHEME: &str = "krida";

/// The page of Krida a krida:// link names, on `home`'s site; None for any other link.
pub fn page(link: &Url, home: &Url) -> Option<Url> {
    if link.scheme() != SCHEME {
        return None;
    }
    // krida://title/movie/tt1254207 reads "title" as the host and the rest as the path.
    let path = format!("/{}{}", link.host_str().unwrap_or_default(), link.path());
    let mut page = home.join(&path).ok()?;
    page.set_query(link.query());
    page.set_fragment(None);
    // A path that names another site (krida:////elsewhere.example) is refused.
    (page.origin() == home.origin()).then_some(page)
}

/// Listens for links from now on, and opens the one the app was started with. Called once the window is built.
pub fn start(app: &AppHandle, home: Url) {
    #[cfg(any(windows, target_os = "linux"))]
    let _ = app.deep_link().register_all();
    let handle = app.clone();
    let from = home.clone();
    app.deep_link().on_open_url(move |event| {
        if let Some(page) = event.urls().iter().find_map(|link| page(link, &from)) {
            open(&handle, page);
        }
    });
    if let Some(page) = app.deep_link().get_current().ok().flatten().and_then(|links| links.iter().find_map(|link| page(link, &home))) {
        open(app, page);
    }
}

/// Opens the page in the window and brings it forward.
fn open(app: &AppHandle, page: Url) {
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.navigate(page);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::page;
    use url::Url;

    fn at(link: &str) -> Option<String> {
        let home: Url = "https://krida-open.vercel.app/".parse().unwrap();
        page(&link.parse().unwrap(), &home).map(String::from)
    }

    #[test]
    fn opens_pages_of_krida_only() {
        assert_eq!(at("krida://title/movie/tt1254207").as_deref(), Some("https://krida-open.vercel.app/title/movie/tt1254207"));
        assert_eq!(at("krida://title/series/tt0903747?season=2").as_deref(), Some("https://krida-open.vercel.app/title/series/tt0903747?season=2"));
        assert_eq!(at("krida://").as_deref(), Some("https://krida-open.vercel.app/"));
        assert_eq!(at("krida:////elsewhere.example/x"), None);
        assert_eq!(at("https://elsewhere.example/title/movie/tt1"), None);
    }
}
