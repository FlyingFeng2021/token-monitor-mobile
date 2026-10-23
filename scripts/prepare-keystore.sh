#!/usr/bin/env bash
# Prepare android/app/release.keystore for signed APK builds.
#
# Priority:
#   1. KEYSTORE_BASE64 env (repo secret)  -> decode to release.keystore
#   2. existing release.keystore          -> restored by actions/cache, keep it
#   3. none of the above                  -> generate once; cache makes it persist
#                                            across builds so APK signature stays
#                                            stable and updates install cleanly.
#
# Passwords are overridable via KEYSTORE_PASSWORD / KEY_ALIAS / KEY_PASSWORD
# (see app/build.gradle); defaults match the generated keystore below.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p android/app

if [ -n "${KEYSTORE_BASE64:-}" ]; then
  printf '%s' "$KEYSTORE_BASE64" | base64 -d > android/app/release.keystore
  echo "signing: keystore decoded from KEYSTORE_BASE64 secret"
elif [ -f android/app/release.keystore ]; then
  echo "signing: keystore restored from actions/cache"
else
  keytool -genkeypair -v \
    -keystore android/app/release.keystore \
    -storepass tokenmonitor -keypass tokenmonitor \
    -alias tokenmonitor -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Token Monitor, OU=Personal, O=Token Monitor" > /dev/null 2>&1
  echo "signing: generated new keystore (actions/cache keeps it stable across builds)"
fi
