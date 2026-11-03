# The page calls the bridge's methods by name.
-keepclassmembers class app.krida.Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
