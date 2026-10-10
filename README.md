# GloryCast Cam

Phones on the church Wi-Fi become wireless cameras for OBS and vMix. Part of GloryCast Tech.

GloryCast Cam stands alone. It is not part of GloryCast Live, and it reaches GloryCast Switch
only through OBS.

## What is here

| Folder | What it is |
| --- | --- |
| `app/` | The pages: `index.html` (media computer), `phone.html` (web camera for iPhone and Android), `view.html` (the picture OBS shows) |
| `server/` | The Node server that runs on the media computer (HTTP 7795, HTTPS 7796, finder on UDP 7797) |
| `android/` | The native Android camera app (Kotlin, WebRTC) |
| `tests/` | End-to-end test of the web camera, server and OBS page |
| `tools/` | `mkzip.py` packs the parish download; `sign-apk.sh` signs the Android app |
| `README.txt` | The guide that ships inside the parish download |

## The parish download

The download is this repository's `app/`, `server/`, the two Start files and `README.txt`, plus a
`runtime/` folder holding Node for Windows. Pack it with `python3 tools/mkzip.py GloryCast-Cam GloryCast-Cam.zip`
(the zip tool marks the Mac Start file as runnable).

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
```
