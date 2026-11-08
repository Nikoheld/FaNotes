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
        // Only the offline Tesseract OCR build for Kanti+ comes from JitPack; nothing else may.
        exclusiveContent {
            forRepository { maven("https://jitpack.io") }
            filter { includeGroup("com.github.adaptech-cz.Tesseract4Android") }
        }
    }
}

rootProject.name = "fanotes-android"
include(":core", ":app", ":companion")
