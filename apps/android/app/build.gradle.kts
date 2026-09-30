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
        versionCode = 32
        versionName = "2.0.0-beta.6"
        // `./gradlew -PapiBase=http://localhost:8787 installDebug` plus
        // `adb reverse tcp:8787 tcp:8787` points a debug build at a local wrangler dev.
        val apiBase = providers.gradleProperty("apiBase").orElse("https://terminus.rcn.sh").get()
        buildConfigField("String", "API_BASE", "\"$apiBase\"")
        // Push: the Firebase app from google-services.json (not in git; see
        // apps/android/README.md). Without it the fields are empty and the app
        // keeps its own alarms and refresh, as on a phone without Play services.
        val firebase = firebaseConfig(file("google-services.json"))
        for ((name, value) in firebase) buildConfigField("String", name, "\"$value\"")
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

/** FIREBASE_* values for BuildConfig, empty strings when there's no config file. */
fun firebaseConfig(json: File): Map<String, String> {
    val empty = mapOf("FIREBASE_APP_ID" to "", "FIREBASE_API_KEY" to "", "FIREBASE_PROJECT_ID" to "", "FIREBASE_SENDER_ID" to "")
    if (!json.exists()) return empty
    @Suppress("UNCHECKED_CAST")
    val root = groovy.json.JsonSlurper().parse(json) as Map<String, Any?>
    val project = root["project_info"] as Map<String, Any?>
    val client = (root["client"] as List<Map<String, Any?>>).first {
        ((it["client_info"] as Map<String, Any?>)["android_client_info"] as Map<String, Any?>)["package_name"] == "sh.rcn.terminus"
    }
    return mapOf(
        "FIREBASE_APP_ID" to (client["client_info"] as Map<String, Any?>)["mobilesdk_app_id"].toString(),
        "FIREBASE_API_KEY" to ((client["api_key"] as List<Map<String, Any?>>).first())["current_key"].toString(),
        "FIREBASE_PROJECT_ID" to project["project_id"].toString(),
        "FIREBASE_SENDER_ID" to project["project_number"].toString(),
    )
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
    implementation(libs.zxing.core)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    testImplementation(libs.junit)
    testImplementation(libs.org.json)
}
