import com.android.build.api.artifact.MultipleArtifact
import com.android.build.api.artifact.SingleArtifact
import java.nio.ByteBuffer
import java.nio.ByteOrder

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.gms.google-services") apply false
}

val fanotesVersion = providers.gradleProperty("fanotes.version").orElse("2026.11.2-beta.26")

android {
    namespace = "ch.fasrv.fanotes.companion"
    compileSdk = 37

    defaultConfig {
        applicationId = "ch.fasrv.kantiplus"
        minSdk = 29
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        targetSdk = 37
        versionCode = 51000176
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
            // Play reads the symbol tables from the bundle and from
            // build/outputs/native-debug-symbols/release/native-debug-symbols.zip.
            ndk { debugSymbolLevel = "SYMBOL_TABLE" }
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

    androidResources {
        noCompress += "traineddata"
    }

    testOptions {
        unitTests {
            // Robolectric needs the merged resources and manifest to render the real UI on the JVM.
            isIncludeAndroidResources = true
        }
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
    testImplementation("org.xerial:sqlite-jdbc:3.46.1.3")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    // JVM UI performance harness (UiPerformanceTest): the real Compose UI under Robolectric.
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation(platform("androidx.compose:compose-bom:2026.09.00"))
    testImplementation("androidx.compose.ui:ui-test-junit4")
    testImplementation("androidx.test.ext:junit:1.2.1")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
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
    // WebView profiles: each further school connection keeps its own cookie jar.
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.work:work-runtime-ktx:2.10.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.google.firebase:firebase-messaging:24.1.0")
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")
    // On-device OCR for scanned pages (Tesseract 5, Apache 2.0). No network use.
    implementation("com.github.adaptech-cz.Tesseract4Android:tesseract4android:4.8.0")
}

/**
 * Native debug symbols for Play. Tesseract4Android and androidx.graphics ship
 * their .so files already stripped. AGP skips a library that stripping leaves
 * unchanged, so its own SYMBOL_TABLE extraction wrote nothing and Play saw a
 * bundle without symbols. For such a library the dynamic symbol table is all
 * there is, and an unchanged copy is what `objcopy --strip-debug` would write.
 * A library that still has a .symtab or debug sections is left to AGP, which
 * needs the NDK to extract it.
 */
abstract class StrippedNativeSymbolTablesTask : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val nativeLibs: DirectoryProperty

    @get:OutputDirectory
    abstract val symbolTables: DirectoryProperty

    @TaskAction
    fun copy() {
        val out = symbolTables.get().asFile
        out.deleteRecursively()
        nativeLibs.get().asFile.walkTopDown()
            .filter { it.isFile && it.name.endsWith(".so") && isStrippedElf(it) }
            .forEach { it.copyTo(out.resolve("${it.parentFile.name}/${it.name}.sym")) }
    }

    private fun isStrippedElf(file: File): Boolean = runCatching {
        val elf = ByteBuffer.wrap(file.readBytes())
        if (elf.getInt(0) != 0x7f454c46) return@runCatching false
        val wide = elf.get(4).toInt() == 2
        elf.order(if (elf.get(5).toInt() == 2) ByteOrder.BIG_ENDIAN else ByteOrder.LITTLE_ENDIAN)
        val table = if (wide) elf.getLong(0x28).toInt() else elf.getInt(0x20)
        val entrySize = elf.getShort(if (wide) 0x3a else 0x2e).toInt() and 0xffff
        val count = elf.getShort(if (wide) 0x3c else 0x30).toInt() and 0xffff
        val namesIndex = elf.getShort(if (wide) 0x3e else 0x32).toInt() and 0xffff
        val header = { index: Int -> table + index * entrySize }
        val names = if (wide) elf.getLong(header(namesIndex) + 0x18).toInt() else elf.getInt(header(namesIndex) + 0x10)
        (0 until count).none { index ->
            var at = names + elf.getInt(header(index))
            val name = buildString { while (elf.get(at).toInt() != 0) append(elf.get(at++).toInt().toChar()) }
            name == ".symtab" || name.startsWith(".debug_") || name.startsWith(".zdebug_")
        }
    }.getOrDefault(false)
}

androidComponents {
    onVariants(selector().withBuildType("release")) { variant ->
        val variantName = variant.name.replaceFirstChar { it.uppercase() }
        val symbols = tasks.register<StrippedNativeSymbolTablesTask>("extract${variantName}StrippedNativeSymbolTables") {
            nativeLibs.set(variant.artifacts.get(SingleArtifact.MERGED_NATIVE_LIBS))
        }
        variant.artifacts.use(symbols)
            .wiredWith(StrippedNativeSymbolTablesTask::symbolTables)
            .toAppendTo(MultipleArtifact.NATIVE_SYMBOL_TABLES)
    }
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
