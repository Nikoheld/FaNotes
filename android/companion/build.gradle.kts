plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.gms.google-services") apply false
}

val fanotesVersion = providers.gradleProperty("fanotes.version").orElse("2026.11.2-beta.4")

android {
    namespace = "ch.fasrv.fanotes.companion"
    compileSdk = 37

    defaultConfig {
        applicationId = "ch.fasrv.kantiplus"
        minSdk = 29
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        targetSdk = 36
        versionCode = 51000154
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
            isMinifyEnabled = true
            isShrinkResources = true
            isDebuggable = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation(project(":core"))
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.09.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.work:work-runtime-ktx:2.10.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.google.firebase:firebase-messaging:24.1.0")
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")
}

if (file("google-services.json").isFile) {
    pluginManager.apply("com.google.gms.google-services")
}

tasks.register<Exec>("checkUserStrings") {
    group = "verification"
    description = "Check that German and English catalogs match and UI copy uses string resources."
    workingDir = rootProject.projectDir
    commandLine("python3", "companion/check-user-strings.py")
}

tasks.named("preBuild").configure { dependsOn("checkUserStrings") }
