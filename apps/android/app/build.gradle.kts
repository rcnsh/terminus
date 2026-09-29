plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "sh.rcn.terminus"
    compileSdk = 37

    defaultConfig {
        applicationId = "sh.rcn.terminus"
        minSdk = 31
        targetSdk = 37
        versionCode = 16
        versionName = "1.3.0"
        // `./gradlew -PapiBase=http://localhost:8787 installDebug` plus
        // `adb reverse tcp:8787 tcp:8787` points a debug build at a local wrangler dev.
        val apiBase = providers.gradleProperty("apiBase").orElse("https://terminus.rcn.sh").get()
        buildConfigField("String", "API_BASE", "\"$apiBase\"")
    }

    // The release key lives outside the repo: its path and passwords come
    // from ~/.gradle/gradle.properties (TERMINUS_*). Without them (anyone
    // else building from source) release builds fall back to the debug key.
    val keystore = providers.gradleProperty("TERMINUS_KEYSTORE").orNull
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = providers.gradleProperty("TERMINUS_KEYSTORE_PASSWORD").get()
                keyAlias = providers.gradleProperty("TERMINUS_KEY_ALIAS").get()
                keyPassword = providers.gradleProperty("TERMINUS_KEY_PASSWORD").get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.glance.appwidget)
    implementation(libs.glance.material3)
    implementation(libs.work.runtime)
}
