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
        versionCode = 46
        versionName = "2.2.1"
    }

    // Two apps from one source: stable (sh.rcn.terminus, Google Play and the
    // website) and beta (sh.rcn.terminus.beta, beta.terminus.rcn.sh). They
    // install side by side; each talks to its own site, with its own accounts.
    flavorDimensions += "channel"
    productFlavors {
        create("stable") {
            dimension = "channel"
            site("https://terminus.rcn.sh", "sh.rcn.terminus", "terminus")
        }
        create("beta") {
            dimension = "channel"
            applicationIdSuffix = ".beta"
            site("https://beta.terminus.rcn.sh", "sh.rcn.terminus.beta", "terminus beta")
            // Its own version line, from scripts/release-beta.sh: the next
            // stable version's pre-release (2.0.1-beta.3), numbered by commit.
            providers.gradleProperty("betaVersion").orNull?.let { versionName = it }
            providers.gradleProperty("betaCode").orNull?.let { versionCode = it.toInt() }
        }
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
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }
    // Chinese can be chosen in the app (phase 10), whatever the phone's language,
    // so Play must not leave it out of an English phone's download.
    bundle {
        language { enableSplit = false }
    }
    // One APK per CPU type for the website and GitHub (MapLibre's native code
    // is about 4.5 MB per type, compressed); Play builds from the bundle and
    // splits by itself. MapLibre ships arm64, 32-bit ARM and x86_64 (emulators).
    // Off when building the bundle: AGP refuses a bundle while splits are on,
    // so release.sh builds the APKs and the bundle in separate runs.
    val buildingBundle = gradle.startParameter.taskNames.any { it.contains("bundle", ignoreCase = true) }
    splits {
        abi {
            isEnable = !buildingBundle
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = false
        }
    }
    // Native code compressed in the APK: a third the size, unpacked on install.
    packaging {
        jniLibs { useLegacyPackaging = true }
    }
    buildFeatures {
        compose = true
        buildConfig = true
        resValues = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

/**
 * One channel's site and name. SITE is where links go (the account page,
 * pairing QR codes); API_BASE is the same unless `-PapiBase` points a debug
 * build elsewhere: `./gradlew -PapiBase=http://localhost:8787
 * installStableDebug` plus `adb reverse tcp:8787 tcp:8787` uses the dev stub.
 */
fun com.android.build.api.dsl.ApplicationProductFlavor.site(site: String, packageName: String, name: String) {
    buildConfigField("String", "SITE", "\"$site\"")
    val apiBase = project.providers.gradleProperty("apiBase").orElse(site).get()
    buildConfigField("String", "API_BASE", "\"$apiBase\"")
    manifestPlaceholders["siteHost"] = site.removePrefix("https://")
    resValue("string", "app_name", name)
    // Push: this package's Firebase app from google-services.json (not in
    // git; see apps/android/README.md). Without it the fields are empty and
    // the app keeps its own alarms and refresh, as on a phone without Play services.
    for ((field, value) in firebaseConfig(project.file("google-services.json"), packageName)) buildConfigField("String", field, "\"$value\"")
}

/** FIREBASE_* values for BuildConfig, empty strings when there's no config file or no app for the package in it. */
fun firebaseConfig(json: File, packageName: String): Map<String, String> {
    val empty = mapOf("FIREBASE_APP_ID" to "", "FIREBASE_API_KEY" to "", "FIREBASE_PROJECT_ID" to "", "FIREBASE_SENDER_ID" to "")
    if (!json.exists()) return empty
    @Suppress("UNCHECKED_CAST")
    val root = groovy.json.JsonSlurper().parse(json) as Map<String, Any?>
    val project = root["project_info"] as Map<String, Any?>
    val client = (root["client"] as List<Map<String, Any?>>).firstOrNull {
        ((it["client_info"] as Map<String, Any?>)["android_client_info"] as Map<String, Any?>)["package_name"] == packageName
    } ?: return empty
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
    implementation(libs.maplibre.compose)
    runtimeOnly(libs.maplibre.compose.runtime)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    testImplementation(libs.junit)
    testImplementation(libs.org.json)
}
