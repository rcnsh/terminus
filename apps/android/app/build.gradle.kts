plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "sh.rcn.nusbus"
    compileSdk = 37

    defaultConfig {
        applicationId = "sh.rcn.nusbus"
        minSdk = 31
        targetSdk = 37
        versionCode = 4
        versionName = "0.1.3"
        // `./gradlew -PapiBase=http://localhost:8787 installDebug` plus
        // `adb reverse tcp:8787 tcp:8787` points a debug build at a local wrangler dev.
        val apiBase = providers.gradleProperty("apiBase").orElse("https://nusbus.rcn.sh").get()
        buildConfigField("String", "API_BASE", "\"$apiBase\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            // Sideloaded personal builds: the debug key is enough. Swap in a
            // real key before this goes anywhere near a store.
            signingConfig = signingConfigs.getByName("debug")
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
