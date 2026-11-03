package app.krida

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.Icon
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Rational
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JsResult
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.updateLayoutParams
import androidx.lifecycle.Lifecycle
import org.json.JSONObject
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * Krida as an Android app: the live site in a WebView, so every deploy reaches the app with no update, and the parts
 * a page can't reach handed to it through [Bridge]: the screen's own brightness, the phone's volume, the haptic
 * motor, holding the phone sideways, keeping the screen on, and the small picture-in-picture window.
 */
class MainActivity : ComponentActivity() {
    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var offline: View

    /** The page in full screen: WebView hands over a view of it to lay over everything. */
    private var fullscreen: View? = null
    private var fullscreenDone: WebChromeClient.CustomViewCallback? = null

    /** The splash stays until the page has drawn, so it never flashes an empty screen. */
    private var painted = false

    private var inPlayer = false
    private var playing = false
    private var aspect = Rational(16, 9)

    /** The status bar, navigation bar and cutout, in CSS pixels, for the page to keep its content clear of. */
    var pageInsets = JSONObject()
        private set

    /** A sign-in that came back before the page could hear it (Bridge.signInCallback). */
    private var signInCallback: String? = null

    private val audio by lazy { getSystemService(AudioManager::class.java) }
    val updates by lazy { Updates(this) }
    private val origin by lazy { Uri.parse(BuildConfig.START_URL) }

    private val mediaButton = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = emit("media", "action" to "toggle")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        splash.setKeepOnScreenCondition { !painted }

        // The page draws behind clear bars; its margins keep it clear of them (see the insets below).
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
        // Full screen reaches into a notch, as the picture should.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }

        root = FrameLayout(this).apply { setBackgroundColor(getColor(R.color.page)) }
        web = makeWebView()
        offline = makeOfflineView()
        root.addView(web, FrameLayout.LayoutParams(MATCH, MATCH))
        root.addView(offline, FrameLayout.LayoutParams(MATCH, MATCH))
        setContentView(root)

