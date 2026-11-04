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
    if link.scheme() == "stremio" {
        if !link.username().is_empty() || link.password().is_some() { return None; }
        if link.host_str().is_none() {
            let parts: Vec<_> = link.path().split('/').collect();
            if parts.len() != 4 || parts[1] != "detail" || parts[2].is_empty() || parts[3].is_empty() { return None; }
            return home.join(&format!("/title/{}/{}", parts[2], parts[3])).ok();
        }
        if !link.path().to_lowercase().ends_with("/manifest.json") { return None; }
        let mut manifest = Url::parse(&link.as_str().replacen("stremio://", "https://", 1)).ok()?;
        manifest.set_query(None);
        manifest.set_fragment(None);
        let mut page = home.join("/settings/addons").ok()?;
        page.query_pairs_mut().append_pair("addon", manifest.as_str());
        return Some(page);
    }
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

    #[test]
    fn stremio_links_are_reviewed_or_open_a_title() {
        assert_eq!(at("stremio://torrentio.strem.fun/key/manifest.json").as_deref(), Some("https://krida-open.vercel.app/settings/addons?addon=https%3A%2F%2Ftorrentio.strem.fun%2Fkey%2Fmanifest.json"));
        assert_eq!(at("stremio:///detail/movie/tt1254207").as_deref(), Some("https://krida-open.vercel.app/title/movie/tt1254207"));
        assert_eq!(at("stremio://evil.example/elsewhere"), None);
    }
}
