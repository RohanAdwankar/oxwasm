# oxwasm imgops — the M4 lane, applied to a big resample

A generic image-ops library (nothing app-specific): separable bicubic
(Catmull-Rom) RGBA8 resample in one C file that compiles **natively and to
WebAssembly** (SIMD128 + relaxed FMA) with bit-identical output — the same
checksum from both builds, every size tested.

```
$ ./build.sh
$ ./resample-native 2048 8192      # native, in-process best-of-4
$ node run-wasm.mjs 2048 8192      # the same C as wasm, same protocol
$ open imgops-demo.html            # the op running live in a tab
```

## Measured (2048×2048 → 8192×8192, 268 MB output, single-threaded, warm)

| runner | time | note |
|---|---|---|
| native GIMP 2.8 (`gimp-image-scale`, cubic) | **30.4 s** | the app's own implementation |
| **this kernel as wasm, in the browser** | **1.3–1.5 s** | SIMD128 + relaxed FMA, bit-exact |
| this kernel native (clang -O3) | 0.31 s | same C, host codegen |
| this kernel native (clang -O3 -march=native) | 0.22 s | AVX2+FMA, 256-bit |

Two honest readings, both true:

- **Against native GIMP — the app a user actually runs — the browser does the
  big resample ~20x faster.** GIMP 2.8's scale is generic scalar C; a wasm
  kernel with 128-bit SIMD beats it decisively. This is the M4 thesis in
  practice: recompile the compute, and the browser is not the slow platform.
- **Against the best hand-built native code, wasm holds a 4–6x gap** — wasm
  SIMD is capped at 128-bit lanes while the host has 256-bit AVX2+FMA. That
  is the ISA gap, not codegen sloppiness: the same C, the same explicit
  vector shapes, on both targets.

What made the wasm side fast (all in `resample.c`, all portable): separable
two-pass structure, precomputed weight/tap tables, explicit `f32x4` vectors
(`__builtin_convertvector` for u8↔f32, compare+mask clamps — no libcalls),
4-wide unrolling, relaxed-SIMD FMA (kept only because the checksum stayed
bit-identical), and a warm-up loop so V8 tiers before the timed call.

The emulated path (running GIMP's own binary under v86) does this op in
~127 s — see `../../docs/performance.md`. Emulation is for *compatibility*;
compute belongs on the recompile lane. `demo-template.html`/`mkdemo.py`
build the in-browser demo; the side-by-side race video is produced by the
harness in `../../demo/`.
