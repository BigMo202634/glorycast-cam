plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The release key is never stored in this repository. A build signs only when GitHub secrets
// supply the key; otherwise it makes an unsigned APK that is signed afterwards with the key kept
// in the GloryCast project files.
val storeFileEnv: String? = System.getenv("GCCAM_STORE_FILE")

android {
    namespace = "com.glorycast.cam"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.glorycast.cam"
        minSdk = 24
        targetSdk = 34
        versionCode = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1
        versionName = "1.0.0"
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    }

    if (storeFileEnv != null) {
        signingConfigs {
            create("release") {
                storeFile = file(storeFileEnv)
                storePassword = System.getenv("GCCAM_STORE_PASSWORD")
                keyAlias = System.getenv("GCCAM_KEY_ALIAS")
                keyPassword = System.getenv("GCCAM_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (storeFileEnv != null) signingConfig = signingConfigs.getByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    packaging { jniLibs { useLegacyPackaging = true } }

    lint {
        checkReleaseBuilds = false
        abortOnError = false
        checkOnly += setOf("NewApi", "InlinedApi", "MissingPermission", "WrongConstant", "ForegroundServiceType", "ForegroundServicePermission")
        textReport = true
        textOutput = file("stdout")
    }
}

dependencies {
    implementation("io.github.webrtc-sdk:android:144.7559.15")
}
