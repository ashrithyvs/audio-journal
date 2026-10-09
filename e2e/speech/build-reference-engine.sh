#!/usr/bin/env bash
# Builds the pinned whisper.cpp reference engine (host, Android x86_64, Android
# arm64-v8a) and downloads the pinned models into .cache/whisper. Everything is
# verified by SHA-256. Requires: curl, Ninja, the Android SDK (NDK 27.0.12077973
# and CMake 3.31.6), as described in docs/validation.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${AJ_WHISPER_DIR:-$here/.cache/whisper}"
sdk="${ANDROID_HOME:-$HOME/Android/Sdk}"
ndk="$sdk/ndk/27.0.12077973"
export PATH="$sdk/cmake/3.31.6/bin:$PATH"
archive_sha=ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720
revision=5359861c739e955e79d9a303bcbc70fb988958b1
declare -A models=(
  [tiny.en]=921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f
  [tiny.en-q5_1]=c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b
  [base.en]=a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002
  [base.en-q5_1]=4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f
)
mkdir -p "$out/models"
cd "$out"
if [ ! -d src ]; then
  curl -sSfL -o whisper.tar.gz https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.5.tar.gz
  echo "$archive_sha  whisper.tar.gz" | sha256sum -c -
  mkdir src && tar -xzf whisper.tar.gz -C src --strip-components 1
fi
common=(-G Ninja -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DBUILD_SHARED_LIBS=OFF -DGGML_OPENMP=OFF)
[ -x build-host/bin/whisper-cli ] || { cmake -S src -B build-host "${common[@]}" >/dev/null && cmake --build build-host --target whisper-cli >/dev/null; }
for abi in x86_64 arm64-v8a; do
  [ -x "build-$abi/bin/whisper-cli" ] && continue
  cmake -S src -B "build-$abi" "${common[@]}" -DCMAKE_TOOLCHAIN_FILE="$ndk/build/cmake/android.toolchain.cmake" \
    -DANDROID_ABI="$abi" -DANDROID_PLATFORM=android-26 >/dev/null
  cmake --build "build-$abi" --target whisper-cli >/dev/null
done
for model in "${!models[@]}"; do
  file="models/ggml-$model.bin"
  if [ ! -f "$file" ] || ! echo "${models[$model]}  $file" | sha256sum -c --status -; then
    curl -sSfL -o "$file" "https://huggingface.co/ggerganov/whisper.cpp/resolve/$revision/ggml-$model.bin"
    echo "${models[$model]}  $file" | sha256sum -c -
  fi
done
echo "reference engine ready in $out"
