# Performance — measured, and the honest ceiling

## The numbers (GIMP 2.8, this project's test case)

| path | time to GIMP usable | vs native |
|---|---|---|
| native i386 GIMP (host CPU, chroot) | ~1.6 s warm, ~4 s cold | 1x |
| browser, cold boot (Linux + X + GIMP) | ~120–160 s | ~40–90x |
| browser, **snapshot restore** (state-only, 269 MB) | ~73 s, of which **restore compute ≈ 6 s** | — |

Measured with headless Chromium via `tools/snapshot.js` and the timing
harness. Cold-boot numbers vary with host load (X came up in 15 s idle,
44 s under this session's parallel builds).

## Why 1.2x native is not reachable by optimizing the emulator

An emulator executes a guest instruction by translating it — every `add`,
every memory access, goes through v86's x86→WASM machinery. That overhead is
**irreducible**: no amount of tuning removes the translation, so v86 runs at
roughly 30–100x native and the best JIT emulators (including the proprietary
CheerpX) land in the low single-to-double digits, never at 1.2x. 1.2x is not
an optimization target on the emulation path; it is a different architecture.

Near-native genuinely requires one of:

- **M3 — the x86-64→WASM JIT** (`engine/`): translate each hot code block
  once and reuse it. Gets to single-digit x native. The foundation is built
  and hardware-verified; the hot-path coverage is the remaining work.
- **M4 — the recompile lane** (`platform/`): compile the *application* to
  WASM so it runs as native WebAssembly with no per-instruction translation.
  Near-native, no emulator in the path. This is the multi-year effort.

## What snapshot-restore does, and does not, fix

It fixes **startup**, decisively, by refusing to pay it. `pack-app.sh
--snapshot` boots the app once at build time, freezes the whole v86 machine
(RAM + devices + disk) with `save_state`, and ships that. Opening the HTML
*restores* — GIMP is on screen without booting Linux, starting X, or
launching GIMP. Restore compute is ~6 s regardless of how slow the emulator
is, because none of the boot work runs.

The catch is delivery: the frozen state is large (a 256 MB-RAM GIMP snapshot
is ~200 MB gzipped), and in a single self-contained HTML that means the
browser base64-decodes and gunzips ~269 MB before restoring — that decode,
not emulation, is now the ~67 s that dominates. Served as a separate
streamed asset over HTTP (instead of inlined in one file), that same state
loads in seconds. So snapshot startup is a *file-delivery* problem now, not
an emulation one.

It does **not** speed up the running app. Once GIMP is up, painting and
filters run at emulated speed; only M3/M4 change that. Snapshot is the right
answer for "make it start fast"; the JIT is the answer for "make it *run*
fast."

## The JIT vs native — measured (`engine/diff/bench.mjs`)

The same 16-op integer block, run 5M times with a per-iteration input so the
work genuinely executes each pass:

| path | ns/run | vs native |
|---|---|---|
| native (gcc -O2) | 1.9 | 1.0x |
| **tier-1 JIT** (compiled to wasm) | 78.9 | **~40x** |
| tier-0 interpreter (BigInt) | 21432 | ~11000x |

So the JIT is **~270x faster than the interpreter** already, and lands ~40x
native for a first, un-optimized code generator. The 40x is almost entirely
overhead *around* the work, not the work: every block entry crosses the
JS↔WASM boundary and reloads all 16 guest registers from linear memory, then
stores them back. The 16 ALU ops themselves are a few ns.

The path from ~40x toward single-digit x is the standard one, and it's what
the next engine iterations do: compile a whole hot loop into one wasm
function with the guest registers held in **wasm locals** (loaded once,
stored once) and the loop body — including its backward branch — inside
wasm, so the boundary is crossed once per loop instead of once per
iteration. That removes both overhead sources the benchmark exposes.

### The superblock loop JIT reaches it (`engine/diff/bench2.mjs`)

Compiling a whole hot loop into one wasm function — guest registers in wasm
locals, the loop and its backward branch inside wasm, boundary crossed once —
does exactly what the analysis predicted. Same loop, 50M iterations:

| path | ns/iter | vs native |
|---|---|---|
| native (gcc -O2) | 1.22 | 1.0x |
| **superblock JIT** | 2.76 | **2.3x** |
| tier-0 interpreter | 8802 | ~7200x |

**2.3x native**, byte-exact with native, and **3193x faster than the
interpreter** — verified against the tier-0 oracle on real loops
(`diff/looptest.mjs`). That is the realistic JIT destination reached: low
single-digit x native on the tight loops that dominate hot paths.

The residual gap from 2.3x toward 1.2x is the wasm engine not optimizing a
tiny hand-emitted function as hard as gcc -O2 (no cross-loop register
allocation, cold tier). Closing it further is register allocation and letting
V8 tier the wasm up — real work, diminishing returns. And 1.2x for *emulated*
code is essentially the theoretical floor even the proprietary CheerpX does
not reliably hit; the guaranteed route to literal 1.2x is the M4 recompile
lane (compile the app itself to WASM, no emulator in the path), not the JIT.
Stated plainly so the target picks the right architecture.

## Build-time optimizations already applied

- **WARM cache freeze** (`pack-app.sh` WARM hook): the app's first-run work —
  GIMP's 184-plugin query, config generation — is run once in the build
  chroot and frozen into the image. ~13% off cold GIMP launch; larger on an
  unloaded host. Process spawns are the single priciest thing under
  emulation, so precomputing them is pure win.
- **fontconfig / gdk-pixbuf / icon caches** warmed in the chroot at build.
- **doc/locale/theme pruning** to shrink the image and the eventual snapshot.
