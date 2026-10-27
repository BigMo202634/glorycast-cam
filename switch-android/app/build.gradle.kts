plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// GloryCast Switch for Android: the same Switch page as on the computer, carried inside the app, so the
// phone talks to OBS straight over the Wi-Fi and the computer runs nothing but OBS.
// The release key is never stored in this repository: the build is unsigned and signed afterwards with
// the key kept in the GloryCast project files (tools/sign-apk.sh).
android {
    namespace = "com.glorycast.switcher"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.glorycast.switcher"
        minSdk = 24
        targetSdk = 34
        versionCode = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1
        versionName = "1.0.1"
    }

    buildTypes {
        release { isMinifyEnabled = false }
        debug { applicationIdSuffix = ".debug" }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    lint {
        checkReleaseBuilds = false
        abortOnError = false
        checkOnly += setOf("NewApi", "InlinedApi", "MissingPermission", "WrongConstant", "JavascriptInterface")
        textReport = true
        textOutput = file("stdout")
    }
}
