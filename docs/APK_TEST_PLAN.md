# APK test plan — Fire TV Stick 4K (AFTMM, Fire OS 6.7.1.1, API 25)

For whoever has adb and the physical device. This plan as a whole has not been run on a device — the
checklist's outcomes remain unverified until you run it.

Package: `com.everyoneisessential.tv` · Activity: `.MainActivity` · debug APK, debug keystore.

## 0. Build and install

```
npm ci                              # at the repo root, once (the APK build runs npm run build)
cd app/android
export JAVA_HOME=$(/usr/libexec/java_home -v 21)   # macOS only, see below
export ANDROID_HOME=<your Android SDK path>        # e.g. /opt/homebrew/share/android-commandlinetools
./gradlew assembleDebug
adb connect <stick-ip>:5555        # if not already connected
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.everyoneisessential.tv/.MainActivity
```

The build needs Node.js 22.18+ and npm (the repo's own `engines` floor), JDK 21 and an Android SDK.
`/usr/libexec/java_home -v 21` is macOS-only: it
prints the path of the JDK 21 installed on that machine. Anywhere else, set `JAVA_HOME` to
your own JDK 21 directory. `ANDROID_HOME` is wherever you installed the SDK — Android
Studio's default, or the command-line tools; `/opt/homebrew/share/android-commandlinetools`
is one example, the Homebrew path on an Apple-silicon Mac, not a requirement.

**What it looks like if it works:** the lobby screen ("The Locked Study") fills the whole TV, no
Android title bar or system chrome, landscape, room code visible top-left.

**What failure looks like:** `INSTALL_FAILED_*` from `adb install` (check
`adb shell getprop ro.build.version.sdk` really reads `25`, and that `app-debug.apk` exists — if
the build itself failed, `./gradlew assembleDebug` above is where the error is, and it prints it);
a black screen or an immediate crash (`adb logcat *:E | grep everyoneisessential` will show a
Kotlin exception, most likely from `EmbeddedServer` if port 8080 is already bound by something
else on the Stick — the WebView is pointed at that server, so a server that failed to start is a
blank page — or from the WebView if the page it loads from
`http://127.0.0.1:8080/tv/index.html` is missing, which means the asset copy in Gradle did not
run — check the APK for `assets/tv/index.html` with
`unzip -l app-debug.apk | grep tv/index.html`; the files ship under `assets/`, but they are served
over loopback rather than loaded as `file://`).

## 1. Full-screen WebView loading the built TV app

**Check:** the screen on launch matches what `npm run tv` + a browser shows on a laptop for the
same commit (same fonts, same layout, no browser UI at all).
**Works:** `adb shell dumpsys window | grep mCurrentFocus` names `MainActivity`; no title bar;
`adb logcat | grep chromium` shows the WebView loaded
`http://127.0.0.1:8080/tv/index.html` — served by the Stick's own embedded server, with
`?relay=…&base=…` when the Stick has a LAN address and `?nolan=1` when it does not. Never a
`file://` URL: a file origin cannot execute the built ES module, so the page would come up blank.
**Fails:** a stale UI (Gradle packaged an old `dist/`, i.e. the copy task did not rerun — rerun
`./gradlew clean assembleDebug`), or a blank/white screen (JS console error --
`adb logcat | grep -i "console"` — most likely the built page resolving its assets against the
wrong root, which the app/tv `vite.config.ts` `base: "./"` setting is supposed to prevent, or the
embedded server having failed to start, see §0).

## 2. Back key

This is the whole reason the APK wrapper exists: Web App Tester eats Back and kills the WebView, and
no in-page fix can prevent that.

- **Press Back once from the lobby** (nothing pending). **Works:** a "Leave?" prompt (Stay / Leave)
  appears on screen -- the app does not close, does not go black, does not return to the Fire TV
  home screen. **Fails:** the app exits immediately, or the Fire TV launcher reappears -- that means
  `MainActivity.onBackPressed()` did not intercept the key (check `adb logcat` for an unhandled
  `KEYCODE_BACK` or a crash in `evaluateJavascript`).
- **Press Back again while the prompt is open ("Stay" focused).** **Works:** nothing changes; the
  prompt is still open (the web app's own `keyIntent` "back" case treats a second Back as Stay).
- **Navigate to Leave and press the centre button.** **Works:** the app closes -- the Activity
  finishes and the Fire TV home screen (or the app switcher) reappears. Confirm in logcat: no crash,
  and (optionally) `adb shell dumpsys activity activities | grep everyoneisessential` shows the task
  gone. **This is the bridge working**: the page called `Android.leave()` through `MainActivity`'s
  `WebAppBridge` (a `@JavascriptInterface` that only calls `finish()` after the page's own confirmed
  Leave) -- if instead nothing happens on Leave, the bridge did not fire; check
  `adb logcat | grep WebAppBridge` for a `JavascriptInterface` error, and confirm the page's build
  actually has the `window.Android.leave()` call, in `app/tv/src/app.tsx`'s `activate("leave")`
  path.
- **Open a scan/option picker on a phone controller, then press Back on the TV remote.** **Works:**
  the picker closes; the app does not ask to leave and does not exit (unchanged existing behaviour
  in `app/tv/src/app.tsx`, exercised here only to confirm the Back bridge does not interfere with it).

## 3. Remote keys reach the page unchanged

With the lobby or a game screen on screen and a role slot or action focused:

- **DPAD arrows** move the on-screen focus ring between controls. **Fails:** focus does not move, or
  moves to something off-screen (an Android view, not a page element) -- check that
  `webView.requestFocus()` actually ran and the WebView has input focus
  (`adb shell dumpsys window | grep -A2 mCurrentFocus`).
- **Centre button (remote's Select, key 23)** activates whatever is focused, same as pressing Enter
  in a desktop browser. **Fails:** nothing happens on Select -- likely the WebView never got key
  focus, or a system dialog intercepted it.
- **Menu (82)** and **Play/Pause (85)**, if the current screen has a control bound to them (see
  `app/tv/src/remote.ts`), behave the same as the equivalent action on a laptop running the same
  build. If the current screen has nothing bound to them, **works** means nothing happens and the
  app does not crash or exit.
- **Confirm nothing else is consumed:** Home and the microphone/voice button still work as system
  keys (they cannot be intercepted by any app per Amazon's own docs, so this should be automatic,
  but worth a glance -- pressing Home should leave the app running in the background, not crash it).

## 4. Embedded server: phone page + relay, both on the Stick

- **On the lobby screen, read the on-screen address under the QR code.** **Works:** it is an
  `http://<stick's-own-LAN-IP>:8080/phone/#room=XXXX&relay=...` address -- the IP must be the
  Stick's, not a laptop's (cross-check with `adb shell ip addr show wlan0` or `Settings > My Fire TV
  > About > Network` on the Stick itself).
- **Scan the QR (or type the address) on a phone on the same Wi-Fi.** **Works:** the phone loads the
  controller page (no laptop involved anywhere) and, within a couple of seconds, the lobby's role
  slots show the phone joining. **Fails, and where to look:**
  - Phone gets "can't reach this page": the Stick's embedded HTTP server did not start (port 8080
    already in use, or `EmbeddedServer.start()` threw -- `adb logcat | grep EveryoneEssential`
    prints exactly this) -- or the phone is not actually on the same Wi-Fi/subnet as the Stick.
  - Phone loads the page but never appears in a role slot: the WebSocket relay did not connect --
    open the phone's browser dev console (remote-debug it, or just watch for a "relay: ..." status
    line if the phone UI shows one) for a failed `ws://` connection; confirm the Stick's
    `usesCleartextTraffic="true"` actually took (a targetSdk-34 app defaults to blocking cleartext,
    which is exactly what this flag is for -- if it is missing from the built manifest, the page
    would not load at all, because it is served over `http://127.0.0.1:8080` and its own
    `ws://`/`http://` calls to the relay would be blocked with it.
    `aapt2 dump badging app-debug.apk | grep cleartext` should show it.)
- **Join two phones to the same room, and watch a switch/turn happen.** **Works:** it looks the same
  as a laptop-hosted relay run of the same build -- confirms fan-out (`to: "all"` / `to: "tv"`
  routing) survived the port, not just the join path.

## 5. No-Wi-Fi lobby message

Hardest to stage without touching the Stick's network config, so this is optional but cheap to check
if you have a way to disconnect the Stick's Wi-Fi (or first-boot it before it has ever joined one):

**Works:** the lobby's QR area shows plain text ("This Fire TV Stick has no Wi-Fi or Ethernet address
right now — connect it to a network to add players.") instead of a QR code that cannot work.
**Fails:** a QR code renders anyway (pointing at nothing reachable) or the lobby shows
"starting the relay…" forever with no explanation.
**If you cannot disconnect Wi-Fi**, you can still sanity-check the mechanism from a laptop by opening
`app/tv/dist/index.html?nolan=1` in a browser after `npm run build` -- same code path, same message,
no device needed. That is not a substitute for the on-device check, only a way to confirm the text
and layout are right beforehand.

## 6. Screen stays awake during a game

**Check:** leave the app on screen (lobby or mid-game) for several minutes with no remote input.
**Works:** the screen never blanks/dims from Fire OS's own screensaver/sleep while this Activity is
in the foreground. **Fails:** the screen sleeps or the Fire TV screensaver kicks in --
`adb shell dumpsys power | grep -i "mWakefulness\|FLAG_KEEP_SCREEN_ON"` (or just
`adb shell dumpsys window windows | grep -i keepscreenon`) should show the flag set while this
Activity is the one on top.