        // The page runs edge to edge, under the status bar, the navigation bar and a camera cutout, and keeps its
        // content clear of them itself from the sizes it's given here (src/ui/android.ts sets --android-inset-*).
        // WebView's own env(safe-area-inset-*) is 0 on some versions and the real sizes on others, so the page is
        // told once, by the app. Only the keyboard shrinks the page, so a field stays above it.
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            web.updateLayoutParams<FrameLayout.LayoutParams> { setMargins(0, 0, 0, keyboard.bottom) }
            val px = resources.displayMetrics.density
            val next = JSONObject()
                .put("top", bars.top / px)
                .put("right", bars.right / px)
                // The keyboard covers the navigation bar.
                .put("bottom", if (keyboard.bottom > 0) 0 else bars.bottom / px)
                .put("left", bars.left / px)
            if (next.toString() != pageInsets.toString()) {
                pageInsets = next
                emit("insets", *next.keys().asSequence().map { it to next.get(it) }.toList().toTypedArray())
            }
            insets
        }

        ContextCompat.registerReceiver(this, mediaButton, IntentFilter(ACTION_MEDIA), ContextCompat.RECEIVER_NOT_EXPORTED)
        onBackPressedDispatcher.addCallback(this) { back() }

        if (isSignInCallback(intent)) signInCallback = intent.dataString
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(urlFor(intent))
        // A page that never draws (no network, a dead server) still lets the splash go.
        root.postDelayed({ painted = true }, 6000)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun makeWebView() = WebView(this).apply {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        setBackgroundColor(getColor(R.color.page))
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Trailers start on their own on Home, as they do in a browser.
            mediaPlaybackRequiresUserGesture = false
            // Krida is laid out for its own type sizes; the phone's font scale would break its rows.
            textZoom = 100
            setSupportZoom(false)
            userAgentString = "$userAgentString KridaAndroid/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
        addJavascriptInterface(Bridge(this@MainActivity), "KridaAndroid")
        webViewClient = Client()
        webChromeClient = Chrome()
    }

    private fun makeOfflineView(): View {
        val title = TextView(this).apply {
            text = "Can’t reach Krida"
            textSize = 18f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
        }
        val body = TextView(this).apply {
            text = "Check your connection, then try again."
            textSize = 15f
            setTextColor(Color.argb(160, 255, 255, 255))
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(20))
        }
        // Krida's primary button: a white pill with dark type.
        val retry = Button(this).apply {
            text = "Try again"
            isAllCaps = false
            textSize = 15f
            setTextColor(getColor(R.color.page))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(24).toFloat()
            }
            stateListAnimator = null
            setPadding(dp(24), 0, dp(24), 0)
            minHeight = dp(44)
            setOnClickListener {
                offline.visibility = View.GONE
                web.reload()
            }
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(getColor(R.color.page))
            visibility = View.GONE
            addView(title)
            addView(body)
            addView(retry, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            val url = request.url
            val host = url.host ?: return false
            // Krida stays here, and so does connecting Simkl, whose sign-in comes back to Krida. Anything else (a
            // trailer on YouTube, a title on IMDb) opens in its own app or the browser.
            if (host == origin.host || host == "simkl.com" || host.endsWith(".simkl.com")) return false
            try {
                startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
            } catch (_: ActivityNotFoundException) {
                // Nothing on the phone opens it: stay put.
            }
            return true
        }

        override fun onPageCommitVisible(view: WebView, url: String) {
            painted = true
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            // Krida's service worker opens the last page it saw even offline, so this is a first open with no network.
            if (!request.isForMainFrame) return
            painted = true
            offline.visibility = View.VISIBLE
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // The page's process died (the phone ran short of memory): start the app's screen again rather than crash.
            root.removeView(web)
            web.destroy()
            recreate()
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (fullscreen != null) {
                callback.onCustomViewHidden()
                return
            }
            fullscreen = view
            fullscreenDone = callback
            root.addView(view, FrameLayout.LayoutParams(MATCH, MATCH))
            bars(show = false)
        }

        override fun onHideCustomView() {
            fullscreen?.let { root.removeView(it) }
            fullscreen = null
            fullscreenDone = null
            bars(show = !inPlayer)
            setOrientation("any")
        }

        // Convex asks before a page unloads with a save in flight. The app only reloads to open a Krida link, which
        // you asked for, and WebView's stock "Confirm Navigation" box is no way to ask.
        override fun onJsBeforeUnload(view: WebView, url: String, message: String, result: JsResult): Boolean {
            result.confirm()
            return true
        }

        // Without this a video shows WebView's grey play button until its first frame.
        override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    }

    private fun bars(show: Boolean) {
        WindowCompat.getInsetsController(window, root).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            if (show) show(WindowInsetsCompat.Type.systemBars()) else hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    /**
     * Back closes what's open on the page first (a sheet, full screen), then goes back a page, and from the first
     * page leaves the app running, as Android's own apps do.
     */
    private fun back() {
        web.evaluateJavascript("window.kridaBack ? window.kridaBack() : false") { handled ->
            when {
                handled == "true" -> Unit
                fullscreen != null -> fullscreenDone?.onCustomViewHidden()
                web.canGoBack() -> web.goBack()
                else -> moveTaskToBack(true)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        when {
            isSignInCallback(intent) -> emit("signin", "url" to intent.dataString.orEmpty())
            intent.data != null -> web.loadUrl(urlFor(intent))
        }
    }

    /** A Krida link (an invite, a shortcut) on whichever site this build opens. */
    private fun urlFor(intent: Intent?): String {
        val link = intent?.data ?: return BuildConfig.START_URL
        // A sign-in that came back to a closed app finishes on the sign-in page, which reads it (signInCallback).
        if (isSignInCallback(intent)) return origin.buildUpon().encodedPath("/sign-in").build().toString()
        return origin.buildUpon().encodedPath(link.encodedPath).encodedQuery(link.encodedQuery).build().toString()
    }

    // ----- signing in

    /**
     * Google refuses to sign anyone in inside a WebView, so its page opens in a Custom Tab: the phone's own browser,
     * over the app. Clerk sends it back to [SIGN_IN_REDIRECT], which brings this activity forward (closing the tab) and
     * hands the page the link (src/data/appSignIn.ts finishes the sign-in).
     */
    fun openSignIn(url: String) {
        val uri = Uri.parse(url)
        if (uri.scheme != "https") return
        try {
            CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, uri)
        } catch (_: ActivityNotFoundException) {
            // No browser at all: nothing can sign in with Google here.
        }
    }

    fun takeSignInCallback(): String? = signInCallback.also { signInCallback = null }

    private fun isSignInCallback(intent: Intent?) =
        intent?.data?.let { it.scheme == BuildConfig.APPLICATION_ID && it.host == SIGN_IN_HOST } == true

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    // Out of sight and not in the small window, the page rests: the film pauses and nothing draws.
    override fun onStart() {
        super.onStart()
        web.onResume()
        updates.onStart()
    }

    override fun onStop() {
        super.onStop()
        if (!isInPictureInPictureMode) web.onPause()
    }

    override fun onDestroy() {
        unregisterReceiver(mediaButton)
        super.onDestroy()
    }

    // ----- haptics

    fun haptic(kind: String) {
        val constant = when (kind) {
            "detent" -> if (Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.SEGMENT_FREQUENT_TICK else HapticFeedbackConstants.CLOCK_TICK
            "press" -> HapticFeedbackConstants.LONG_PRESS
            "confirm" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
            "reject" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
            else -> HapticFeedbackConstants.CLOCK_TICK
        }
        (fullscreen ?: web).performHapticFeedback(constant)
    }

    // ----- brightness and volume

    /**
     * The screen's brightness as the page sees it: even steps to the eye, as the phone's own slider moves. The
     * window takes light in a straight line, which bunches everything you'd notice into the bottom of a drag.
     */
    fun brightness(): Float {
        val own = window.attributes.screenBrightness
        val linear = if (own >= 0) own else Settings.System.getInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, 128) / 255f
        return linear.coerceIn(0f, 1f).pow(1 / GAMMA)
    }

    fun setBrightness(level: Float) {
        // Never fully dark: a black screen with the controls hidden looks broken.
        window.attributes = window.attributes.apply { screenBrightness = level.coerceIn(0f, 1f).pow(GAMMA).coerceAtLeast(0.005f) }
    }

    fun resetBrightness() {
        window.attributes = window.attributes.apply { screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE }
    }

    fun volume(): Float {
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        return audio.getStreamVolume(AudioManager.STREAM_MUSIC).toFloat() / max
    }

    fun setVolume(level: Float): Float {
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        try {
            // No flags: Krida shows its own meter, not the phone's panel.
            audio.setStreamVolume(AudioManager.STREAM_MUSIC, (level.coerceIn(0f, 1f) * max).roundToInt(), 0)
        } catch (_: SecurityException) {
            // Do not disturb holds the volume.
        }
        return volume()
    }

    /** In the player, the volume keys move the phone's volume quietly and the page shows its own meter. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val key = event.keyCode
        if (inPlayer && (key == KeyEvent.KEYCODE_VOLUME_UP || key == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                val direction = if (key == KeyEvent.KEYCODE_VOLUME_UP) AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER
                audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, 0)
                emit("volume", "value" to volume())
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    // ----- the player

    /**
     * Watching, from Play until you leave: sideways and edge to edge, bars hidden until a swipe, as Netflix does.
     * Upright, a film is a strip across the middle of the screen.
     */
    fun setPlayer(on: Boolean) {
        inPlayer = on
        requestedOrientation =
            if (on) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        root.setBackgroundColor(if (on) Color.BLACK else getColor(R.color.page))
        if (fullscreen == null) bars(show = !on)
        ViewCompat.requestApplyInsets(root)
        if (!on) {
            playing = false
            resetBrightness()
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
        updatePictureInPicture()
    }

    fun setPlaying(on: Boolean) {
        playing = on && inPlayer
        if (playing) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        updatePictureInPicture()
    }

    fun setVideoSize(width: Int, height: Int) {
        if (width <= 0 || height <= 0) return
        // Android allows a small window between 2.39:1 and its upright twin.
        val ratio = (width.toFloat() / height).coerceIn(1 / 2.39f, 2.39f)
        aspect = Rational((ratio * 1000).roundToInt(), 1000)
        updatePictureInPicture()
    }

    fun setOrientation(kind: String) {
        if (inPlayer) return
        requestedOrientation =
            if (kind == "landscape") ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    }

    fun canPictureInPicture() = packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    fun enterPictureInPicture() {
        if (canPictureInPicture() && inPlayer) enterPictureInPictureMode(pictureInPictureParams())
    }

    private fun pictureInPictureParams(): PictureInPictureParams {
        val icon = if (playing) R.drawable.pip_pause else R.drawable.pip_play
        val label = getString(if (playing) R.string.pip_pause else R.string.pip_play)
        val press = PendingIntent.getBroadcast(this, 0, Intent(ACTION_MEDIA).setPackage(packageName), PendingIntent.FLAG_IMMUTABLE)
        return PictureInPictureParams.Builder()
            .setAspectRatio(aspect)
            .setActions(listOf(RemoteAction(Icon.createWithResource(this, icon), label, label, press)))
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    // Going home mid-film shrinks it into the small window, as YouTube and Netflix do.
                    setAutoEnterEnabled(inPlayer && playing)
                    setSeamlessResizeEnabled(true)
                }
            }
            .build()
    }

    private fun updatePictureInPicture() {
        if (canPictureInPicture()) setPictureInPictureParams(pictureInPictureParams())
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // Before Android 12 there's no automatic small window; leaving is the cue.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S && inPlayer && playing) enterPictureInPicture()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        emit("pip", "on" to isInPictureInPictureMode)
        // Swiping the small window away stops the film; tapping it back to full size carries on.
        if (!isInPictureInPictureMode && lifecycle.currentState == Lifecycle.State.CREATED) emit("media", "action" to "pause")
    }

    /** Tells the page where the app's updates stand. */
    fun emitUpdate(status: JSONObject) = dispatch(JSONObject(status.toString()).put("type", "update"))

    /** Tells the page something happened on the phone, as a `krida-android` event on `window`. */
    private fun emit(type: String, vararg fields: Pair<String, Any>) {
        val detail = JSONObject().put("type", type)
        for ((k, v) in fields) detail.put(k, v)
        dispatch(detail)
    }

    private fun dispatch(detail: JSONObject) =
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('krida-android',{detail:$detail}))", null)

    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()

    companion object {
        private const val SIGN_IN_HOST = "sso-callback"
        /** The app's own link for a sign-in to come back to; the manifest claims it (the scheme is the app's id). */
        const val SIGN_IN_REDIRECT = "${BuildConfig.APPLICATION_ID}://$SIGN_IN_HOST"
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val ACTION_MEDIA = "app.krida.MEDIA"
        /** Roughly how the eye sees light: what Android's own brightness slider uses. */
        private const val GAMMA = 2.2f
    }
}

