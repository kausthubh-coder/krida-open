import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The site the app opens. `-PkridaUrl=http://localhost:5551` points a build at a dev server (see android/README.md).
val kridaUrl = (findProperty("kridaUrl") as String?) ?: "https://krida-open.vercel.app"
// Where the app looks for a newer version (Updates.kt), and what's new in this one (scripts/release.ts sets it).
val kridaUpdateUrl = (findProperty("kridaUpdateUrl") as String?)
    ?: "https://raw.githubusercontent.com/kausthubh-coder/krida-open-releases/main/android.json"
val kridaNotes = (findProperty("kridaNotes") as String?) ?: ""
// Tests build an older and a newer copy to update between (scripts/e2e-android-update.ts); releases use the lines below.
val kridaVersionCode = (findProperty("kridaVersionCode") as String?)?.toInt()
val kridaVersionName = findProperty("kridaVersionName") as String?

// The release key lives outside the repo, so every build and every update is signed by the same key. It's open Krida's
// own (~/.krida-open), so this app installs beside private Krida's tv.krida.app and never signs as it.
val signing = File(System.getProperty("user.home"), ".krida-open/android-signing.properties")
    .takeIf { it.exists() }
    ?.let { file -> Properties().apply { file.inputStream().use { load(it) } } }

android {
    namespace = "app.krida"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.krida"
        minSdk = 26
        targetSdk = 36
        versionCode = 4
        versionName = "1.3"
        kridaVersionCode?.let { versionCode = it }
        kridaVersionName?.let { versionName = it }
        buildConfigField("String", "START_URL", "\"$kridaUrl\"")
        buildConfigField("String", "UPDATE_URL", "\"$kridaUpdateUrl\"")
        buildConfigField("String", "RELEASE_NOTES", groovy.json.JsonOutput.toJson(kridaNotes))
    }

    signingConfigs {
        if (signing != null) {
            create("release") {
                storeFile = File(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.webkit:webkit:1.14.0")
    // Signing in with Google happens in a Custom Tab: Google refuses sign-in inside a WebView.
    implementation("androidx.browser:browser:1.8.0")
}
