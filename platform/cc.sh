#!/bin/sh
# Compile a freestanding C program against the oxwasm platform ABI.
set -e
for src in "$@"; do
  clang --target=wasm32 -nostdlib -O2 -Wl,--no-entry -Wl,--export=_start \
        -o "${src%.c}.wasm" "$src"
  echo "built ${src%.c}.wasm"
done
