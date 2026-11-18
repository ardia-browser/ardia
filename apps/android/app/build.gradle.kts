plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

data class ArdiaRelease(val versionName: String, val versionCode: Int)

fun ardiaRelease(version: String?): ArdiaRelease {
    if (version == null) return ArdiaRelease("dev", 1)
    val match = Regex("""^([0-9]+)\.([0-9]+)\.([0-9]+)(-nightly\.([0-9]+))?$""").matchEntire(version)
        ?: throw GradleException("ardiaVersion '$version' is neither a stable version (0.2.47) nor a nightly (0.2.47-nightly.2)")
    val major = match.groupValues[1].toInt()
    val minor = match.groupValues[2].toInt()
    val patch = match.groupValues[3].toInt()
    val nightly = match.groupValues[5].takeIf { it.isNotEmpty() }?.toInt()
    if (major > 20 || minor > 99 || patch > 999) {
        throw GradleException("ardiaVersion '$version' needs major 20 or less, minor 99 or less and patch 999 or less, to fit versionCode")
    }
    if (nightly != null && (nightly < 1 || nightly > 998)) {
        throw GradleException("ardiaVersion '$version' needs a nightly number from 1 to 998")
    }
    val code = major * 100_000_000 + minor * 1_000_000 + patch * 1_000 + (nightly ?: 999)
    return ArdiaRelease(version, code)
}

val ardiaBuild = ardiaRelease(providers.gradleProperty("ardiaVersion").orNull)

android {
    namespace = "com.ardia.browser.android"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "com.ardia.browser.android"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = ardiaBuild.versionCode
        versionName = ardiaBuild.versionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testInstrumentationRunnerArguments["useTestStorageService"] = "true"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    implementation(project(":appmodel"))
    implementation(project(":search"))
    implementation(project(":browsing"))
    implementation(project(":tabs"))
    implementation(project(":settings"))
    implementation(platform(libs.compose.bom))
    implementation(libs.activity.compose)
    implementation(libs.coroutines.android)
    implementation(libs.splashscreen)
    implementation(libs.glance.appwidget)
    implementation(libs.work.runtime)
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.coroutines.test)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.test.services.storage)
    androidTestImplementation(libs.coroutines.test)
    androidTestUtil(libs.androidx.test.services)
    debugImplementation(libs.compose.ui.test.manifest)
}
