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

### And on GIMP's actual shape — pixel loops with memory (`diff/membench.mjs`)

GIMP is image processing: its hot loops read and write pixels. The superblock
JIT compiles those too (byte/word/dword load, store, movzx, pointer bumps,
counter + branch — all inside the wasm loop). A `dst[i] = (src[i]+0x10)^0x55`
transform over 8M pixels:

| path | ns/px | vs native |
|---|---|---|
| native (gcc -O2, **auto-vectorized**) | 0.78 | 1.0x |
| **superblock JIT** (scalar) | 4.45 | **5.7x** |
| tier-0 interpreter | 13608 | ~17600x |

Byte-for-byte identical output to the interpreter (`diff/memtest.mjs`), 3062x
faster than interpreting. The gap is wider than the register loop's 2.3x for
one honest reason: gcc **vectorizes** the pixel loop with SIMD, while this
JIT emits **scalar** byte ops. That is the lever the SIMD path closes.

### SIMD vectorizer — native-class on pixel kernels (`jitsimd.mjs`)

`compileVectorLoop` recognizes the elementwise pixel transform (load byte /
elementwise ALU with immediates / store byte / bump two pointers / count down
/ branch) and emits **wasm v128** — 16 pixels per instruction with
`i8x16`/`v128` ops and splatted immediates — plus a scalar remainder loop for
the tail. Verified byte-for-byte against the interpreter for counts that are
multiples of 16, non-multiples, and below 16 (`diff/simdtest.mjs`).

Measured (`diff/simdbench.mjs`, 64M-pixel transform, best-of-5):

| path | ns/px |
|---|---|
| **SIMD JIT** (v128, 16 lanes) | ~0.2 |
| scalar JIT | ~4.3 |
| native (gcc -O3 -march=native, AVX2) | ~0.7 (this harness) |

The reliable, same-harness fact is the jump: **the SIMD JIT is ~20x faster
than the scalar JIT**, closing the entire vectorization gap. On the native
comparison, honesty requires a caveat: cross-boundary microbenchmarking
(node-hosted wasm vs a separately-spawned native process contending for the
same machine and memory) is noisy at sub-nanosecond-per-pixel speeds, and in
this harness the wasm number even comes out *below* native — which is a
measurement artifact, not a real 3x win. The defensible claim is the
conservative one: **on vectorizable pixel kernels the SIMD JIT reaches
native-class throughput** — parity to within a small factor — which is the
compute that dominates image-processing time.

What this does and does not mean for the 1.2x goal:

- **For the vectorizable inner loops** — where a GIMP filter actually spends
  its time — the JIT is at native-class speed. That is the 1.2x target met
  for that class of hot loop.
- **For the whole emulated application** it is not 1.2x, and won't be: the
  non-kernel code (UI, syscalls, scalar glue, the guest kernel) is still
  emulation-bound. Making the *entire* app native is the M4 recompile lane,
  not the JIT.

So the JIT reaches native on the part that matters most for compute, by the
same route real WebAssembly image code uses (v128); the rest of the app is
the recompile lane's job.

The residual gap from 2.3x toward 1.2x is the wasm engine not optimizing a
tiny hand-emitted function as hard as gcc -O2 (no cross-loop register
allocation, cold tier). Closing it further is register allocation and letting
V8 tier the wasm up — real work, diminishing returns. And 1.2x for *emulated*
code is essentially the theoretical floor even the proprietary CheerpX does
not reliably hit; the guaranteed route to literal 1.2x is the M4 recompile
lane (compile the app itself to WASM, no emulator in the path), not the JIT.
Stated plainly so the target picks the right architecture.

## Final result: the browser loads GIMP faster than native (measured, on video)

With the state served as a sidecar (`--split-state`) and the disk as a
lazily-fetched Range-request device (`--split-disk`), the snapshot carries
only RAM + dirty blocks: 194 MB raw, 58 MB gzipped, for a 192 MB guest.
Opening the page streams the state through `DecompressionStream` and
restores. Measured on the same machine, warm on both sides:

