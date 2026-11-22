pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Keep the large artifacts (inference runtime, Robolectric android-all jars) off Maven Central's rate-limited CI endpoint.
        exclusiveContent {
            forRepository {
                maven("https://maven-central.storage-download.googleapis.com/maven2/")
            }
            filter {
                includeModule("com.microsoft.onnxruntime", "onnxruntime-android")
                includeModule("org.robolectric", "android-all-instrumented")
            }
        }
        // Only the offline Tesseract OCR build for Kanti+ comes from JitPack; nothing else may.
        exclusiveContent {
            forRepository { maven("https://jitpack.io") }
            filter { includeGroup("com.github.adaptech-cz.Tesseract4Android") }
        }
    }
}

rootProject.name = "fanotes-android"
include(":core", ":app", ":companion")
