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
        versionCode = 73
        versionName = "3.12.0"
    }

    flavorDimensions += "channel"
    productFlavors {
        create("stable") {
            dimension = "channel"
            site("https://terminus.run", "sh.rcn.terminus", "terminus")
        }
        create("beta") {
            dimension = "channel"
            applicationIdSuffix = ".beta"
            site("https://beta.terminus.run", "sh.rcn.terminus.beta", "terminus beta")
            providers.gradleProperty("betaVersion").orNull?.let { versionName = it }
            providers.gradleProperty("betaCode").orNull?.let { versionCode = it.toInt() }
        }
    }

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
    bundle {
        language { enableSplit = false }
    }
    val buildingBundle = gradle.startParameter.taskNames.any { it.contains("bundle", ignoreCase = true) }
    splits {
        abi {
            isEnable = !buildingBundle
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = false
        }
    }
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

val apiBase = providers.gradleProperty("apiBase").orNull

androidComponents {
    onVariants(selector().withBuildType("debug")) { variant ->
        if (apiBase != null) {
            variant.buildConfigFields?.put(
                "API_BASE",
                com.android.build.api.variant.BuildConfigField("String", "\"$apiBase\"", "-PapiBase"),
            )
        }
    }
}

fun com.android.build.api.dsl.ApplicationProductFlavor.site(site: String, packageName: String, name: String) {
    buildConfigField("String", "SITE", "\"$site\"")
    buildConfigField("String", "API_BASE", "\"$site\"")
    buildConfigField("String", "LINK_BASE", "\"$site\"")
    buildConfigField("String", "SERVERS", "\"$site\"")
    manifestPlaceholders["siteHost"] = site.removePrefix("https://")
    resValue("string", "app_name", name)
    for ((field, value) in firebaseConfig(project.file("google-services.json"), packageName)) buildConfigField(
        "String",
        field,
        "\"$value\"",
    )
}

fun firebaseConfig(json: File, packageName: String): Map<String, String> {
    val empty = mapOf("FIREBASE_APP_ID" to "", "FIREBASE_API_KEY" to "", "FIREBASE_PROJECT_ID" to "", "FIREBASE_SENDER_ID" to "")
    if (!json.exists()) return empty
    @Suppress("UNCHECKED_CAST") val root = groovy.json.JsonSlurper().parse(json) as Map<String, Any?>
    val project = root["project_info"] as Map<String, Any?>
    val client =
        (root["client"] as List<Map<String, Any?>>).firstOrNull {
            ((it["client_info"] as Map<String, Any?>)["android_client_info"] as Map<String, Any?>)["package_name"] == packageName
        } ?: return empty
    val values =
        mapOf(
                "FIREBASE_APP_ID" to (client["client_info"] as Map<String, Any?>)["mobilesdk_app_id"],
                "FIREBASE_API_KEY" to (client["api_key"] as List<Map<String, Any?>>?)?.firstOrNull()?.get("current_key"),
                "FIREBASE_PROJECT_ID" to project["project_id"],
                "FIREBASE_SENDER_ID" to project["project_number"],
            )
            .mapValues { it.value?.toString().orEmpty() }
    return if (values.values.any { it.isEmpty() }) empty else values
}

dependencyLocking {
    lockAllConfigurations()
}

tasks.withType<Test>().configureEach {
    inputs.dir(rootDir.resolve("../../fixtures")).withPathSensitivity(PathSensitivity.RELATIVE).withPropertyName("sharedFixtures")
    inputs.dir("src/main/res").withPathSensitivity(PathSensitivity.RELATIVE).withPropertyName("resources")
    inputs.dir("src/main/java").withPathSensitivity(PathSensitivity.RELATIVE).withPropertyName("sources")
}

configurations.configureEach {
    exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib-common")
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
    implementation(libs.androidx.fragment)
    testImplementation(libs.junit)
    testImplementation(libs.org.json)

    constraints {
        "androidLintTool"("org.bouncycastle:bcprov-jdk18on:1.87") {
            because("GHSA-9pwp-9qqc-pr26, GHSA-qp49-qgx5-5m26, GHSA-c3fc-8qff-9hwx")
        }
        "androidLintTool"("org.bouncycastle:bcpkix-jdk18on:1.87") { because("GHSA-wg6q-6289-32hp; matches bcprov") }
        "androidLintTool"("org.bouncycastle:bcutil-jdk18on:1.87") { because("matches bcprov") }
        "androidLintTool"("org.apache.commons:commons-lang3:3.22.0") { because("GHSA-j288-q9x7-2f5v") }
        "androidLintTool"("org.apache.httpcomponents:httpclient:4.5.14") { because("GHSA-7r82-7xv7-xcpj") }
    }
}

tasks.register("resolveAll") {
    description = "Resolves every resolvable configuration, to write gradle.lockfile and verification-metadata.xml."
    notCompatibleWithConfigurationCache("reads the project's configurations when it runs")
    doLast {
        configurations
            .filter { it.isCanBeResolved }
            .forEach { configuration ->
                val failed =
                    configuration.incoming.resolutionResult.allDependencies.filterIsInstance<
                        org.gradle.api.artifacts.result.UnresolvedDependencyResult
                    >()
                check(failed.isEmpty()) { "${configuration.name}: ${failed.joinToString { "${it.attempted}: ${it.failure.message}" }}" }
                configuration.incoming.artifactView { lenient(true) }.files.files
            }
    }
}

val ktfmt = configurations.create("ktfmt")

dependencies {
    ktfmt(libs.ktfmt)
}

fun registerKtfmt(name: String, description: String, vararg flags: String) =
    tasks.register<JavaExec>(name) {
        group = "formatting"
        this.description = description
        classpath = ktfmt
        mainClass.set("com.facebook.ktfmt.cli.Main")
        val sources =
            fileTree(rootDir) {
                include("**/*.kt", "**/*.kts")
                exclude("**/build/**", ".gradle/**", ".kotlin/**")
            }
        val options = listOf("--kotlinlang-style", "--enable-editorconfig", "--quiet") + flags
        argumentProviders.add(CommandLineArgumentProvider { options + sources.files.map { it.path }.sorted() })
    }

registerKtfmt("ktfmtFormat", "Formats the Kotlin sources and build scripts with ktfmt.")

registerKtfmt("ktfmtCheck", "Fails if ktfmtFormat would change a Kotlin file.", "--dry-run", "--set-exit-if-changed")