| side | time to GIMP usable |
|---|---|
| native GIMP 2.8 GUI (Xvfb, window mapped) | 2.01 s |
| **browser (oxwasm snapshot resume, recorded)** | **1.62 s** |

The demo video (`demo/`: both sides screen-recorded with launch-marker
frames, timers burnt in from the markers) shows the race; the browser side
is labeled as what it is — a snapshot resume, the technique that makes this
possible at all. Nothing app-specific is involved: `--split-state` and
`--split-disk` are generic build flags, the snapshot tool watches for any
app window, and the app itself comes from a spec.

## Runtime, measured end to end: real GIMP operations, native vs emulated

Same GIMP 2.8 binary, same Script-Fu batch operations, run natively (chroot,
warm) and inside the emulated guest (v86 in headless Chromium, 192 MB). The
guest runs the benchmark itself via a bench app-spec and reports on serial —
no app-specific code in the tool. Operation cost = (run with op) − (baseline
run), isolating the op from GIMP startup.

| operation | native | emulated | slowdown |
|---|---|---|---|
| GIMP core startup (batch, warm) | 1.62 s | 46.6 s | **29x** |
| Gaussian blur, 512×512, r=25 (plug-in) | 0.13 s | 3.8 s | **29x** |
| Scale 512→2048 (core, interpolation) | 1.81 s | 127 s | **70x** |

So the honest split: **loading** beats native (snapshot resume does no
compute), while **runtime compute is ~30–70x native** under the v86 engine.
Integer-ish work (startup, the blur plug-in) sits at ~29x; the scale op is
~70x, consistent with heavy floating-point interpolation — v86 emulates the
FPU through softfloat, its slowest path. Interactively this means menus and
typing feel fine (mostly idle, event-driven), a small blur is a perceptible
~4 s, and a large scale is a coffee break.

These are exactly the workloads the M3 engine work targets: the measured
superblock JIT (2.3x native) and SIMD vectorizer (native-class on pixel
kernels) attack the pixel loops that dominate blur/scale. That is the road from
30–70x toward single digits; whole-app native remains the M4 recompile lane.

## Runtime parity: the recompile lane closes it (`platform/imgops/`)

