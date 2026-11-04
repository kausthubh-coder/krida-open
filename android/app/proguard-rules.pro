# The page calls the bridge's methods by name.
-keepclassmembers class app.krida.Bridge {
    @android.webkit.JavascriptInterface <methods>;
}

# Media3 finds the FFmpeg audio renderer by its name (DefaultRenderersFactory), and FFmpeg's native code calls back into
# its decoder's Java side by name.
-keep class androidx.media3.decoder.ffmpeg.** { *; }
