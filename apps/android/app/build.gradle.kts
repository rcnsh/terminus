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
        versionCode = 54
        versionName = "2.4.2"
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
    // from ~/.gradle/gradle.properties (TERMINUS_*). Without them (CI, or
    // anyone else building from source) release builds come out unsigned
    // (app-*-release-unsigned.apk), never signed with the debug key, so a
    // build that missed the key can't pass for a release.
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
            signingConfig = signingConfigs.findByName("release")
        }
    }
    // Chinese can be chosen in the app, whatever the phone's language,
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

// `-PapiBase` points a debug build's API elsewhere: `./gradlew
// -PapiBase=http://localhost:8787 installStableDebug` plus `adb reverse
// tcp:8787 tcp:8787` uses the dev stub. Debug builds only, so a stray
// property (say, in ~/.gradle/gradle.properties) can never ship a release
// that talks to a laptop.
val apiBase = providers.gradleProperty("apiBase").orNull
androidComponents {
    onVariants(selector().withBuildType("debug")) { variant ->
        if (apiBase != null) {
            variant.buildConfigFields?.put("API_BASE", com.android.build.api.variant.BuildConfigField("String", "\"$apiBase\"", "-PapiBase"))
        }
    }
}

/**
 * One channel's site and name. SITE is where links go (the account page,
 * pairing QR codes); API_BASE is the same, except in a debug build given
 * `-PapiBase` (above).
 */
fun com.android.build.api.dsl.ApplicationProductFlavor.site(site: String, packageName: String, name: String) {
    buildConfigField("String", "SITE", "\"$site\"")
    buildConfigField("String", "API_BASE", "\"$site\"")
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

// Every configuration's resolved versions are pinned in gradle.lockfile, so
// a dependency can't change under a build without a diff to review. After
// changing a version, write it again with the commands in the README.
dependencyLocking {
    lockAllConfigurations()
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

    // Lint runs from its own classpath, which brings in older versions of
    // these, each with a published advisory; as for the plugins' classpath in
    // ../build.gradle.kts, lint runs with the fixed ones.
    constraints {
        "androidLintTool"("org.bouncycastle:bcprov-jdk18on:1.85") { because("GHSA-9pwp-9qqc-pr26, GHSA-qp49-qgx5-5m26, GHSA-c3fc-8qff-9hwx") }
        "androidLintTool"("org.bouncycastle:bcpkix-jdk18on:1.85") { because("GHSA-wg6q-6289-32hp; matches bcprov") }
        "androidLintTool"("org.bouncycastle:bcutil-jdk18on:1.85") { because("matches bcprov") }
        "androidLintTool"("org.apache.commons:commons-lang3:3.18.0") { because("GHSA-j288-q9x7-2f5v") }
        "androidLintTool"("org.apache.httpcomponents:httpclient:4.5.14") { because("GHSA-7r82-7xv7-xcpj") }
    }
}

// Resolves every configuration of the app, for `--write-locks` and
// `--write-verification-metadata` (see the README): the build tasks alone
// leave many unresolved (the other variants', the Android tests').
tasks.register("resolveAll") {
    description = "Resolves every resolvable configuration, to write gradle.lockfile and verification-metadata.xml."
    notCompatibleWithConfigurationCache("reads the project's configurations when it runs")
    doLast {
        configurations.filter { it.isCanBeResolved }.forEach { configuration ->
            val failed = configuration.incoming.resolutionResult.allDependencies
                .filterIsInstance<org.gradle.api.artifacts.result.UnresolvedDependencyResult>()
            check(failed.isEmpty()) { "${configuration.name}: ${failed.joinToString { "${it.attempted}: ${it.failure.message}" }}" }
            // The files too, so their checksums are written; lenient because
            // some configurations hold more than one kind of artefact.
            configuration.incoming.artifactView { lenient(true) }.files.files
        }
    }
}
