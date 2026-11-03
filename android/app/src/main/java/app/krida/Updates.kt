package app.krida

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Krida for Android keeps itself up to date. As it comes to the front, at most every 6 hours, it reads android.json
 * from the public krida-open-releases repo (scripts/release.ts writes it); a newer version's APK downloads in the background
 * and is checked against the checksum there. Then the page offers "Install update" (src/ui/android.ts): Android asks
 * once to allow installs from Krida, then shows its own confirm. It can't install without asking, and only takes an
 * APK signed with the same key as the one installed.
 */
class Updates(private val app: MainActivity) {
    private val worker = Executors.newSingleThreadExecutor()
    private val folder = File(app.cacheDir, "updates")
    private var lastLook = 0L
    /** The version waiting to install, once downloaded. */
    private var ready: File? = null
    /** Installing waits on the "allow installs from Krida" setting the person was sent to. */
    private var installOnReturn = false

    /** Where updates stand, as the page reads it: state (idle, checking, current, downloading, ready, failed), version, notes. */
    @Volatile
    var status: JSONObject = JSONObject().put("state", "idle")
        private set

    /** Called as the app comes to the front. */
    fun onStart() {
        if (installOnReturn) {
            installOnReturn = false
            if (canInstall()) install()
        }
        val now = System.currentTimeMillis()
        if (now - lastLook < EVERY_MS || status.optString("state") in setOf("checking", "downloading", "ready")) return
        lastLook = now
        worker.execute { look() }
    }

    private fun look() {
        set("checking")
        try {
            val manifest = JSONObject(fetch(BuildConfig.UPDATE_URL).toString(Charsets.UTF_8))
            val code = manifest.getInt("versionCode")
            val name = manifest.getString("versionName")
            val notes = manifest.optString("notes")
            if (code <= BuildConfig.VERSION_CODE) return set("current")
            set("downloading", name, notes)
            val apk = File(folder, "Krida-$name.apk")
            if (!apk.exists() || sha256(apk.readBytes()) != manifest.getString("sha256")) {
                folder.deleteRecursively()
                folder.mkdirs()
                val bytes = fetch(manifest.getString("url"))
                if (sha256(bytes) != manifest.getString("sha256")) return set("failed")
                apk.writeBytes(bytes)
            }
            ready = apk
            set("ready", name, notes)
        } catch (_: Exception) {
            set("failed")
        }
    }

    /** Opens Android's install screen for the waiting version, first sending the person to allow installs from Krida. */
    fun install() {
        val apk = ready ?: return
        if (!canInstall()) {
            installOnReturn = true
            app.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${app.packageName}")))
            return
        }
        val uri = FileProvider.getUriForFile(app, "${app.packageName}.updates", apk)
        app.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    private fun canInstall() = Build.VERSION.SDK_INT < Build.VERSION_CODES.O || app.packageManager.canRequestPackageInstalls()

    private fun set(state: String, version: String? = null, notes: String? = null) {
        status = JSONObject().put("state", state).put("version", version ?: JSONObject.NULL).put("notes", notes ?: JSONObject.NULL)
        app.runOnUiThread { app.emitUpdate(status) }
    }

    private fun fetch(url: String): ByteArray {
        var link = URL(url)
        // GitHub sends a release's files on from github.com to its own storage: follow up to 5 hops.
        repeat(5) {
            val connection = link.openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15_000
            connection.readTimeout = 60_000
            when (connection.responseCode) {
                in 300..399 -> link = URL(link, connection.getHeaderField("Location"))
                200 -> return connection.inputStream.use { it.readBytes() }
                else -> throw IllegalStateException("$url answered ${connection.responseCode}")
            }
        }
        throw IllegalStateException("$url redirected too often")
    }

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private companion object {
        const val EVERY_MS = 6 * 60 * 60 * 1000L
    }
}
