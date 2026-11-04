package app.krida

import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.SurfaceView
import android.view.View
import android.widget.FrameLayout
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DecoderReuseEvaluation
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.SubtitleView
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The film's own file, played by ExoPlayer under the page, as mpv plays it under Krida for Windows and Mac: MKV,
 * HEVC, and every sound a debrid file carries (DTS, TrueHD, E-AC-3 through FFmpeg when the phone has no decoder of its
 * own). The page goes see-through over it and keeps its own controls, party sync and skips; it drives this through
 * [Bridge] with mpv's words (src/features/player/androidPlayer.ts dresses it as mpv for `MpvVideo`), and hears back
 * what mpv would say, as `player` events: the position four times a second, pauses, buffering, the end, errors.
 *
 * Everything here runs on the main thread, ExoPlayer's.
 */
@OptIn(UnstableApi::class)
class NativePlayer(private val context: Context, private val emit: (JSONObject) -> Unit, private val onVideoSize: (Int, Int) -> Unit) {
    /** Under the page: the picture, and the file's own subtitles over it. Added to the activity's root by [MainActivity]. */
    val stage = Stage(context)

    private var player: ExoPlayer? = null
    private val main = Handler(Looper.getMainLooper())
    /** A load or a seek waits for its first picture, which mpv calls a playback restart. */
    private var restarting = false
    private var loaded = false
    private var ended = false
    private var buffering = false
    /** mpv counts audio and subtitle tracks from 1, in the file's order; so does the page. */
    private var audioTrack = 1
    private var subtitleTrack: Int? = null
    /** The position and how far it's buffered, as last reported, in milliseconds. */
    private var reported = -1L to -1L
    private var level = 1f
    private var muted = false

    private val tick = object : Runnable {
        override fun run() {
            val p = player ?: return
            if (loaded) {
                if (restarting && p.playbackState == Player.STATE_READY) restart()
                // As mpv does, only what changed: nothing at all while paused.
                if (p.currentPosition != reported.first) report("time-pos", p.currentPosition / 1000.0)
                if (p.bufferedPosition != reported.second) report("demuxer-cache-time", p.bufferedPosition / 1000.0)
                reported = p.currentPosition to p.bufferedPosition
            }
            main.postDelayed(this, 250)
        }
    }

