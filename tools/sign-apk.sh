#!/bin/sh
# Sign the unsigned GloryCast Cam APK that GitHub builds (the apk branch).
#   tools/sign-apk.sh GloryCast-Cam-unsigned.apk GloryCast-Cam.apk KEYSTORE.p12 PASSWORD_FILE
# The key and its password live in the GloryCast project files, never in this repository.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=${TMPDIR:-/tmp}/gccam-apksign
mkdir -p "$work"
jar="$work/apksig-2.3.0.jar"
if [ ! -f "$jar" ]; then
  curl -sSfL -o "$jar" https://repo1.maven.org/maven2/com/android/tools/build/apksig/2.3.0/apksig-2.3.0.jar
fi
got=$(sha1sum "$jar" | cut -d' ' -f1)
[ "$got" = "6ef7a58375aa68fb492b58edd97607bee8ee5c5c" ] || { echo "apksig download does not match the known copy" >&2; rm -f "$jar"; exit 1; }
javac -d "$work" -cp "$jar" "$here/apksign/Sign.java"
java -cp "$work:$jar" Sign "$3" "$4" glorycast-cam "$1" "$2"
