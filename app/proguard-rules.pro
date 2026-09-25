# Методы моста для JavaScript нельзя переименовывать
-keepclassmembers class com.severmax.app.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