    private fun make(): ExoPlayer {
        // Phones decode H.264, HEVC and AAC themselves; FFmpeg takes the sounds they can't (DTS, TrueHD, often E-AC-3).
        val renderers = DefaultRenderersFactory(context)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
            .setEnableDecoderFallback(true)
        // Debrid links redirect, sometimes from https to http; a slow server gets time before the film gives up.
        val http = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(20_000)
            .setReadTimeoutMs(30_000)
            .setUserAgent("Krida/${BuildConfig.VERSION_NAME} (Android)")
        val p = ExoPlayer.Builder(context, renderers)
            .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(context, http)))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setSeekBackIncrementMs(10_000)
            .build()
        p.setVideoSurfaceView(stage.surface)
        p.addListener(Listener())
        p.addAnalyticsListener(object : AnalyticsListener {
            // Which decoder took the sound: "ffmpeg…" for what the phone couldn't (e2e-android-native.ts checks it).
            override fun onAudioDecoderInitialized(event: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long) =
                report("audio-decoder", decoderName)

            override fun onVideoDecoderInitialized(event: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long) =
                report("video-decoder", decoderName)

            override fun onAudioInputFormatChanged(event: AnalyticsListener.EventTime, format: androidx.media3.common.Format, decoderReuseEvaluation: DecoderReuseEvaluation?) =
                report("audio-format", format.sampleMimeType ?: "")
        })
        main.post(tick)
        return p
    }

    /** Plays `url` from `start` seconds, paused or not, with the file's `aid`th sound (from 1). */
    fun load(url: String, start: Double, paused: Boolean, aid: Int, title: String) {
        val p = player ?: make().also { player = it }
        audioTrack = aid
        subtitleTrack = null
        loaded = false
        ended = false
        buffering = false
        restarting = true
        stage.visibility = View.VISIBLE
        stage.cues(emptyList())
        p.setMediaItem(
            MediaItem.Builder().setUri(Uri.parse(url)).setMediaMetadata(MediaMetadata.Builder().setTitle(title).build()).build(),
            (start * 1000).toLong(),
        )
        p.playWhenReady = !paused
        p.prepare()
        chooseTracks()
    }

    fun seek(time: Double) {
        val p = player ?: return
        restarting = true
        ended = false
        p.seekTo((max(0.0, time) * 1000).toLong())
        report("eof-reached", false)
    }

    /** One of mpv's properties, as the page sets them (`MpvVideo.set`); anything else is ignored, as mpv's allowlist does. */
    fun set(name: String, value: Any?) {
        val p = player ?: return
        when (name) {
            "pause" -> p.playWhenReady = value != true
            "speed" -> (value as? Number)?.let { p.playbackParameters = PlaybackParameters(it.toFloat()) }
            "volume" -> (value as? Number)?.let {
                level = (it.toFloat() / 100).coerceIn(0f, 1f)
                p.volume = if (muted) 0f else level
            }
            "mute" -> {
                muted = value == true
                p.volume = if (muted) 0f else level
            }
            "aid" -> (value as? Number)?.let {
                audioTrack = it.toInt()
                chooseTracks()
            }
            "sid" -> {
                subtitleTrack = (value as? Number)?.toInt()
                chooseTracks()
            }
            "panscan" -> (value as? Number)?.let { stage.fit = if (it.toDouble() > 0) Fit.CROP else if (stage.fit == Fit.CROP) Fit.FIT else stage.fit }
            "keepaspect" -> if (value == false) stage.fit = Fit.STRETCH else if (stage.fit == Fit.STRETCH) stage.fit = Fit.FIT
            "video-unscaled" -> if (value == "yes") stage.fit = Fit.ORIGINAL else if (stage.fit == Fit.ORIGINAL) stage.fit = Fit.FIT
        }
    }

    /** Stops the film and lets go of the decoders; the next load makes a new player. */
    fun stop() {
        main.removeCallbacks(tick)
        player?.release()
        player = null
        loaded = false
        stage.visibility = View.GONE
        stage.cues(emptyList())
    }

    /** Leaving the app without the small window: the film pauses, as the page's own video does. */
    fun pause() {
        val p = player ?: return
        if (p.playWhenReady) p.playWhenReady = false
    }

    private fun restart() {
        restarting = false
        report("playback-restart", null, event = true)
    }

    private inner class Listener : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            val p = player ?: return
            if (state == Player.STATE_READY && !loaded) {
                loaded = true
                report("duration", p.duration.takeIf { it != C.TIME_UNSET }?.let { it / 1000.0 })
                report("file-loaded", null, event = true)
            }
            if (state == Player.STATE_READY && restarting) restart()
            val nowBuffering = state == Player.STATE_BUFFERING && loaded
            if (nowBuffering != buffering) {
                buffering = nowBuffering
                report("paused-for-cache", nowBuffering)
            }
            if (state == Player.STATE_ENDED && !ended) {
                ended = true
                report("eof-reached", true)
            }
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = report("pause", !playWhenReady)

        override fun onPlayerError(error: PlaybackException) {
            report("error", error.errorCodeName)
            report("end-file", null, event = true, reason = "error")
        }

        override fun onTracksChanged(tracks: Tracks) = chooseTracks()

        override fun onVideoSizeChanged(size: VideoSize) {
            if (size.width == 0 || size.height == 0) return
            val width = (size.width * size.pixelWidthHeightRatio).roundToInt()
            stage.videoSize(width, size.height)
            onVideoSize(width, size.height)
            report("width", width)
            report("height", size.height)
        }

        override fun onCues(cues: CueGroup) = stage.cues(cues.cues)
    }

    /** The sound and subtitles the page chose, by their place among the file's own tracks of that kind. */
    private fun chooseTracks() {
        val p = player ?: return
        val groups = p.currentTracks.groups
        val audio = groups.filter { it.type == C.TRACK_TYPE_AUDIO }
        val text = groups.filter { it.type == C.TRACK_TYPE_TEXT }
        val params = p.trackSelectionParameters.buildUpon()
        audio.getOrNull(audioTrack - 1)?.let { params.setOverrideForType(TrackSelectionOverride(it.mediaTrackGroup, 0)) }
        val sub = subtitleTrack?.let { text.getOrNull(it - 1) }
        params.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, sub == null)
        if (sub != null) params.setOverrideForType(TrackSelectionOverride(sub.mediaTrackGroup, 0))
        val next = params.build()
        if (next != p.trackSelectionParameters) p.trackSelectionParameters = next
    }

    /** What mpv would say: `{name, value, time}`, or an `event`; `time` is the position as it's sent. */
    private fun report(name: String, value: Any?, event: Boolean = false, reason: String? = null) {
        val p = player
        val detail = JSONObject().put("type", "player").put(if (event) "event" else "name", name)
        if (!event) detail.put("value", value ?: JSONObject.NULL)
        if (reason != null) detail.put("reason", reason)
        if (p != null && loaded) detail.put("time", p.currentPosition / 1000.0)
        emit(detail)
    }

    enum class Fit { FIT, CROP, STRETCH, ORIGINAL }

    /** The picture laid out the way the Picture menu asks, centred, with the file's subtitles over the whole screen. */
    class Stage(context: Context) : FrameLayout(context) {
        val surface = SurfaceView(context)
        private val subtitles = SubtitleView(context).apply {
            setUserDefaultStyle()
            setUserDefaultTextSize()
        }
        private var video = 0 to 0

        var fit = Fit.FIT
            set(value) {
                field = value
                requestLayout()
            }

        init {
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
            addView(surface, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
            addView(subtitles, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        }

        fun videoSize(width: Int, height: Int) {
            video = width to height
            requestLayout()
        }

        fun cues(cues: List<androidx.media3.common.text.Cue>) = subtitles.setCues(cues)

        override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
            val w = right - left
            val h = bottom - top
            val (vw, vh) = video
            val (pw, ph) = when {
                vw == 0 || vh == 0 || fit == Fit.STRETCH -> w to h
                fit == Fit.ORIGINAL -> vw to vh
                else -> {
                    val scale = if (fit == Fit.CROP) max(w.toFloat() / vw, h.toFloat() / vh) else min(w.toFloat() / vw, h.toFloat() / vh)
                    (vw * scale).roundToInt() to (vh * scale).roundToInt()
                }
            }
            val x = (w - pw) / 2
            val y = (h - ph) / 2
            surface.measure(MeasureSpec.makeMeasureSpec(pw, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(ph, MeasureSpec.EXACTLY))
            surface.layout(x, y, x + pw, y + ph)
            subtitles.layout(0, 0, w, h)
        }

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            super.onMeasure(widthMeasureSpec, heightMeasureSpec)
            subtitles.measure(MeasureSpec.makeMeasureSpec(measuredWidth, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(measuredHeight, MeasureSpec.EXACTLY))
        }
    }
}
