# Release shrinking for the FaNotes tablet app. The app's own classes stay as written: they are reached
# through the manifest, WebView bridges (@JavascriptInterface), WorkManager and exec'd helpers, and kept
# names keep stack traces in bug reports readable. R8 still removes and optimizes unused library code.
# Mirrors android/companion/proguard-rules.pro (minus Firebase), which ships with the same libraries.
-keep class ch.fasrv.fanotes.** { *; }
-keepclassmembers class ch.fasrv.fanotes.** { *; }
-keep class androidx.work.** { *; }
-keep class org.jsoup.** { *; }
-keepnames class kotlinx.coroutines.** { *; }
-dontwarn javax.annotation.**
-dontwarn org.codehaus.mojo.animal_sniffer.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
