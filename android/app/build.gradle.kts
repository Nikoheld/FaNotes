plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val fanotesVersion = providers.gradleProperty("fanotes.version").orElse("2026.11.3-beta.1")

android {
    namespace = "ch.fasrv.fanotes"
    compileSdk = 37

    defaultConfig {
        applicationId = "ch.fasrv.fanotes"
        minSdk = 29
        targetSdk = 36
        versionCode = 51000251
        versionName = fanotesVersion.get()
    }

    val keystorePath = providers.environmentVariable("FANOTES_ANDROID_KEYSTORE")
    val keystorePassword = providers.environmentVariable("FANOTES_ANDROID_KEYSTORE_PASSWORD")
    val keyPassword = providers.environmentVariable("FANOTES_ANDROID_KEY_PASSWORD").orElse(keystorePassword)

    signingConfigs {
        create("release") {
            val path = keystorePath.orNull
            val password = keystorePassword.orNull
            if (!path.isNullOrBlank() && !password.isNullOrBlank()) {
                storeFile = file(path)
                storePassword = password
                keyAlias = "fanotes"
                this.keyPassword = keyPassword.get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
        jniLibs {
            // Extract libone2html.so and lib7za.so so the importer can exec them.
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation(project(":core"))
    implementation("androidx.work:work-runtime:2.11.2")
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.documentfile:documentfile:1.1.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
}

// The writing mode ("Schreiben") runs the shared web editor in a WebView. Its
// bundle is built from fanotes/ into assets/writing/ (git-ignored). Without
// Node and fanotes/node_modules the build continues and the writing screen
// reports that it is missing from this build.
val writingBundle = tasks.register<Exec>("writingBundle") {
    description = "Builds the writing mode bundle for the WebView."
    val app = rootProject.file("../fanotes")
    workingDir = app
    commandLine("node", "scripts/build-android-writing.mjs")
    onlyIf {
        val missing = !file("src/main/assets/writing/writing.html").exists() || project.hasProperty("fanotesWritingBundle")
        val canBuild = File(app, "node_modules/vite").exists()
        if (missing && !canBuild) logger.warn("FaNotes: writing mode bundle missing and fanotes/node_modules not installed; the writing screen will be empty.")
        missing && canBuild
    }
}
tasks.named("preBuild") { dependsOn(writingBundle) }
