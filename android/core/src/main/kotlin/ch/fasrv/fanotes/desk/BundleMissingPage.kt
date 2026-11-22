package ch.fasrv.fanotes.desk

/**
 * The page the writing mode shows when the web bundle (`assets/writing/`) is not in the APK (a build without
 * `fanotes/node_modules`). Replaces the WebView's raw network error. German unless [lang] is "en".
 */
fun bundleMissingPage(lang: String): String {
    val en = lang == "en"
    val title = if (en) "Not included in this build" else "Nicht in diesem Build enthalten"
    val body = if (en) {
        "The writing mode is missing from this build of the app. Install a full build to use it."
    } else {
        "Der Schreibmodus ist in diesem Build der App nicht enthalten. Installiere einen vollständigen Build, um ihn zu nutzen."
    }
    return """<!doctype html><html lang="${if (en) "en" else "de"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>$title</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 sans-serif;margin:0;padding:32px;max-width:520px}h1{font-size:20px}</style>
</head><body><h1>$title</h1><p>$body</p></body></html>"""
}
