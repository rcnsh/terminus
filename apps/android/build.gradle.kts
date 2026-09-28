plugins {
    alias(libs.plugins.android.application) apply false
    // Pins the Kotlin version AGP's built-in Kotlin support uses.
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
