#!/bin/sh
# Build the native reference binaries the AOT demo compiles and benchmarks
# against. Needs clang and wabt (wat2wasm). Run once, then: node bench-all.mjs
set -e
cd "$(dirname "$0")"
echo "building md5-native..."
clang -O2 -fcf-protection=none -static md5.c md5_main.c -o md5-native
echo "building kernels_s (scalar) -> /tmp/kernels_s ..."
clang -O2 -fno-vectorize -fno-slp-vectorize -fcf-protection=none -static \
      kernels.c kernels_main.c -o /tmp/kernels_s
echo "building md5-fromsrc.wasm (the wasm ceiling) ..."
clang --target=wasm32 -O3 -nostdlib -Wl,--no-entry -Wl,--export-all \
      md5.c -o md5-fromsrc.wasm 2>/dev/null || echo "  (optional; skip if wasm target missing)"
echo "done. now: node bench-all.mjs   (needs wat2wasm on PATH)"
