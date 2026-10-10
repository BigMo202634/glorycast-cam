# GloryCast Cam

Phones on the church Wi-Fi become wireless cameras for OBS and vMix. Part of GloryCast Tech.

GloryCast Cam stands alone. It is not part of GloryCast Live. GloryCast Switch finds the cameras
through OBS and reads their batteries from the media computer (`GET /cams`).

## What is here

| Folder | What it is |
| --- | --- |
| `app/` | The pages: `index.html` (media computer), `phone.html` (web camera for iPhone and Android), `view.html` (the picture OBS shows) |
| `server/` | The Node server that runs on the media computer (HTTP 7795, HTTPS 7796, finder on UDP 7797) |
| `android/` | The native Android camera app (Kotlin, WebRTC) |
| `mac/` | The Mac app's launcher, `Info.plist` and icon |
| `tests/` | End-to-end tests: web camera, server and OBS page (`e2e-cam.js`); the Mac app (`e2e-app.js`) |
| `tools/` | `mkzip.py` packs the parish download; `mac-app.sh` builds the Mac app; `mac-icon.js` makes its icon; `sign-apk.sh` signs the Android app |
| `README.txt` | The guide that ships inside the parish download |

## The parish download

The download is this repository's `app/`, `server/`, the two Start files and `README.txt`, plus a
`runtime/` folder holding Node for Windows, the signed Android app, and `GloryCast Cam.app` for the Mac
(`tools/mac-app.sh GloryCast-Cam` builds it with its own copy of `app/` and `server/`). Pack it with
`python3 tools/mkzip.py GloryCast-Cam GloryCast-Cam.zip` (the zip tool marks the Mac Start file and the
app's launcher as runnable).

## Mac app

`GloryCast Cam.app` opens with no Terminal window. Its launcher (a shell script) finds Node.js where the
installers put it and runs `server.js --app`, which starts the server in the background, opens the page,
and exits. Opening the app again only opens the page; a different version is asked to stop (`POST /quit`)
and replaced. Stop on the page (shown on the computer itself) ends the server. The app is not signed, so
macOS asks once before opening it.

## Android app

GitHub Actions builds it on every push that touches `android/` (workflow "Android app"). The
unsigned APK and a `version.txt` land on the `apk` branch and in the run's artifacts.

The signing key is never stored in this repository. It lives in the GloryCast project files
(`gcp/tech/glorycast-cam/android/signing/`). Sign a build with:

```sh
tools/sign-apk.sh GloryCast-Cam-unsigned.apk GloryCast-Cam.apk glorycast-cam.p12 keystore-password.txt
```

Every release must use that same key, or phones have to uninstall before updating.

The app talks to the same server as the web camera: it finds the media computer with a UDP
broadcast (`GLORYCAST-CAM?` on 7797), joins `/events?role=phone`, and sends its picture over WebRTC
to the OBS page. The picture is always landscape.

## Tests

```sh
npm install --no-save playwright   # once; uses the installed Chromium
node tests/e2e-cam.js
node tests/e2e-app.js
```
