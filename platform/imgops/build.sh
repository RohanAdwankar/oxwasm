#!/bin/sh
# Build the generic resampler: native (for the parity baseline) and wasm.
set -e
cd "$(dirname "$0")"
clang -O3 -o resample-native resample.c native-main.c -lm
clang -O3 -march=native -o resample-native-avx resample.c native-main.c -lm
clang --target=wasm32 -O3 -msimd128 -mrelaxed-simd -ffp-contract=fast \
      -nostdlib -Wl,--no-entry -Wl,-z,stack-size=65536 -o resample-relaxed.wasm resample.c
python3 mkdemo.py
echo "run: ./resample-native 2048 8192   |   node run-wasm.mjs 2048 8192   |   open imgops-demo.html"
