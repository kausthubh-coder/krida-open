package app.krida

import android.webkit.JavascriptInterface
import org.json.JSONArray

/**
 * What the page can ask of the phone, as `window.KridaAndroid` (src/ui/android.ts is the page's side). WebView calls
 * these on its own thread: anything that touches the window goes through `onUi`; reads of a setting answer at once.
 * Levels are 0 to 1 both ways.
 */
class Bridge(private val app: MainActivity) {
    private fun onUi(work: () -> Unit) = app.runOnUiThread(work)

    @JavascriptInterface
    fun version(): String = BuildConfig.VERSION_NAME

    /** What's new in this version, shown once after an update (empty before 1.2). */
    @JavascriptInterface
    fun notes(): String = BuildConfig.RELEASE_NOTES

    /** Where the app's own updates stand, as JSON `{state, version, notes}` (Updates.kt); changes come as events. */
    @JavascriptInterface
    fun updateStatus(): String = app.updates.status.toString()

    /** Android's install screen for the version that has downloaded. */
    @JavascriptInterface
    fun installUpdate() = onUi { app.updates.install() }

    /** The link a sign-in in the browser comes back to (MainActivity.openSignIn), for Clerk's redirect. */
    @JavascriptInterface
    fun signInRedirect(): String = MainActivity.SIGN_IN_REDIRECT

    /** Opens a sign-in page (Google's) in a Custom Tab; it comes back as a `signin` event with the link it ended on. */
    @JavascriptInterface
    fun openSignIn(url: String) = onUi { app.openSignIn(url) }

    /** A sign-in that came back while the page wasn't loaded (the app had been closed), once; empty otherwise. */
    @JavascriptInterface
    fun signInCallback(): String = app.takeSignInCallback() ?: ""

    /** The status bar, navigation bar and cutout as `{top, right, bottom, left}` in CSS pixels; changes come as events. */
    @JavascriptInterface
    fun insets(): String = app.pageInsets.toString()

    /** "tick" (a step), "detent" (a slider passing a mark), "press" (a long press took), "confirm", "reject". */
    @JavascriptInterface
    fun haptic(kind: String) = onUi { app.haptic(kind) }

    @JavascriptInterface
    fun getBrightness(): Float = app.brightness()

    @JavascriptInterface
    fun setBrightness(level: Float) = onUi { app.setBrightness(level) }

    /** Back to the phone's own brightness, as the player is left. */
    @JavascriptInterface
    fun resetBrightness() = onUi { app.resetBrightness() }

    @JavascriptInterface
    fun getVolume(): Float = app.volume()

    /** Sets the phone's media volume and answers the level it landed on: the phone has steps (usually 15 or 25). */
    @JavascriptInterface
    fun setVolume(level: Float): Float = app.setVolume(level)

    /** The player is open: volume keys show Krida's own meter, and leaving the app can shrink it to a small window. */
    @JavascriptInterface
    fun setPlayer(on: Boolean) = onUi { app.setPlayer(on) }

    /** The picture is playing: the screen stays on, and the small window's button shows pause. */
    @JavascriptInterface
    fun setPlaying(playing: Boolean) = onUi { app.setPlaying(playing) }

    /** The film's own shape, for the small window. */
    @JavascriptInterface
    fun setVideoSize(width: Int, height: Int) = onUi { app.setVideoSize(width, height) }

    /** "landscape" holds the phone sideways; anything else lets it turn freely. */
    @JavascriptInterface
    fun setOrientation(kind: String) = onUi { app.setOrientation(kind) }

    @JavascriptInterface
    fun canPictureInPicture(): Boolean = app.canPictureInPicture()

    @JavascriptInterface
    fun enterPictureInPicture() = onUi { app.enterPictureInPicture() }

    /**
     * From 1.4, the file itself plays under the page (NativePlayer): MKV, HEVC, DTS and TrueHD, which the page's video
     * can't. The page speaks mpv's words (src/features/player/androidPlayer.ts) and hears `player` events back.
     * `aid` counts the file's sound tracks from 1.
     */
    @JavascriptInterface
    fun playerLoad(url: String, start: Double, paused: Boolean, aid: Int, title: String) = onUi { app.playerLoad(url, start, paused, aid, title) }

    @JavascriptInterface
    fun playerSeek(time: Double) = onUi { app.playerSeek(time) }

    /** One of mpv's properties (pause, speed, volume, mute, aid, sid, panscan, keepaspect, video-unscaled), its value as JSON. */
    @JavascriptInterface
    fun playerSet(name: String, value: String) {
        val parsed = try {
            JSONArray("[$value]").get(0)
        } catch (_: org.json.JSONException) {
            return
        }
        onUi { app.playerSet(name, parsed) }
    }

    @JavascriptInterface
    fun playerStop() = onUi { app.playerStop() }
}