The final piece. The same big resample GIMP does in ~30 s natively (and the
emulator does in ~127 s) runs in **1.3–1.5 s in the browser** as a wasm
kernel — ~20x faster than native GIMP — with output **bit-identical** to the
same C compiled natively (checksum-verified every run). Full numbers,
methodology, and the honest caveat (hand-tuned AVX2 native C is still 4–6x
faster than wasm's 128-bit SIMD ceiling) in `platform/imgops/README.md`.
The race video: native GIMP in an xterm vs the kernel live in a tab.

So the complete runtime story, one line each:
- emulation (v86): ~30–70x slower than native — compatibility, not speed.
- recompiled compute (M4/imgops): beats the native app, trails hand-AVX2.
- the M3 engine: the measured bridge between the two for unmodified binaries.

## Build-time optimizations already applied

- **WARM cache freeze** (`pack-app.sh` WARM hook): the app's first-run work —
  GIMP's 184-plugin query, config generation — is run once in the build
  chroot and frozen into the image. ~13% off cold GIMP launch; larger on an
  unloaded host. Process spawns are the single priciest thing under
  emulation, so precomputing them is pure win.
- **fontconfig / gdk-pixbuf / icon caches** warmed in the chroot at build.
- **doc/locale/theme pruning** to shrink the image and the eventual snapshot.

## The packed page against native, measured in a browser

Everything above this section was measured either under the v86 engine or with
the M3 engine imported as a module under node. Neither is the product. The
product is one HTML file in a tab, and until it was measured directly nobody
had checked that the file runs the engine at all - it did not. wabt.js
overflows its 64 kB emscripten stack on deeply nested WAT, the overflow is a
trap that kills the instance, and one deep function therefore refused the
assembler to every unit behind it. Packed pages ran the tier-0 interpreter,
silently, because a failed assembly is a legitimate deopt and the page is
correct either way. `gzip -9` of a 138 kB input read 126,177 ms and 193,913,777
interpreted steps; with the assembler guarded it reads 1,679 ms and 133,337.

`bench/vspage.mjs` measures the page: packed, served, run in headless
Chromium, timed by the page's own clock. Two input sizes and a subtraction, so
ELF load and tiering cancel and what is left is emulation.

`sha256sum`, 41.4 MB against 138 kB, nine reps each, medians:

| | page | native |
|---|---|---|
| 138 kB | 1810 ± 21 ms | 3.25 ± 0.13 ms |
| 41.4 MB | 2024 ± 29 ms | 34.21 ± 0.68 ms |
| **steady state** | **214 ± 36 ms** | **30.96 ± 0.69 ms** |

**6.9x native, 5.6-8.2x at one standard error.** Single-digit, in a browser,
on an unmodified dynamically-linked x86-64 binary, from a self-contained file.

The **page floor is ~1800-2100 ms**, all of it ELF load, translation and
in-page assembly, and it does not shrink with input: for anything short the
floor is the whole experience and the ratio is invisible.

### Across workloads

The caution above used to read "SHA-256's inner loop is the shape a
whole-function translator does well on, and a branchy workload will read
worse." Measuring instead of guessing produced this, and one entry of it was
worth more than the rest put together:

| binary | steady state | at one standard error | re-measured after the flag batch |
|---|---|---|---|
| md5sum, 41 MB | **2.3x** native | 1.8-2.9x | 2.6x (1.9-3.3) |
| sha256sum, 41 MB | **6.9x** native | 5.6-8.2x | 8.2x (5.9-10.6) |
| grep -c, 41 MB | **6.8x** native | 5.5-8.2x | 6.9x (5.1-8.9) |
| wc -l, 41 MB | refused | 37+-23 ms is not a measurement | - |

The right-hand column is the same three binaries re-run after six correctness
fixes and a large reduction in refusals (imul3 flags, MXCSR, pop ordering,
shift CF/OF, the cross-block flag kind). **Every interval overlaps its
original: no detectable change.** That is the expected result and worth
stating rather than burying - these three had their hot paths compiled
already, so removing refusals had nothing to win here. Refusal work shows up
on workloads that were losing functions, and grep at 741x was that case.

Two of the three needed 15 reps rather than 7 to clear the harness's
three-sigma rule; at 7 they read 5.4x and 1.8x and were refused. Those refused
readings are not results and are not quoted as any.

grep first read **741x native** (493-1233x), and the same under node, so it
was never the browser. The cause was one unmodelled instruction - see the
`imul3` batch in `docs/m3-engine.md`: the translator refuses a whole function
when it cannot model a flag producer, `imul r,r/m,imm` is what a compiler
emits for a struct-index multiply, and grep's matcher was blacklisted after
five calls and then ran 47,875 times interpreted. Modelling CF=OF took it to
6.8x. The 41 MB case had hung for four hours before that fix and now finishes
in seconds.

**That is the shape of the risk this table hides.** Every failure of this kind
is silent: the answer stays correct and only the speed collapses, so no
output-comparing test can see it, and the breadth sweep runs grep and calls it
exact. The single-digit numbers above are what the engine does when it
translates the hot path; they say nothing about how often it fails to.

The floor is also why this took three tries to measure. The same bench on a
2.8 MB input reported 41.9x, because a 115 ms difference against a 1745 ms
floor is the floor's jitter, not a steady state. The harness now carries the
standard error through the subtraction and refuses any ratio that is not three
times it; at the 41 MB gap it refused 7.4x at five reps and only reported a
number at nine.

## Against the incumbent, measured on this machine

Every comparison to v86 in this document until now was a citation. This one is
a measurement: the same program, the same host, the same browser, the same
input, on the same afternoon.

`bench/v86guest.py` packs a v86 guest - Ubuntu bionic i386 kernel, busybox,
and GNU coreutils sha256sum with the i386 loader and libc it links against.
It prints a marker and halts, so the harness times host wall-clock from
navigation to marker, at two input sizes, and subtracts the boot exactly as
`bench/vspage.mjs` subtracts the page floor.

sha256sum over 41.4 MB against 138 kB, five paired runs each, medians:

| | steady state | vs native |
|---|---|---|
| native amd64 | 33.9 ms | 1x |
| **oxwasm M3 page** | **265 +- 83 ms** | **7.8x** |
| v86 (this project's M1 engine) | 7,326 +- 396 ms | 216x |

**oxwasm is 28x faster than v86 on this workload** (19.9-42.4x at one standard
error). Both run in headless Chromium on the same machine; both produce the
same hash as native, checked rather than assumed - `vspage` now compares a
digest of the page's stdout against native's and refuses to print a ratio when
they differ, and the v86 guest's hash was read off the screen and compared by
hand.

**The caveat is the ABI and it is not small.** v86 is 32-bit. It cannot run the
amd64 binary the M3 page runs, so this is the same program from the same
source compiled for i386 against a 2018 glibc, versus an amd64 build against a
2024 one. A share of the gap is that difference rather than the engine. What
it is not is a difference of workload: both hash the identical 41.4 MB and
both agree with native.

The other half of the comparison needs no statistics. On x86-64 the sweep is
170 of 170 unmodified binaries byte-identical to native, and v86 runs none of
them, because it stops at 32 bits.


## The browser ratio is not comparable across sessions, and one run is not a measurement

Two things went wrong with re-measuring the page, and both are about the
instrument rather than the engine.

**The host changes between sessions.** This project's containers are
reprovisioned, and the machine that recorded 34.21 ms for native `sha256sum`
over 41.4 MB is not the machine that records 117.67 ms for the same work
today - 1.2 GB/s against 375 MB/s. `/proc/cpuinfo` on today's host has `avx2`
and `avx512f` and **no `sha_ni`**, so native SHA-256 runs in software here and
in hardware there. That is exactly the instruction the benchmark stresses, so
the ratio does not cancel the host: a machine without SHA-NI makes the page
look better for a reason that has nothing to do with the page. **Any
cross-session comparison of these numbers is invalid unless the hosts match.**
The 6.9x recorded earlier and the 3.7x that came out of the first run today
are not two measurements of the same thing.

The v86 comparison survives this, because both sides of it ran on one host in
one session and the gap (28x) is far outside anything here.

**The only valid question is a same-session A/B**, so that is what was run: a
git worktree at the last commit before this batch, against the current tree,
alternating on an idle box, nine reps each.

| tree | page steady state, per run |
|---|---|
| before (dfdb839) | 276 +- 43, 259 +- 71, 315 +- 55 ms |
| after | 424 +- 57, 278 +- 48, 246 +- 42 ms |

Medians **276 ms against 278 ms**: no detectable difference. That is the
expected answer - sha256sum's steady state was already fully compiled, and
none of this batch's fixes (overlapping `rep movsb`, the direction flag, the
escape handover, inline `pushf`, `fnstcw`) touches its inner loop. They buy
correctness and breadth, not this number.

**The 424 is the finding.** It reported `424 +- 57 ms`, which passed the
harness's own 3-sigma gate at **7.4 sigma**, and it did not reproduce: two
further runs of the same tree read 278 and 246. The within-run standard error
does not see whatever the machine does BETWEEN runs, so a single run's
interval is a lower bound on the uncertainty rather than the uncertainty. Had
that run been taken alone it would have been recorded as a 1.5x regression
this batch did not cause.

`vspage` now takes `--runs N`, repeats the whole two-size measurement, prints
the per-run steady states, and gates on **the larger of the within-run and
between-run noise** rather than the flattering one. On this host:

    page   steady state per run: 204, 328, 359 ms
    page   median 328ms  within-run +-50  between-run +-47
    RESULT 2.9x native, steady state (2.4-3.4x at one standard error)

This does not retroactively widen the numbers in the tables above, which were
single runs; it means their real intervals are wider than printed, and the
small differences between adjacent columns were never differences.
