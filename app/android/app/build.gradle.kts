plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.everyoneisessential.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.everyoneisessential.tv"
        // Fire TV Stick 4K 1st gen (AFTMM) is Fire OS 6.7.1.1 = Android 7.1.2 = API 25.
        // That is the only device this app targets; nothing here may need a higher
        // platform API at runtime.
        minSdk = 25
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.6.1")

    // Embedded HTTP + WebSocket server, entirely on the Stick: serves the phone
    // controller page and runs the relay, so nothing on a laptop is needed. Pure
    // Java, no dependency on any Android API above the platform's own (works back
    // to Android 2.3 by NanoHTTPD's own compatibility claims) -- picked over
    // alternatives (ktor-server, java-websocket + a hand-rolled HTTP server)
    // specifically because it is one small jar with a WebSocket server
    // (NanoWSD) already built on the same HTTP server, so one embedded port
    // does both jobs.
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    implementation("org.nanohttpd:nanohttpd-websocket:2.3.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

/* ------------------------------------------------------------------ */
/* Ship the current web UI: build app/tv and app/phone with npm, then  */
/* MIRROR their dist/ output into this module's assets.                */
/*                                                                      */
/* `Sync`, not `Copy`. A `Copy` only ever adds: Vite emits hashed       */
/* filenames and clears its own dist/, but the assets directory kept    */
/* every bundle ever built: three JS bundles                            */
/* and three stylesheets staged where there should be one of each, plus */
/* their source maps -- dead weight the APK carries onto a device with  */
/* ~94 MB free, and, far worse, a standing invitation to debug a stale  */
/* UI on the television. `Sync` deletes whatever is not in the source.  */
/* ------------------------------------------------------------------ */

val repoRoot = rootProject.projectDir.parentFile.parentFile

val npmBuildWebApps = tasks.register<Exec>("npmBuildWebApps") {
    description = "Builds app/tv and app/phone (npm run build) so their dist/ output is current."
    workingDir = repoRoot
    commandLine("npm", "run", "build")
    inputs.dir(File(repoRoot, "app/tv/src"))
    inputs.dir(File(repoRoot, "app/tv/public"))
    inputs.dir(File(repoRoot, "app/phone/src"))
    inputs.dir(File(repoRoot, "app/shared"))
    outputs.dir(File(repoRoot, "app/tv/dist"))
    outputs.dir(File(repoRoot, "app/phone/dist"))
}

val copyTvAssets = tasks.register<Sync>("copyTvAssets") {
    dependsOn(npmBuildWebApps)
    from(File(repoRoot, "app/tv/dist"))
    into(layout.projectDirectory.dir("src/main/assets/tv"))
}

val copyPhoneAssets = tasks.register<Sync>("copyPhoneAssets") {
    dependsOn(npmBuildWebApps)
    from(File(repoRoot, "app/phone/dist"))
    into(layout.projectDirectory.dir("src/main/assets/phone"))
}

tasks.named("preBuild") {
    dependsOn(copyTvAssets, copyPhoneAssets)
}
