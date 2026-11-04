package app.krida

import android.net.Uri

/** Maps an install to a review screen; it never installs an addon on the person's behalf. */
internal fun stremioPage(link: Uri, origin: Uri): Uri? {
    if (link.scheme != "stremio" || link.userInfo != null) return null
    if (link.host.isNullOrEmpty()) {
        val parts = link.encodedPath.orEmpty().split('/')
        if (parts.size != 4 || parts[1] != "detail" || parts[2].isEmpty() || parts[3].isEmpty()) return null
        return origin.buildUpon().encodedPath("/title/${parts[2]}/${parts[3]}").clearQuery().fragment(null).build()
    }
    if (!link.encodedPath.orEmpty().endsWith("/manifest.json", ignoreCase = true)) return null
    val manifest = link.buildUpon().scheme("https").clearQuery().fragment(null).build()
    return origin.buildUpon().encodedPath("/settings/addons").clearQuery()
        .appendQueryParameter("addon", manifest.toString()).fragment(null).build()
}
