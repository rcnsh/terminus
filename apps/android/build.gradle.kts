buildscript {
    dependencies {
        constraints {
            classpath("org.bouncycastle:bcprov-jdk18on:1.87") { because("GHSA-9pwp-9qqc-pr26, GHSA-qp49-qgx5-5m26, GHSA-c3fc-8qff-9hwx") }
            classpath("org.bouncycastle:bcpkix-jdk18on:1.87") { because("GHSA-wg6q-6289-32hp; matches bcprov") }
            classpath("org.bouncycastle:bcutil-jdk18on:1.87") { because("matches bcprov") }
            classpath("org.bitbucket.b_c:jose4j:0.9.7") { because("GHSA-3677-xxcr-wjqv") }
            classpath("org.jdom:jdom2:2.0.6.1") { because("GHSA-2363-cqg2-863c") }
            classpath("org.apache.commons:commons-lang3:3.22.0") { because("GHSA-j288-q9x7-2f5v") }
        }
    }
    configurations.classpath {
        resolutionStrategy.activateDependencyLocking()
    }
}

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
