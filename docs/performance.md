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


## What the page floor actually is

The floor - what a short run costs before the input matters - had been recorded
as "~1800-2100 ms, all of it ELF load, translation and in-page assembly", which
is three things named and none of them measured. It is now split, in the page,
on sha256sum over 138 kB (three runs):

| | ms | share of floor |
|---|---|---|
| total | 2583, 2596, 2800 | |
| tier-up (all of it) | 2060, 2078, 2228 | **~80%** |
| ... wabt parse | 177, 190, 235 | ~7% |
| ... V8 Module+Instance | 9, 10, 25 | **~0.5%** |
| ... translation itself | ~1850 | **~72%** |
| guest execution and the rest | ~450 | ~18% |

The guest interprets 422,224 instructions and dispatches 1,700 AOT runs to
reach that floor, and 106 units are translated into **4.34 MB of WAT text**.

So the floor is neither the assembler nor the browser: it is the translator
generating text, at roughly 41 kB of WAT per unit. Two of the three obvious
suspects are nearly free - V8 compiles all 106 units in 10-25 ms.

**A correction to a conclusion drawn earlier in this batch.** Seeing wabt at
182 ms of a 2350 ms floor, the note read "shipping precompiled units would buy
at most 8%". That is wrong, and wrong in the direction that would have killed
the right idea: a page that ships precompiled units skips the TRANSLATION as
well as the parse, so the ceiling on that change is the ~80% in the tier-up
row, not the ~7% in the wabt row. The engine already has the machinery
(`onUnitBytes` captures entry -> compiled wasm, and `cacheOnly` runs from a
manifest with no assembler at all); what it lacks is a pack-time training run
to fill one.

That is a ceiling, not a promise. Coverage depends on the input a training run
uses, and anything it misses still translates in the page.


## Shipping the units: m3pack --train

The floor is the translator, so the page can skip it for code a run at pack
time already translated. `m3pack --train` runs the program once on the packing
host, captures the wasm units it produced, and embeds them; the page hands
them to the engine's `unitBytes` hook, which registers a unit with no
translation and no assembler.

This rests on determinism, which was checked before it was relied on: two
training runs of the same binary produce the same entries with byte-identical
wasm. `diff/manifesttest.mjs` pins that, and pins the rest of the property -
the replayed run matches a translating run byte for byte, both match the
binary run natively, and the replay actually USED the manifest (a run that
silently fell back to translating everything would pass the first two and test
nothing).

sha256sum over 138 kB, three runs each, same page, same host:

| | total | tier-up | assembled in page |
|---|---|---|---|
| plain | 2417, 2611, 3617 ms | 1928-2874 ms | 106 units |
| `--train` | 1463, 1504, 1592 ms | 839-939 ms | 23 units |

**Medians 2611 ms to 1504 ms**, and the two ranges do not overlap. Output hash
identical (`e75d8b475e0554e1`). The page grows 5.80 MB to 6.13 MB - 116 units,
1.89 MB of wasm, 0.33 MB once gzipped and base64'd.

It does not help the steady state, which is already compiled code either way.

### Registering the manifest up front closes the gap entirely

The first version handed the engine a `unitBytes` lookup and let it consult
that on demand, which is what the engine does under node - and under node
instantiation is SYNCHRONOUS, so a unit is there the moment it is asked for.
A browser cannot compile a module of this size synchronously on the main
thread, so the engine takes its async path: it parks a null placeholder and
the unit appears some microtasks later. Execution continues interpreted across
that window, and the unit boundaries it establishes there are not the ones a
synchronous run establishes.

That is what the coverage gap was. The page asked for 163 distinct entries
against the training run's 116, and the misses were not mysterious code: 32
had been seen here just under the tier-up threshold, and of the 15 the
profiler never saw, 10 had run INSIDE a compiled unit under node rather than
being tiered separately. Different boundaries, not different code.

Instantiating the whole manifest before the first guest instruction removes
the window. It costs one pass - 116 units, 143 functions, **8-10 ms** - and it
is the same registration the engine does itself.

`wall` is navigation to exit, which is everything the reader waits through
including the inflate; `engine` is the page's own clock, which starts after
the binary is decompressed.

**sha256sum, 138 kB, four runs each:**

| | wall | engine | tier-up | assembled in page |
|---|---|---|---|---|
| plain | 2724, 2732, 2741, 3031 ms | 2173-2395 ms | 1697-1857 ms | 106 units |
| lazy manifest | ~1450 ms | 1439-1479 ms | 832-843 ms | 23 units |
| **up front** | **774, 808, 819, 944 ms** | **240-398 ms** | **119-143 ms** | **0 units** |

**gzip -9, 138 kB, three runs each:**

| | wall | engine | assembled in page |
|---|---|---|---|
| plain | 1949, 1965, 2454 ms | 1580-1932 ms | 69 units |
| **up front** | **667, 679, 758 ms** | **301-391 ms** | **1 unit** |

Wall clock **2736 ms to 813 ms** on sha256sum and **1965 ms to 679 ms** on
gzip. Output hashes identical across every run of both. In-page assembly goes
to zero, which is the coverage gap closing rather than shrinking: with the
manifest registered from instruction zero, the page's tier-up set is the
training run's.

What is left in the wall figure is the page load and the inflate, ~550 ms on
sha256sum, which a manifest cannot help and slightly grows (6.07 MB against
5.80 MB).
**The manifest is a correctness surface, so it carries a fingerprint.** Handed
units trained against a different binary the engine registers code whose
addresses mean something else, and the guest dies somewhere unrelated with
nothing pointing back at the manifest - verified by doing it: a manifest from
`md5sum` replayed under `sha256sum` crashes inside a dispatched unit. The page
therefore hashes the program bytes plus argv, env and memMB and refuses a
manifest that does not match, with a message that names the mismatch. In
normal use it cannot fire, because both come from the same pack; it is there
because the failure it prevents is silent and total.

One mutation that did NOT fail is worth recording. Swapping the bytes of two
manifest entries changes nothing: the engine registers by the `f_<addr>`
export name inside the unit, not by the key it was looked up under, so a
mis-keyed entry places itself correctly anyway. The lookup key is a hint. That
is why the fingerprint covers the program rather than the individual units.


## What is left of startup once the manifest lands

With the units shipped, the page's own clock is ~260 ms and the wall clock is
~815 ms, so most of what a reader waits through is no longer the engine. The
page now times each phase, because "page load and inflate" was three words
covering four different things:

| phase | ms | what it is |
|---|---|---|
| wabt init | 79-104 | the depth probe plus building the assembler |
| ELF inflate | 3 | 22 kB of base64 |
| file inflate | 54-64 | 4 bundled files, 4.13 MB of the page |
| engine constructor | 1-2 | |
| manifest registration | 7-10 | 116 units, 143 functions |
| guest run | ~250 | the emulation itself |
| **wall clock** | **~815** | navigation to exit |

Those sum to ~400 ms against a wall of ~815, so **~400 ms is the browser
loading the page**: parsing 6.08 MB of HTML and evaluating the engine modules,
which ride in an import map as base64 data: URLs.

Page composition, measured rather than assumed:

| | bytes | |
|---|---|---|
| bundled files | 4,129,504 | ld.so, libc, libcrypto, the input |
| engine modules | 947,224 | base64 data: URLs in the import map |
| wabt.js | 636,399 | the in-page assembler |
| manifest | 329,032 | |
| the ELF | 22,148 | |

The bundled libraries are the program's own dependencies and are not the
engine's to remove. The 947 kB of engine source is base64, which costs 33% over
the bytes it carries.

**One change tried here bought nothing and is reverted.** The wabt depth probe
binary-searches `parseWat` and rebuilds the module on every overflow, ~90 ms,
and it was paid BEFORE the inflate and the manifest registration, neither of
which needs it. Starting it first and collecting it just before the guest runs
should have hidden it behind the ~70 ms of decompression. Six alternating runs
each: **791 ms overlapped against 775 ms sequential.** No gain, slightly worse.
Both are main-thread CPU, and interleaving two main-thread tasks costs what
running them in order costs; `DecompressionStream` may be off-thread but the
wabt work is not.

A first read of four runs said 830 ms against 780 and looked like a win. It was
drift between runs taken twenty minutes apart - the same failure the `--runs`
work was added for, repeated by not using it.


## The assembler's startup cost, and a change that was worse where it counted

With the manifest registered up front, `assembled` is 0 on sha256sum and 1 on
gzip - and the page was still spending 81-95 ms probing the assembler's nesting
limit before the guest ran. Building the assembler itself is 3-4 ms; the probe
is everything else, because it binary-searches `parseWat` over 0..1024 and
about half its ten steps OVERFLOW, and each overflow traps the instance and
needs a fresh one.

**The obvious fix was worse.** Drop the probe, catch a failed parse, replace
the dead instance and refuse that unit - detect instead of predict. It is
strictly more robust in principle (a rebuild handles any cause of death, not
only nesting) and it was verified to work: a shallow module fails on the
poisoned instance and parses on the replacement.

Four alternating runs of each page, in one session:

| page | wall | assembled |
|---|---|---|
| trained, probe | 842 ms | 0 |
| trained, self-healing | **758 ms** | 0 |
| untrained, probe | 2728 ms | 106 |
| untrained, self-healing | **9012 ms** | **21** |

It saves 84 ms on a trained page and makes an untrained one **3.3x slower**.
`WabtModule()` is async, so `wabt` is null across the whole synchronous
tier-up burst that follows an overflow, and every unit in that burst is
refused permanently - 85 of 106 of them. `--train` is opt-in, so the untrained
page is the default one. Reverted.

**What replaced it** is smaller and has no such edge: try the answer before
searching for it. Every wabt build this has run against takes 149, and
confirming that costs one success and one overflow instead of ten steps. It is
exact either way, because it verifies BOTH sides of the boundary, and a build
with a different limit falls through to the same search as before. The probe
measured **59 ms against 81-149 ms**; the wall-clock effect on a trained page
(~800 ms against ~830) is at the edge of what four runs resolve, and is
reported as such rather than as the 90 ms the probe number would suggest.


## Training permissively, now that the manifest lands before the guest runs

The engine tiers a function up after 4 calls, or a loop after 12 back edges.
Those thresholds exist because translating at RUN time costs time a function
called once will never repay. A manifest pays that cost at PACK time, so the
reason for them is gone - and what is left under them is code that runs once
or twice and used to run interpreted.

Training at 1 call and 2 back edges, six and five alternating runs:

| | units | wall (median) | engine (median) | interpreted | assembled in page |
|---|---|---|---|---|---|
| sha256sum, 4/12 | 116 | 909 ms | 330 ms | 21,814 | 0 |
| sha256sum, 1/2 | 338 | 844 ms | **264 ms** | **9,667** | 0 |
| gzip -9, 4/12 | 77 | 746 ms | 323 ms | 14,997 | 1 |
| gzip -9, 1/2 | 255 | 642 ms | **241 ms** | **4,098** | 0 |

Engine time falls 20% and 25%; the interpreted counts, which are deterministic
and not subject to the wall clock's noise, fall by more than half. Registration
goes from 8-10 ms to 13-20 ms and the page grows 6.07 MB to 6.19 and 3.36 to
3.45.

**This is the same change that made things worse two hours ago**, when the
manifest was consulted on demand: 338 units then cost ~230 ms of instantiation
and bought nothing, because the units were not registered in time to be used.
The measurement was right and the conclusion drawn from it - that permissive
training does not help - was only true of the delivery mechanism it was tested
against. Changing that mechanism made the same change worth 20%.

`OXTRAIN_CALLS` and `OXTRAIN_LOOPS` override the thresholds. The tradeoff is
page size against startup, and it scales with the program: a large application
whose default-threshold manifest is already thousands of units will grow more
than these do.


## How much of the guest run is the dynamic linker

With the manifest landing first and trained permissively, sha256sum's page
interprets 9,667 instructions and spends ~243 ms in the guest. Almost none of
that is interpretation and almost none is the hashing: the two-size subtraction
puts ~250 ms of steady state on 41 MB of input, so 138 kB of it is about a
millisecond. What is left is startup - and for this binary startup means
ld.so mapping and relocating libc and libcrypto.

Measured against a STATIC guest doing the same job on the same input - busybox
`sha256sum`, four alternating runs each:

| | page | wall (median) | engine (median) | interpreted |
|---|---|---|---|---|
| coreutils sha256sum (dynamic) | 6.19 MB | 812 ms | 243 ms | 9,667 |
| busybox sha256sum (static) | 3.24 MB | 593 ms | **95 ms** | 3,928 |

**~150 ms of the dynamic page's guest run is the dynamic linker**, and the
page is nearly twice the size because it has to carry ld.so, libc and
libcrypto. The 219 ms wall difference is that 148 ms plus ~70 ms of page load
for the extra 3 MB.

The caveat is that these are two implementations of sha256sum, not one binary
linked two ways - busybox's is its own code and coreutils' goes through
libcrypto. At 138 kB the compute is about a millisecond either way, so the
comparison is dominated by startup, but it is not a controlled A/B and should
not be read as one.

Nothing here is the engine's to fix: the linking work is real guest
instructions, already compiled, and the program chose to be dynamic. What
COULD skip it is resuming from a settled state rather than re-running startup.
`engine/snapshot.mjs` already captures one - guest memory, thread contexts, fd
table, layout scalars - and `snapshot_core.mjs` is deliberately browser-safe
restore with no node imports. A page that ships a post-linking snapshot instead
of the libraries would trade its 4.13 MB of compressed .so files for a
compressed image of the memory they were loaded into, which is a different
size rather than obviously a smaller one, and skip the ~150 ms. That is
measured as worth doing and not yet done.


## A snapshot page for a batch program does not pay, and why

The last section measured ~150 ms of sha256sum's ~243 ms guest run as the
dynamic linker, and the machinery to skip it already exists: `snapshotEngine`
captures a settled engine, `snapshot_core` is browser-safe restore, and
`xpack` has shipped snapshots to a page for X11 GUI apps for a while. So
m3pack got a `--snapshot` that runs the guest to its program ENTRY, ships that
state, and drops the shared libraries the memory image already holds.

It works - the output hash is identical - and it is slower.

sha256sum, 138 kB, six alternating runs of each page:

| | page | wall (median) | engine (median) | restore | interpreted |
|---|---|---|---|---|---|
| trained | 6.19 MB | 1197 ms | 224 ms | - | 9,667 |
| trained + snapshot | 6.40 MB | 1292 ms | 205 ms | **205-256 ms** | **28,900** |

The engine clock does not include the restore (it starts after it), so the
comparable figure is ~205 + ~230 against 224. **The restore costs more than
the linking it skips.** Three things go wrong at once:

- **The restore is 205-256 ms.** Most of it is not the guest: it is
  base64-decoding and inflating a 4.14 MB image and writing 3.4 MB of tiles
  into wasm memory. Emitting raw `SPR2` tiles compressed once instead of
  `SPRS`'s per-tile gzip - one DecompressionStream round trip instead of one
  per tile - moved it from 194 ms to 256 ms rather than down, which is not
  explained and was not chased further.
- **The page grew**, 6.19 MB to 6.40. The memory image at 4.14 MB is bigger
  than the 4.13 MB of compressed libraries it replaced, and page load is
  already the largest item in startup.
- **Interpretation went UP**, 9,667 to 28,900. A restore drops tier state by
  design, and the manifest was trained from a run that started at the
  beginning, so a run that starts at the entry asks for entries it does not
  carry.

The fixed cost is what kills it: a batch program's whole startup is ~800 ms,
and a ~230 ms restore against ~150 ms of linking cannot win. It would look
different for a program whose linking is seconds rather than 150 ms - which is
exactly the case `xpack` already covers, and is not this packer's.

Reverted. What is kept from the attempt is the snapshot bug it exposed (the
382 MB of JSON) and `diff/snaptest.mjs`.

## opencode (Bun/JavaScriptCore) steady-state JavaScript vs the same binary natively

`bench/jssteady.js`: recursion, typed-array math, object/property access, string
building, sort, Map/Set and JSON round trips, one round about 0.6 s natively. Round
time after warm-up (best of the later rounds), the same `opencode` binary run as bun
(`BUN_BE_BUN=1`) on a Firecracker VM, 4 vCPU:

| configuration | ms per round | vs native with JIT |
|---|---|---|
| native, JSC JIT on | 629 | 1.0x |
| native, JSC JIT off (LLInt only) | 2925 | 4.6x |
| oxwasm, JIT off (LLInt compiled to wasm) | 25387 | 40x |
| oxwasm, JIT on, generated code translated (EXEC_ANON + STOREGUARD) | first small round 448 s | not usable |

Against the same interpreter natively the emulation costs 7x to 12x per phase (fib 7.1x,
strings 7.5x, maps 7.8x, objects 8.6x, math 9.6x, json 10.2x, sorting 11.8x). The JIT on
adds the other 4.6x natively, and the translated-JIT route currently spends its time
re-translating code JSC patches in place. Within 20% of native needs both the 7x to 12x and
the JIT gap closed; neither is closed yet.

### After compiling LLInt as one multi-entry function

`bench/jssteady.js` is too slow to iterate on, so these use a smaller mix (same phases,
fib(24), 300k math iterations, ...). Native on the same box: 156 ms per round with the JIT
off, 45 ms with it on. oxwasm, JIT off, the dispatch loop compiled as a single wasm function
with an entry at every block start: 1161 ms best round (about 1.5 s typical), 7.4x the native
interpreter and 26x native with the JIT. Per phase against native JIT-off: fib 41 vs 6, math
128 vs 15, objects 148 vs 23, sorting 181 vs 16, maps 203 vs 41, json 125 vs 14. The fib phase
fell from about 3000 ms; the rest is the same 7x to 11x.

What it took, and what each piece cost when it was missing: the wasm-frame budget (1200) made
every callout past depth ~12 interpret its callee (22k callouts in six rounds), so the budget
and the worker stack are now settable (`OXWASM_FTDLIMIT`, `OXWASM_STACKMB`); absolute jump
tables without a byte-index bound were read as 1024 targets and pulled unrelated functions
into one 14k-block unit; V8's baseline compiler spends about 2 KB per byte of wasm, so every
multi-MB unit is a multi-GB compile on a 16 GB host.

JIT on does not complete on this host: translating JSC's generated code produces about 1100
new units in the first minutes and the process is killed at 13 GB. Even with that solved,
translated x86 runs at best a small multiple of native, so within 20% of native-with-JIT is
not reachable by this route on this evidence.

### Second pass: flags barrier, direct dispatch, TurboFan-only, JIT-on configuration

Small mix, JIT off, same box as above (native 156 ms per round): 1161 ms -> about 800 ms
steady (rounds 7-11: 819-905 ms; best single round 799). Per phase: fib 30, math 60,
objects 112, strings 93, sorting 165, maps 165, json 83 (native: 6, 15, 23, 20, 16, 41, 14).
What moved it:

- An interpreter's computed-goto dispatch is now a flags barrier in the cross-block flag
  analysis. Every flag producer used to reach every soft consumer through the 769-way dispatch
  edges, so each handler computed the full EFLAGS word and dropped it (the emitted unit shrank
  from 9.7 MB to 8.5 MB of text).
- The dispatch branches through the `br_table` by the bytecode value itself (extra table
  entries per jump-table row) instead of loading the pointer and searching for it.
- `OXWASM_NOLIFTOFF=1` (TurboFan only): V8's baseline compiler took 2.3 GB on the 1.3 MB
  interpreter unit, TurboFan 0.4 GB. Peak RSS of the same run went from 12+ GB to 5.9 GB and the
  speed did not change. This is what makes anything larger than the JIT-off benchmark fit in
  16 GB.

JIT on: every earlier JIT-on number in this file ran with generated code INTERPRETED, because
`OXWASM_EXEC_ANON=1` (and `OXWASM_STOREGUARD=1` for in-place patching) were not set. With them
set and DFG/FTL off, fib completes (rounds 4-5: 8-10 ms; native with the JIT 0.7 ms) and the
math phase converges to 100-260 ms per round but is unstable (rounds of 3-15 s appear after
code is patched and re-translated), which is still slower than the JIT-off compiled
interpreter's 60 ms. The full small mix with the JIT on has not been completed.

Where the remaining JIT-off time goes: pure-call code. A guest call is ~60 wasm operations
(spill, hash lookup, budget accounting, reload) against 2 to 5 instructions natively, which is
why C++-runtime-heavy operations (`push` 20x, comparator sort 15x) are worse than bytecode
dispatch (4-6x). Narrowing the protocol was measured earlier (bench/kernels/idealcall.mjs) and
did not pay.

JIT on, full small mix, measured (EXEC_ANON + STOREGUARD + TurboFan-only, cold-ish cache):
- DFG and FTL on: round 0 took 553 s and round 1 never finished in the remaining 54 minutes.
- baseline JIT only (DFG/FTL off): rounds of 124 s, 446 s, 471 s, 511 s, 569 s, 589 s - growing,
  not converging.
The single-phase results above (fib, math) converge; the mix does not, so the JIT-off compiled
interpreter (about 800 ms per round) remains the best configuration measured.

### JIT on, after trusting quiet code pages again (f11ad8b)

The JIT-on slowdown had two causes in the engine, not in the guest. Every store into generated
code scanned every translation table (591 s of a 1212 s run), and a code page that took eight
patches was marked volatile and never translated again, so JSC's hot baseline-JIT loops stayed
interpreted for the life of the process. A quiet page is now trusted again and the scan is
skipped for pages with nothing cached.

Small mix, baseline JIT only (`BUN_JSC_useDFGJIT=0 BUN_JSC_useFTLJIT=0`), EXEC_ANON +
STOREGUARD + TurboFan-only, 30 rounds: round 0 96 s, then 23, 10, 2.5, 6.2, 1.6, then 0.75 to
1.6 s per round from round 6 on, best 746 ms, typical 1.0-1.4 s, with occasional 7-20 s rounds
when a page goes volatile again. Per phase minimum over the run: fib 5 ms (native 6 with the
JIT off, 0.x with it on), math 34, objects 169 (not converged), strings 60, sorting 129,
maps 89, json 72. That is the same neighbourhood as the JIT-off compiled interpreter
(about 800 ms), not better.

Full JIT (DFG and FTL on): rounds of 186, 160, 67, 158, 35, 75, 44 s and then an abort (rc 134)
in the eighth - not usable.

### GC pacing is most of the allocation-phase gap

Per-phase times in the JIT-on runs varied 5x between rounds, concentrated in the allocating
phases (objects, strings): that is JavaScriptCore's collector, which is call-dense C++ and
pays the 15-20x call tax. Raising the heap growth factors makes collections rarer:

    BUN_JSC_useDFGJIT=0 BUN_JSC_useFTLJIT=0 BUN_JSC_smallHeapGrowthFactor=8
    BUN_JSC_mediumHeapGrowthFactor=8 BUN_JSC_largeHeapGrowthFactor=8

with `OXWASM_EXEC_ANON=1 OXWASM_STOREGUARD=1 OXWASM_NOLIFTOFF=1 OXWASM_CW_VOLATILE=4
OXWASM_STACKMB=256 OXWASM_FTDLIMIT=30000`, small mix, 150 rounds (410 s): round time min 329,
p25 450, median 672, p75 939 ms (one 100 s outlier). Per phase minimum: fib 5, math 30,
objects 22, strings 15, sorting 117, maps 77, json 34 (native with the JIT off: 6, 15, 23, 20,
16, 41, 14). Objects and strings are at native interpreter speed; sorting (comparator
callbacks) and maps are the remaining multiples. `useConcurrentGC=0` was worse (twice as slow).
The same growth factors with the JIT off gave a best of 710 ms (objects 109), so the JIT-on
objects/strings result needs both.

DFG on (FTL off) with the same settings did not complete 100 rounds in 30 minutes; the
baseline JIT alone is the usable JIT configuration.

### Dispatch-table maintenance under a JIT, and the abort at large heap growth

A stack sample of a DFG-on run put 5 of 6 samples in `rebuildFtmap`: every invalidation that
dropped a translated unit rebuilt the whole dispatch hash (re-registering ~10k functions).
Dropped entries are now tombstoned in place (key 1, which `$ftr`'s probe walks past), with a full
rebuild only when tombstones or leaked funcref slots pile up. `process.env` reads on per-dispatch
paths (an interceptor into C++) now go through a copy refreshed at engine construction.

Heap growth factor 8 made the guest abort (rc 134) in the allocator after about 200 s, from
exhausting the 3.9 GB child memory; factor 3 gives the same speed without it. Recommended
opencode configuration, small mix, 200 rounds in 354 s, rc 0:

    OXWASM_EXEC_ANON=1 OXWASM_STOREGUARD=1 OXWASM_NOLIFTOFF=1 OXWASM_CW_VOLATILE=4
    OXWASM_STACKMB=256 OXWASM_FTDLIMIT=30000 OXWASM_MAXWAT=8000000
    BUN_JSC_useDFGJIT=0 BUN_JSC_useFTLJIT=0
    BUN_JSC_smallHeapGrowthFactor=3 BUN_JSC_mediumHeapGrowthFactor=3 BUN_JSC_largeHeapGrowthFactor=3

round time min 351, p25 477, median 685, p75 870 ms, plus rare multi-second to 80 s outliers.
Per phase minimum: fib 5, math 28, objects 23, strings 15, sorting 117, maps 76, json 33.
Against native 45 ms (JIT) and 156 ms (JIT off): the median is 15x and 4.4x.

### Reference with the baseline JIT only, and what DFG does

Native, small mix, 40 rounds: baseline JIT only 43 ms, baseline+DFG 33 ms, all tiers 30 ms. The
optimizing tiers are worth 1.3x natively on this mix, so the reference that matters for the
oxwasm configuration above is 43 ms; its median of 682 ms (min 331) is 16x and 7.7x.

DFG under oxwasm still fails: after a few rounds `new Map()` throws "Map is not a function"
(reproduces in about five minutes with concurrent JIT off). The shadow comparison
(`OXWASM_SHADOW_RANGE=5a000000-5b000000 OXWASM_SHADOW_EXIT=1`, `OXWASM_DUMPDIR` for the bytes of
the diverging function) reported only differences in dead scratch registers and stack garbage
below rsp, so the cause was not found. Cross-page extents for translated JIT functions
(a patch anywhere in a function now invalidates it, not just a patch on its first page) did not
cure it. Invalidating by the exact bytes stored, rather than by page, made the baseline JIT
fail the same way within 20 rounds (bulk copies report one address), so invalidation stays
page-granular.

### Startup (`opencode --version`) is dominated by loading units, and V8 makes that quadratic

Native 0.8 s. oxwasm with a warm unit cache (the per-handler cache, default settings): 79 s,
output correct. A CPU profile of that run (187 s of profile including sandbox boot): 55 s is
spent loading and registering the 3,516 cached units - `WebAssembly.Instance` 24 s, `read` 11 s,
`Table.grow` 10.6 s, `Table.set` 7.6 s, `Module` 4.7 s - and about 25 s executing.

The table cost is V8's: every instance importing the shared funcref table keeps a dispatch table,
and each `set`/`grow` updates all of them. Measured with 4,000 instances importing one table:
7.5 us per `set` at 500 instances, 50 us at 2,000, 139 us at 4,000, and 270 ms for one `grow`
(bench: a 10-line script, `tabq.mjs` in the scratchpad). A unit that exports hundreds of entries
(the multi-entry functions) pays it per entry. Preallocating the table is not free either: the
dispatch table is per instance, so 20,000 entries is 492 kB for every unit.

What would fix it is fewer, larger modules (one wasm module per few hundred functions, or per
image) rather than one per translation unit, so that the instance count stays in the dozens.
That is an architectural change to the unit cache and the registration path, not a tuning knob,
and it is the largest single item left for short-running workloads.

The newer mega-unit configurations did not complete `--version` in 24+ minutes: cold, every
startup path compiles its own units (about 100 per second are loaded, few are built), and the
warm-up runs added only ~20 units per 27 minutes, so I could not get a warm number for them.

Measured directly (`opencode --version`, warm per-handler cache, 5,149 units registered, 77 s run): table
`set` 6.0 s and `grow` 3.6 s (three grows of about 1.2 s each), 9.6 s together; instantiation, module
compilation and file reads are the other ~35 s of unit loading. Growing the table earlier does not
help: an instance's dispatch table is a copy of the whole table, so 8,192 entries across 5,000
instances is about a gigabyte. WebAssembly GC arrays of function references (an `array.set` is O(1) and
fans out to nothing) would remove the table cost, but neither wabt 1.0.34 nor the 1.0.39 JS build parses
GC text (`ref null`, `array.new_default`), so the assembler cannot produce those modules. Bundling many
units into one module (merging their WAT, one instance) avoids both the instance count and the fan-out
and is the way to go.

### Bundled units: startup 77 s -> 34 s

`tools/wasmlink.mjs` links many unit modules into one (unify types and imports, renumber functions,
rewrite the indices inside code bodies, keep the first export of each name). Its instruction walker
reproduces the function bodies of 3,000 cached units byte for byte, and a 1,000-unit link validates.
`tools/bundle-units.mjs <cache>/units/<engine hash>` writes `bundle_N.wasm` (about 16 MB each) next to the
unit files of every program id with 50+ units; the engine loads a program id's bundles the first time it
looks that id up, and registers every export, so the units it would have loaded one by one are already there.

Loading 5,000 units as separate modules took 29.2 s in a standalone test and under 1 s bundled (link time
excluded; a link is done once, offline). `opencode --version` with the warm per-handler cache: 77 s separate,
34 s bundled, output `1.18.35`; table `set` + `grow` 9.6 s -> 0.05 s. Native is 0.8 s, so startup is now about
40x instead of about 100x.

Two further runs after re-bundling: 30 s each (guest wall time), stable. The remaining profile of that run
(62 s including sandbox boot): interpreter 6 s, translation attempts that do not end in a unit (size-gate
deferrals of giant functions are re-analysed) about 9 s, collector 3 s, wasm execution about 5 s.

The 82 size-gate deferrals in a startup run cost 3.7 s (45 ms each, re-analysing giant functions to learn they
are not hot enough yet). The instruction count of each deferred root is now kept beside the cached units
(`<entry>.size`), so a later run answers the gate without analysing: 81 of 81 deferrals answered from the
store, `opencode --version` 30 s -> 28 s.

## Call-continuation leaders in the interpreter-loop unit (negative result)

Making the instruction after every call a block leader (so a deopt unwind can resume
inside the loop) made the analysis of the dispatch root exhaust the worker JS heap even
with the old-generation limit raised to 8 GB (cold run, OXWASM_HEAPMB=8192). Reverted.
The 3.6M of 6M interpreted startup steps at the post-call continuation remain unaddressed.

Narrower variant: a single measured continuation address (0x25c4f7c, set through an environment list) as an extra
leader of the interpreter-loop unit exhausted the worker JS heap at 8 GB. The control run (identical cold build, no
leader, 8 GB) exhausted it too, about 13 minutes after the same point, so the leader is not what blows the heap: this
cold configuration (unit limit 80000 instructions, empty cache) needs more than 8 GB of worker heap on its own. The
leader edit was reverted untested for speed, because no build with it finished. The OXWASM_HEAPMB worker-heap knob stays.

## mega10 warm-up, 8 GB-class heap (negative result)

`opencode --version` on the mega10 unit cache (6 GB worker heap, --no-liftoff, default unit limits) was still
running when the 3000 s guest-side guard killed it (rc=127 secs=3019), with ~1,800 units loaded from the cache
and 13 translation failures, one worker thread at ~100% CPU and 6.8 GB resident, and almost no new units written
after the first few minutes. The default per-handler cache finishes the same command in 28 s. The mega
configuration is therefore not a path to a startup number as built: it spends the time outside compiled code.

## `opencode debug paths` did not complete on oxwasm (negative result)

Native in the Firecracker VM: `--help` 0.82 s, `debug paths` 0.76 s, `models` 3.7 s (the first `--version` was 10.5 s
once, one-off extraction). On oxwasm, `debug paths` has not completed in either setup tried. With the engine flags
OXWASM_EXEC_ANON=1 OXWASM_STOREGUARD=1 OXWASM_NOLIFTOFF=1 OXWASM_CW_VOLATILE=4 on the default cache, the guest-side
guard killed it at 2438 s with no output (one worker thread at ~100% CPU, 10.3 GB resident). Without those flags
(OXWASM_NOLIFTOFF=1 only), the worker ran out of JS heap at the default 4 GB after about 10 minutes. The guest runs with
BUN_JSC_useJIT=0 in both (oc_emb.mjs sets it), so neither run was JIT-on. The 682 ms steady-state median describes a
process that is already running; a short command does not reach it in these setups.

Third attempt, `debug paths` with OXWASM_HEAPMB=8192 and OXWASM_NOLIFTOFF=1 only (no extra engine flags): the guest-side
guard killed it at 1515 s with no output, 7.5 GB resident, one worker thread near 100% CPU. So `debug paths` has not
completed on oxwasm in any of the three setups (flags on / 4 GB heap / 8 GB heap), against 0.76 s in the Firecracker VM.

### Where the `debug paths` JS heap goes (OXWASM_HEAPLOG)

`OXWASM_HEAPLOG=<seconds>` (sdk/worker.mjs) prints the worker's V8 heap spaces. During `debug paths` the worker's JS heap
reaches 4.5 GB within about 3 minutes (old space ~3.0 GB, large-object space ~1.2 GB, 304 MB external buffers) and then
stays at about 3.9 GB: it is a large fixed footprint that sits right at the default 4096 MB old-generation limit, not
unbounded growth. That explains the OOM at the default heap, and means the 8 GB runs that did not finish were not
memory-bound but running (one worker thread at ~100% CPU) for 25+ minutes with the interpreter idle (51 rip samples in
4 minutes, then none). What owns the 3.9 GB is not yet identified.

The same ~3.9 GB JS heap appears for `opencode --version` (old space 2.9 GB, large objects 0.8 GB, steady from the first
minute), so it is a baseline of any run with `childMemMB: 3900`, not something `debug paths` grows. With these flags
(OXWASM_NOLIFTOFF=1, 8 GB worker heap, default cache) `--version` had also not finished after about 5 minutes, whereas
the earlier 28 s `--version` result came from a different flag set; I have not pinned down which flag makes the
difference.

### Correction: `debug paths` completes on the bundled cache

The runs above that did not finish used the default (unbundled) unit cache. On the bundled copy (OXWASM_UNITCACHE_KEY=b92eb,
OXWASM_HEAPMB=6144, OXWASM_NOLIFTOFF=1) `opencode --version` finishes in 35 s guest time (94 s wall with sandbox boot) and
`opencode debug paths` in 37 s guest time (89 s wall), rc=0, correct output. Against the Firecracker VM (0.8 s and
0.76 s) that is about 44x and 49x. The earlier negative results were a cache mistake, not a property of the command.

`opencode models` on the same bundled cache (b92eb): rc=0 in 504 s guest time (555 s wall) against 3.7 s in the Firecracker VM,
about 136x. Summary of full-command ratios against the VM on the bundled cache: `--version` 44x, `debug paths` 49x, `models` 136x.

## Where `opencode --version` spends its 37 s now (bundled cache b92eb, measured)

Translation is no longer the cost: tuTotalMs 101, unit loads from the bundle. What is left, from one instrumented run
(guest 37 s, 6.0M interpreted steps, 352k compiled-unit runs, 165k deopts, 163,869 of them "frame gone"):

- 62% of sampled interpreter steps (RIPSAMPLE=4095, 1500 samples) sit in one 16-instruction window, 0x25c4f7c-0x25c4fbf:
  straight-line decode of the next opcode ending in an indirect jump (the JSC LLInt dispatch tail), reached by a guest
  `ret` into mid-function code. About 3.7M of the 6M interpreted steps.
- Nearly every deopt takes the frame-gone path (guest rsp above the unit's entry rsp), which unwinds with a DeoptUnwind
  exception (~100 us each by the code's own comment: up to ~16 s of the 37 s). At those events the shared wasm depth
  counter is 2-6 and the deopt-chain depth is 0, so there are real wasm frames below and a plain "return the rip as the
  exit value" is not equivalent to the unwind.
- The callout path (compiled code calling a non-compiled function) is not the source: its per-target counters total only
  thousands of interpreted steps.
- Tried: compiling a unit at any rip that deopts N times through the dispatch catch (OXWASM_DEOPTTIER). No effect: that
  catch sees only a few thousand events in the opencode process; the volume is in the frame-gone branch of the deopt hook.
  Reverted.

Lead for next time: make the return into a mid-function continuation not need an unwind (a compiled entry for the
continuation reached through the shared table, or resuming the interpreter without throwing), measured on b92eb.

### Correction and the real split of the 37 s startup (CPU profile of the worker, `--cpu-prof`, b92eb)

Two earlier estimates in this file were wrong and are superseded:
- Frame-gone unwinds cost 576 ms in total (3.5 us each, measured with a timer around throw -> catch), not ~16 s.
- The interpreter is not the startup bottleneck. A run-start tier-up (compile a bounded unit at any interpreted
  straight-line run that ends in a branch N times, including the 0x25c4f7c dispatch tail) cut interpreted steps from
  6.0M to 2.6M and left the guest time at 37 s (tuTotalMs 81 ms). With an unbounded closure the same tier-up cost 59 s of
  failed compiles, so the unit has to be bounded (maxInsns 64) for it to be free. Reverted: no gain.

Worker CPU profile (114 s total self time including boot of the helper processes):
- 41 s `js-to-wasm` under dispatchAot: the compiled guest code itself (tail-called functions show up as the wrapper)
- 5.4 s syscall handling (85k syscalls, ~64 us each), 4.9 s interpreter step, 3.3 s _run1, 1.6 s GC, ~1 s translation
So the 44x startup gap is mostly the speed of the translated code, the same thing that makes the steady-state mix 7.7x to
16x. Closing it needs faster generated code (register file out of memory, cheaper call protocol, direct calls), not
tier-up or deopt tweaks.

### Pricing probes need a warm cache (OXWASM_NOACCT=1 attempt)

A pricing run of OXWASM_NOACCT=1 (no depth counter, no chain fuel) on a fresh unit cache did not reach the benchmark in
30 minutes: it wrote 3,300 units in the first 8 minutes, then about one unit per two minutes with one thread near 100% CPU,
the same cold-start pattern as the mega10 run. Any emitter change changes every unit's WAT, so each experiment pays a
full rebuild of an ~11,000-unit cache, which this container has not completed in a single run. Measuring the cost of the
call protocol therefore needs either a warm-build path that survives restarts or a standalone microbenchmark outside the
guest, not another cold run.

## Dispatch protocol priced in isolation (tools/dispatch-bench)

A standalone benchmark (no engine, no unit cache, so no rebuild) of a 64-handler chain dispatched 100M times on a
repeating 24-entry pattern, node 22 / V8, TurboFan:

    full   (current emitted protocol: spills, depth counter, fuel, hash probe, guard, return_call_indirect)  12.5 ns
    min    (spills + return_call_indirect)                                                                    8.3 ns
    params (registers as wasm params on the tail call)                                                        5.9 ns
    sw     (one function, loop + br_table, registers in locals)                                               1.5 ns

So the counters, probe and guard are 1.5x, passing registers as parameters is 2.1x, and keeping an interpreter's dispatch
loop in a single function is 8.3x per dispatch against the current protocol. (With a random bytecode stream every variant
is misprediction-bound at 10-20 ns and the differences shrink, so real speed-ups depend on how predictable the guest's
dispatch is.) This is the shape the mega unit takes; it is the largest measured lever on dispatch-bound guest code.

## Failed giant tier-ups are remembered (mega10 warm-up)

A mega10 `--version` run spent 28-62 s of its first 100-160 s in a handful of tier-ups that fail after a long analysis
(5.7 s each for the giant dispatch roots), and repeated them on every run. A root whose translation fails after more than
1 s of analysis is now written as `<entry>.fail` beside the unit files (unitStore.hasFail/putFail, per executable) and
answered from the store next time (stat `failKnown`). Two successive runs with the same cache: syscalls reached in the
200 s guest guard 13,029 -> 58,792, interpreted steps 1.0M -> 24.7M (the run goes much further), tuFails 7 -> 360 short ones.
Each warm round gets further; it still did not finish `--version`. The engine suite (engine/test.sh) is green with this change.

## The mega configuration finished `--version` once, and was slower: big single functions fall off a cliff

With failures remembered (above), an 8 GB-class heap and 9000 MB limit, `opencode --version` on the mega10 cache finished for the first
time: correct output (1.18.35), 138 s guest time, 86,874 syscalls, 4.1M interpreted steps, only 6,165 deopts (against 165k
on the per-handler cache). The worker CPU profile of that run: 104 s of 183 s in the compiled code (js-to-wasm), against
41 s for the per-handler cache, so the compiled mega code is about 2.5x slower in aggregate, not faster. Earlier runs on this
cache ran out of worker heap or sat in one synchronous tier-up (root 0x143be2e, the log shows `[tu>]` with no `[tu<]`
or `[tu:wat]`, so the time is inside compileUnitWat; set OXWASM_TUTRACE=1 to see this).

Why: the same br_table dispatch loop (tools/dispatch-bench/gen3.mjs, 16 locals, 8 ops per case) gets slower as the one
function grows:  64 cases (3 KB) 1.85 ns/dispatch, 512 cases (49 KB) 2.6, 2,048 cases (196 KB) 3.25, 8,192 cases (786 KB)
11.9. The largest units in the mega10 cache are 1.0-1.4 MB of wasm, past that cliff. So the per-dispatch win of one
function (8.3x over the current table-chained protocol at 64 cases) is lost when the function is too large for V8 to
optimise well. Next: split the dispatch region into several functions of about 150 KB each, joined by tail calls only
where control crosses a partition, and re-measure on a warm cache.

### The size cliff is mostly V8 tiering (OXWASM_NODYNTIER=1)

The 8,192-case dispatcher (786 KB) runs at 11.3 ns/dispatch under default flags, 4.7 with --no-liftoff, and 2.9 with
--no-liftoff --no-wasm-dynamic-tiering (the 64-case function: 1.85). A dispatch loop never returns, and wasm has no OSR, so
a function stuck on baseline code stays there. `OXWASM_NODYNTIER=1` (sdk/index.mjs) adds --no-wasm-dynamic-tiering to
OXWASM_NOLIFTOFF. On the real workload: bundled per-handler cache `--version` 37 s -> 38 s (no change, small units);
mega10 cache 138 s -> 117 s guest. So tiering explains part of the mega slowdown (~15%), not all: the mega configuration
is still ~3x slower than the per-handler cache (translation was 0.34 s here, so this is execution of the mega code).

### Cold unit-cache builds exhaust the worker JS heap (6 GB and 9 GB limits)

A cold build of a function-profiled cache (OXWASM_FNPROF=1, key fnp2, --no-liftoff) died with "Worker terminated due to
reaching memory limit: JS heap out of memory" at 6144 MB (cache at 3,713 units) and again at 9000 MB (4,072 units, after
about 8 minutes), at 12 GB resident. The same happened to the earlier cold mega/noacct builds. The baseline JS heap is
~3.9 GB for any run (childMemMB 3900), so a cold build adds 5+ GB of JS-side state before it finishes; raising the limit
further would exceed the 16 GB container. Until that growth is found (heap snapshot of a cold build, candidates: the
analysis memo maps, pending-unit text, per-unit registration closures) emitter experiments that need a rebuilt cache cannot
complete in this container, which is why every measurement here is on the existing b92eb/mega10 caches.

### What the cold-build stall is not (OXWASM_TUTRACE)

OXWASM_TUTRACE=1 now logs each tier-up (`[tu>]`/`[tu<]`, with the sizes of the engine's memo and registry maps and the JS heap)
and each cached-unit compile (`[wm>]`/`[wm:mod]`/`[wm<]`). On a cold build (key cold1, --no-liftoff, 9000 MB limit) the
JS heap stayed at 120-500 MB through 2,644 tier-ups and 3,300 registered functions, the map sizes grew linearly with the
unit count (no runaway structure), and all 281 cached-module compiles finished instantly. After about 84 s of worker time
there were no more tier-ups or module compiles, yet the run stayed alive for 10+ minutes at 11-14 GB resident, with the
worker's timers not firing. So the stall is not translation, not module compilation and not an engine map: it is the guest
running in compiled code while its memory grows, and the 3.9 GB / 9 GB JS-heap exhaustion seen in the OOM runs is reached
at run time, not during the cold build. That moves the question to what opencode (as bun) allocates when it starts here.

V8 flags that do not help the dispatch protocol (tools/dispatch-bench, ns/dispatch for full/min/params/sw):
default 12.2/8.0/5.8/1.5; --turboshaft-wasm 13.4/8.7/6.5/1.6; + --turboshaft-wasm-load-elimination 13.4/9.0/6.2/1.7;
+ --no-liftoff --no-wasm-dynamic-tiering 14.2/8.8/5.9/1.5. The register file lives in memory across function boundaries, so
load elimination cannot remove the spills; only changing the protocol (parameters, or one function) does.

## Startup: V8's own compile time was a large share, and --no-liftoff makes it worse (measured)

`OXWASM_V8FLAGS="--trace-wasm-compilation-times"` (new generic V8-flag passthrough in sdk/index.mjs) shows what V8 does with the cached
units on the fast bundled cache (b92eb, `opencode --version`, --no-liftoff): 9,966 functions compiled with TurboFan, 65 s of
compile time summed over threads, 75 MB of function bodies, the biggest single functions 1-1.7 s each. Nothing caches
compiled wasm between runs, so every run pays it. OXWASM_NOLIFTOFF=1 was introduced to cut memory peaks of huge functions,
but it forces this full optimizing compile of every function that is ever called.

Dropping OXWASM_NOLIFTOFF (V8 default: baseline compile first, optimise hot functions in the background), same cache, 3 runs:
`opencode --version` 21, 22, 21 s guest time (32-33 s wall), correct output 1.18.35, against 37 s guest (88 s wall) with
--no-liftoff. `opencode debug paths` 37 s -> 21 s. Against the Firecracker VM (0.8 s / 0.76 s) that is about 26x and 28x
instead of about 44x and 49x. Steady-state (small mix) with the default tiering is being measured next.

### Default tiering vs --no-liftoff: opposite answers for short commands and for the JIT-on steady state

Same engine, same flags except OXWASM_NOLIFTOFF:
- short commands, guest JIT off (oc_emb.mjs sets BUN_JSC_useJIT=0), bundled cache b92eb: `--version` 21-22 s guest / 32 s wall
  with default tiering against 37 s / 88 s with --no-liftoff (about 26x vs 44x the Firecracker VM's 0.8 s); `debug paths` 21 s vs 37 s.
- JIT-on steady state (steady_small.js, baseline JIT, the recommended flag set): with default tiering a 30-round run was killed
  by the guard at 3211 s with no output, and a 3-round run at 1208 s with no output; with --no-liftoff the same script ran
  200 rounds in 354 s. So default tiering is not usable there. (Cause not yet found; the guest JIT keeps generating code, and
  every new function starts on Liftoff code under dynamic tiering.)
So the right setting depends on the workload: Liftoff + dynamic tiering for short commands, --no-liftoff for long-running JIT-on
ones. A process that starts short and runs long (a real opencode session) needs both, which V8's flags do not give per module.

## Per-function compilation hints: TurboFan for the big functions, Liftoff for the rest (the first large steady-state win)

Default tiering broke the JIT-on steady state and --no-liftoff made every function pay a full optimising compile, so neither works
alone. V8 has a per-function answer: a `compilationHints` custom section (--experimental-wasm-compilation-hints) naming, for each
function, a strategy and a baseline/top tier. `tools/wasm-hints.mjs in.wasm out.wasm [minBody]` adds it (functions with a body of at
least minBody bytes, default 20,000: eager, optimised; everything else default tiering). It works on units already in the cache,
no rebuild: copy the cache directory, run the tool over every .wasm in it (including bundle_N.wasm), pass
OXWASM_V8FLAGS=--experimental-wasm-compilation-hints with the default tiering (no OXWASM_NOLIFTOFF).

Microbenchmark (8,192-case dispatcher, 786 KB): plain module 8.15 ns/dispatch under default tiering; hinted module + flag
2.35 ns/dispatch from the first call (1.1 s to compile up front).

Real workload, per-handler cache copy (key hint1), baseline-JIT guest, 30 rounds of steady_small.js:
- 30 rounds in 56-59 s of guest time, rc=0 (no-hints default tiering: not finished in 3,211 s; --no-liftoff: 200 rounds in 354 s)
- STEADY (best of rounds 15..29) 232 and 277 ms; median round 368 and 492 ms; against native 43 ms that is 5.4-6.4x for the best
  rounds and 8.6-11x for the median (before: 331 ms best / 682 ms median, 7.7x / 16x)
- startup on the bundled hinted cache (hint2): `opencode --version` 18 s guest (against 21 s unhinted default tiering, 37 s with
  --no-liftoff); it costs about 40 s more wall time at sandbox start, because the marked functions of the loaded units are
  compiled eagerly then.

Caveats: one of four hinted steady runs hit the guest-side `TypeError: 0 is not a function` after 12 rounds (the same family as the
earlier JIT corruption; not reproduced on the other three); and a bug in the failure-persistence change was found by these runs:
a `.fail` marker had been written for a root inside the guest's JIT window (0x5ad4112), and addresses there are reused with
different bytes, so remembered state about them is wrong. Persisted failures are now only written and honoured for addresses in
the static executable image (execRangesStatic); stale JIT-window markers were deleted.

Hint threshold (minimum function body to mark eager+optimised), per-handler cache, baseline-JIT guest, 30 rounds of steady_small.js:
  5 KB   (10,942 functions marked)  30 rounds in 73 s guest;  STEADY 274 ms, median 472 ms
  20 KB   (3,590 functions marked)  30 rounds in 56-59 s;     STEADY 232 and 277 ms, median 368 and 492 ms
  100 KB    (623 functions marked)  did not finish within 7.5 minutes (killed): the many 20-100 KB dispatch handlers stay on Liftoff
So 20 KB is the default to use. The steady state flattens at about 230-280 ms (5.4-6.4x native baseline-JIT 43 ms) however many more
functions are marked, which says the remaining gap is the quality of the generated code, not the tier it is compiled at.

### Cold-cache builds still die under default tiering (OXWASM_SYSHIST)

A cold build with default tiering (no --no-liftoff) wrote units about 3x faster than with --no-liftoff (3,100 in 2 minutes) but
still died with the worker's JS-heap limit at 6144 MB after ~10 minutes at 12.7 GB resident, 3,718 units. OXWASM_SYSHIST=<n>
(new) prints a syscall histogram with the JS heap and RSS every n syscalls: at n=4096 (49 s) heap 371 MB, RSS 3.8 GB; no
second sample arrived in the next 3+ minutes while RSS climbed to 12 GB, so the guest makes fewer than 8,192 syscalls in that
time: it is not a syscall loop and not the interpreter (no rip samples), not tier-ups (no [tu>] lines). The compile trace shows what
V8 itself is doing: the largest functions are 0.9-1.0 MB bodies compiled by TurboFan in 2.7-3.4 s using ~330-390 MB peak (530-600 MB
total) of compile memory each, several at once on the background threads. That accounts for a few GB of the 12 GB, not all of it.
What holds the rest during those minutes is still unidentified; emitter experiments that need a rebuilt cache remain blocked on it.

### Partial rebuild of the handler range does not work as a cheap experiment

Idea: keep the cache directory (OXWASM_UNITCACHE_KEY pins it), delete only the 208 unit files in the interpreter-handler range
(entries 0x25a....-0x25c....) and rebuild just those with a changed, ABI-compatible emitter. With the emitter unchanged (the
control), after 7.7 minutes of `steady_small.js` only 1 of the 208 units had been regenerated and no rounds had completed. The
handler roots are the giant dispatch roots whose analysis and assembly is the expensive part (and whose .size/.fail
answers were deleted too), so removing them is as bad as a cold start. An emitter experiment has to keep these units cached and
change something that applies at load time, or be tested on a standalone module (tools/dispatch-bench), not by rebuilding them.

### Where a cold build's 12 GB goes: thousands of small per-instance allocations (OXWASM_MEMLOG)

OXWASM_MEMLOG=<seconds> (sdk/index.mjs) samples process-wide memory on the main thread (its own V8 heap is irrelevant: 6-104 MB) and
prints the largest /proc/self/smaps mappings. During a cold `--version` build at 10.5 GB resident:
  - 29,259 mappings in total; 23,485 of them anonymous rw-p, 2,887 rwx (generated code, 88 MB)
  - the 25 mappings over 50 MB hold 3.6 GB (guest RAM is one of them: 908 MB resident of a 1 GB mapping)
  - the 29,200 mappings of 4 MB or less hold 5.9 GB, about 200 KB each
This is the per-instance cost measured earlier in this file (every WebAssembly.Instance that imports the shared funcref table keeps its
own dispatch table, ~0.5 MB at 20,000 entries): a cold build makes one instance per translated unit, ~3,700 by then, so memory grows
linearly with units until the container or the worker limit is hit. Bundled caches (a few dozen linked modules) do not pay it,
which is why b92eb runs in ~7 GB. So the cold-build problem is the instance count, and the fix is to bundle as units are produced
(link new units into a rolling bundle module instead of instantiating each separately), not a leak or a tier-up problem.

### The cold-build memory is 256 KB pages, not per-unit instances (and the rolling-bundle idea did not change it)

Round 2 of a rolling cold build (coldbuild.sh in the scratchpad: build, link the units into bundles with tools/bundle-units.mjs,
restart) started from 2,243 bundled units and still reached 10.2 GB resident within 2 minutes with only 13 new units. So the
per-instance dispatch-table explanation above is not the main cost. /proc/<pid>/smaps of that process: 21,902 mappings of exactly
256 KB (rw-p), 5.5 GB resident; everything else is small. 256 KB is V8's heap page size, so the memory is V8-managed pages (JS heap
or similar), about 5.5 GB of them, right at the 6 GB worker limit. They appear after the tier-up phase and without syscalls,
interpretation or deopt-hook activity (OXWASM_HEAPPROF=<MB>, a same-thread sampling heap profiler triggered from the deopt hook,
never fired in a 4-minute run, so no JS code is running while they grow). What allocates them is still unidentified; tools:
OXWASM_MEMLOG (process memory + biggest mappings), OXWASM_SYSHIST, OXWASM_TUTRACE, and the smaps histogram script described here.

Comparison point: a healthy warm bundled run (b92eb, `opencode --version`, ~22 s in) has 444 mappings of 256 KB (108 MB resident), the
cold build round has 21,902 (5.5 GB), while the worker's own JS heap stays under ~500 MB at every tier-up (TUTRACE) and the sampling
heap profiler never fires. So the 256 KB blocks are native memory made while a lot of fresh translation/compilation is going on
(candidates: V8 compile zones or allocator arenas kept by the background compile threads, the assembler's memory). Not yet pinned down.

glibc allocator tuning does not help (MALLOC_ARENA_MAX=1 MALLOC_TRIM_THRESHOLD_=65536 MALLOC_MMAP_THRESHOLD_=4194304 on a fresh cold
build): 8.6 GB at 1:50 and 10.3 GB at 3:57 against 9-10.9 GB at similar points without it, still climbing, 3,062 units. The 256 KB
blocks are live native memory, not arena slack left behind by freed allocations.

## Root cause of the cold-build memory: a per-page index of huge extents (fixed)

The 5 GB of 256 KB blocks was the worker's JS heap. A sampling heap profile (OXWASM_HEAPPROF=<MB>, now run from the interpreter
loops too) showed 3.2 GB of Set/Map entries, and the engine's collection sizes at the same moment showed the cause:
`_extPages` (page -> set of functions built from it) had 16,777,197 entries and `codePages` 16,777,216, from only 17 recorded
extents. A function's extent is the span of source bytes it was built from; some functions' blocks straddle the static binary and
the guest JIT region, so their extents are tens of MB (255bcf0-5bad976 = 54 MB, 4642180-5b6c56d = 21 MB), and registering
each one page by page made a Set per page in `_extPages`.
Fix: an extent spanning more than 4,096 pages is kept in `_wideExt` and checked linearly in `_extOverlap`, and the
"no cached code on these pages" fast path of `_invalidateCode` is off while a wide extent exists (it was already effectively off,
as every page was in codePages). Result on a fresh cold build: JS heap 1.1 GB at 100 s (11,047 functions registered) instead of ~5 GB,
and 7,200 units written in 4 minutes instead of ~3,000. Engine suite green.

Also found with this: a worker's console.error is delivered only when its event loop turns, so long synchronous stretches show
no log output at all. Several earlier "nothing happens after N seconds" readings in this file were that, not inactivity.
OXWASM_DBGFILE=<path> now routes the TUTRACE/HEAPPROF diagnostics through synchronous file appends.
The cold build still dies (silently, killed by the container's OOM) after ~4 minutes: with the JS heap down to 1-2 GB the rest of
the ~9-14 GB resident is native memory (still being measured); ~54 KB of heap per registered function (registerAotFn) is next.

Cold-build memory: glibc malloc arenas
--------------------------------------
After the extent fix the cold build still died at ~4 min with the cgroup OOM killer (dmesg: anon-rss 13.7 GB). The smaps
breakdown showed ~60 mappings of ~64 MB (glibc per-thread arenas, ~3 GB resident) beside the V8 heap pages: V8's
compile threads and the worker allocate zone memory in separate arenas that never return to the OS.
Run with MALLOC_ARENA_MAX=2 and the same cold build completes in one run: rc=0, 173 s, 4133 AOT units, peak RSS ~9 GB
(was killed at 13.7 GB). Set it in the environment of the node process that hosts the sandbox (it cannot be set from inside).
A cache rebuilt from nothing under MALLOC_ARENA_MAX=2 (cold18: bundled, hinted at 20 KB) gives STEADY 388 ms best of rounds 15..29 (median ~740 ms)
against native 43 ms, i.e. 9x: same as the earlier cache, so cold rebuilds now reproduce and emitter changes can be A/B tested end to end.
NOACCT pricing probe, now possible (cold-built na1, hinted): STEADY 429 ms best (388 ms with counters). Removing the depth counter and fuel
from every call site buys nothing end to end, so the per-dispatch protocol is not what limits steady state; the registers-as-params lever
(same family) is therefore unlikely to matter either. Looking elsewhere (time split by tier, deopts, guest JIT churn).

### 128-bit divide was a deopt into the BigInt interpreter (fixed): sorting 67 -> 36 ms
A CPU profile of a sorting-only steady run (300+ rounds, JIT on) put 52 s of 214 s in the tier-0 path (interpreter step, run loop, deopt).
The hot interpreted pages were compiler-rt's __udivmodti4 (0x253a6b3, 0x253af00) and its caller 0x537f2c0: `div r64` with rdx != 0 (a true
128/64 divide) compiled to a deopt guard, so every call left the unit and ran in BigInt. udiv128Wat (engine/aot_wat.mjs) now divides inline
(Hacker's Delight divlu on 32-bit digits, about 60 wasm ops); only a quotient overflow / zero divisor still deopts, as #DE must be raised by
the interpreter. Checked standalone against BigInt (400k random + edge cases) and in engine/diff/divtest.mjs against the interpreter oracle
(3675/3675), added to engine/test.sh; the whole suite is green.
Phase-only steady runs (300 rounds), cold-rebuilt caches: sorting 67 -> 35-39 ms (native baseline-JIT ~7 ms), strings 14, json 28.
The cache has to be rebuilt for the new emitter (cold19, 7,000 units in 207 s + bundling).

### Pricing the counters properly (OXWASM_NOACCT, phase-only runs)
Cache built with NOACCT (na2) against the normal one (cold19), same phase-only 300-round runs: sorting 39 vs 35 ms, strings 25 vs 14,
json 63 vs 28. Dropping the depth counter and chain fuel does not make it faster (the unit mix is different, loops no longer yield), so the
per-call counters are not the bottleneck of steady state. Per-phase ratios against native baseline-JIT are 4x to 7x everywhere
(fib 4, math 7, objects 6, strings 5, sorting 5, maps 5-6, json 6): translation quality of many small tail-called units, not one outlier.

### JIT-on aborts and hangs (open, reproducible in 55 s)
A phase-only `maps` run (BUN_JSC_useJIT=0 so no generated code is involved, 100 rounds) aborts (rc 134) at round 35-36 in about 53 s on the
default scheduler; with BUN_JSC_useConcurrentGC=0, numberOfGCMarkers=1, OXWASM_ROTATE_MS=1 or 1000, or logGC on, it passes. `objects`
hangs at round 37; strings, json and sorting survive 300 rounds. The abort is raise(SIGABRT) from the main thread inside a JSC string helper
(cell type check on a bad argument), so it is a thread-interleaving-dependent corruption in the concurrent collector path, not a code-cache
problem: the JIT-off run fails too. Hypotheses not yet tested: register/ucontext contents of the signal-based thread suspension JSC uses
(tgkill sig 30 to 3-7 threads), futex wake ordering. madvise(DONTNEED) and MAP_FIXED now invalidate translated code over the range (they did not).

### Writes into JIT pages: exact ranges, and the stores that were never guarded (interpreted steps 6.4M -> 1.5M)
An interpreter-rip histogram of steady state (delta of two runs, OXWASM_IHIST) showed 38% of the interpreted steps in one 10-instruction
JSC thunk (string length, 0x5a234540) and most of the rest in other JIT-pool pages. They were interpreted because the pool is written
all the time (the JIT emitting its next function beside thunks it has already built) and every store into a watched page dropped every
translation on the page and, after four, made the page volatile (never translated again until 2M interpreted steps passed quietly).
- The store guard now passes the byte count (`$x_cw (addr, next, size)`); `_codeWrite` asks `_cwDisjoint` whether any translation (built,
  in flight, or of unknown extent) depends on a byte of the range and does nothing, and does not count towards volatility, when none does.
  The interpreter's own write watch is exact the same way. OXWASM_CW_PAGE=1 restores the old page-wide behaviour.
- Stores that were never guarded now are: SSE stores (movdqu/movups/movq/movhps), movs/stos (scalar and rep, range-checked), and the
  interpreter's bulk rep movs/stos (they went through a typed-array view and never reached the watch). OXWASM_CWVERIFY=1 snapshots the
  bytes of every JIT-range translation and reports any that changed without being invalidated; it found the interpreter case (a
  translation built over still-zero pool bytes, the thunks then written by an unwatched rep movs).
- A unit still being assembled whose extent is hit is now cancelled (it was only cancelled if one of its entries was on the page).
- madvise(DONTNEED) and MAP_FIXED invalidate translations over the range.
Phase mix (fib, math, strings, sorting, json; 200 rounds): STEADY 141 ms -> 104 ms, interpreted steps 6.4M -> 1.5M (strings 19 -> 10 ms).
The cache must be rebuilt (the import signature changed); engine suite green.
The abort/hang is NOT explained by any of this: with the verifier on no stale translation is reported any more and the run still aborts at
round 5 in about half the runs, with page-wide invalidation (OXWASM_CW_PAGE=1) as well.

### The store guard: what was wrong with it, and what it costs now (objects phase 150 ms -> 15-18 ms in the good case)
Measured with phase-only runs (`objects`, 60 rounds): the guard host call (`$x_cw`) was being made 10-20 million times per run, about the
entire cost of the phase (150 ms per round against 15 ms with the guard off). Causes, in the order found:
- The map marked every 4 KB page of the whole anonymous-executable range; the JIT pool shares pages with data (hash tables). The guard now
  reads a bitmap with one bit per 64-byte line (CWBM past the end of guest RAM, base in regfile slot 176) and only lines holding bytes
  a translation was built from are set: `compileUnitWat` returns the merged block spans per function next to the hull. Lines are
  widened 15 bytes to the left so a store that starts just before a span and runs into it is seen. Stack (rsp/rbp-based) and fs-relative
  stores skip the guard (OXWASM_GUARD_STACK=1 guards them).
- Marks were never cleared: a translation that was dropped left its lines marked, so memory the pool later reused for data kept calling
  into the engine. `_invalidateCode` now unmarks the lines no other translation covers.
- A page that became volatile stopped being watched but its remaining translations were kept; a later patch to one of them went unseen
  and stale code ran (found with OXWASM_CWVERIFY: a call's rel32 changed under a live translation). The transition now drops every
  translation on the page first.
- Static units cached before this change had no guards at all (the unit cache only gets STOREGUARD code if it was built with
  OXWASM_STOREGUARD=1). coldbuild.sh now takes EXTRA="OXWASM_STOREGUARD=1 OXWASM_EXEC_ANON=1" and the steady runs must use a cache built that way.
- The first version of the bitmap code walked every 64-byte line of a static function's span (megabytes) on each invalidation; spans are
  clipped to the window first. (A cold build with the guard on took 1000+ s and did not finish before that.)
Objects-only runs (6): no aborts, 15-18 ms in the good runs and 70-98 ms in the others (the others still make 0.2-2M host calls: a line
shared by code and data, or a volatile page whose hot code stays interpreted).
Still open: the full mix (fib, math, objects, strings, sorting, maps, json) aborts in about 40% of runs at round 5-8 inside the json
phase; no pair or triple of phases does it (objects+strings+json passes 5/5), five or more do. No stale translation is reported by
OXWASM_CWVERIFY in those runs, and it is not the function table growing (OXWASM_FTAB_INIT=20000 fails the same way).
Engine suite green.

### Where the full-mix abort stands (bisect notes)
- It needs breadth: phase pairs and the triple objects+strings+json never fail (5/5 each); sets of five or more phases abort in about
  40% of runs at round 5-8, always inside the json phase, as raise(SIGABRT) from the main thread in a JSC string helper. JIT off,
  stale-translation verifier, function table growth, loop yield, concurrent JIT and zero-on-free all fail to explain or cure it.
- Vetoing the JIT function root 5a261a00 (the `strings` loop with the inline allocator) passed 6/6 once, but escaping every
  instruction in 5a261a00-5a262400 (OXWASM_ESC_RANGES) still aborts, so that was timing, not a miscompile. A random-state
  differential of that function (AOT vs interpreter, engine fuzz harness, 20,000 states) found no divergence.
- Diagnostics left in: OXWASM_ESC_RANGES, OXWASM_IDLEDIAG, OXWASM_CWHIST, OXWASM_CWVERIFY, OXWASM_DUMPFN (24 KB, needs OXWASM_FNDUMP set).
Good-case numbers now (cold23, phase-only 60-300 rounds): objects 15-18 ms, strings 9-14, sorting 35, json 23-28, fib 4, math 21,
maps 53-73; against native baseline-JIT 3 / 2-3 / 7 / 4-5 / 1 / 3 / 8-13 that is 4x to 7x per phase.

### Re-translating a volatile page sooner (objects 70-100 ms -> 16-19 ms)
Objects-only runs were bimodal: 15-18 ms, or 70-100 ms when a page holding the hot loop became volatile (four real patches) and stayed
untranslated until 2M interpreted steps passed without a write. OXWASM_CW_QUIET=100000 (now the default; 20000 churns more) gave
16-19 ms in 5 of 6 runs. The full seven-phase mix still aborts (3 of 4 runs at round 5-26 with the new default), so the crash is unrelated.

### GC threading and the abort
Full mix with BUN_JSC_useConcurrentGC=0 BUN_JSC_numberOfGCMarkers=1: 8 of 9 runs finished (STEADY 191, 233, 260 ms in the 30-round ones), against about 40% finishing
with the defaults; BUN_JSC_useBaselineJITCodeSharing=0 does nothing (1 of 5). So the collector's threads are involved in the abort but not the whole story; one run still aborted at round 5.

### Not memory, not growth factor
Guest RAM 1024 vs 3000 vs 3800 MB: the full mix aborts at every size (3800 MB: 4 aborts + 1 hang in 5). mmap totals at abort show only the 128 GB reservation and a few 1 GB arenas, no failed mmap.
BUN_JSC_*HeapGrowthFactor 3/8/16 with or without single-threaded GC: any mix containing `objects` aborts. Runtime-only flag changes (LOOPYIELD, NOACCT, NOXMMCALL) change the unit-cache key and so measure
an empty cache, not the flag; those numbers (127 ms) are invalid, only caches built with the flag count.

### Abort vs JIT code lifetime
BUN_JSC_forceCodeBlockLiveness=true (JSC never frees compiled code) cuts the 4-phase abort rate from ~50% to 0 of 6 (one hang): the abort needs JIT memory to be freed and reused.
Gaps found with OXWASM_CWVERIFY and fixed: (1) a translation entered in one page that spans into a volatile page lost its guard bits there (bits are now set regardless of volatility);
(2) functions of one wasm module call each other directly, so invalidating one now drops its unit siblings. Verifier runs after the fixes show a stale translation in only some runs and
the abort still happens without one (run 5 of 6), so there is at least one more path by which freed/reused JIT memory breaks a translation. Suite green.

### Abort: what is established (single-threaded JSC, deterministic enough to bisect)
- BUN_JSC_useConcurrentJIT=0 BUN_JSC_useConcurrentGC=0 BUN_JSC_numberOfGCMarkers=1 (no JSC helper threads at all): the full mix still aborts at round 5 in 4 of 4 runs; with BUN_JSC_useJIT=0 it finishes 30 rounds in 3 of 3 (STEADY 620-680 ms). So it is the baseline JIT's code, not threads and not the collector.
- BUN_JSC_forceCodeBlockToJettisonDueToOldAge=true makes it fail early and deterministically (TypeError on `for (const [k, v] of m)` in maps at round 1, or abort); native is fine with the same option. It needs the full mix (maps alone, or maps after any one other phase, passes).
- Not invalidation granularity (OXWASM_CW_PAGE=1 fails the same), not stale bytes (the verifier reports none), not inlining (OXWASM_INLINE=0 fails), not memory size.
- Escaping (interpreting) either the thunk half 5a000000-5a240000 or the code-block half 5a240000-5b000000 of the JIT window alone lets 4 rounds finish under the jettison stress (rounds are 120-210 s each), so both halves have to be translated for it to fail.

Root-veto bisect under the jettison stress (50 JIT roots, groups of five, up to 3-6 runs each): one group passed 3 of 3 once and then failed in a re-run, and every single root, pair and subset tried also failed,
so the per-run failure rate is too high and too noisy (~60% or more) for run-count bisecting to separate roots; it needs a deterministic replay, not more runs.

### A real translation bug found by the shadow compare: cvttsd2si overflow
With the shadow comparator told to ignore the callee's dead stack frame (stores below the entry rsp), a jettison-stress run finally reported a live divergence: in a JIT function that converts the
LCG value `x*1103515245+12345` (about 2^61) to int32, AOT produced INT_MAX as a double and the interpreter produced -2147483648.0. The scalar `cvtt(s|d)s2si` / `cvt(s|d)2si` forms were
emitted with wasm `trunc_sat`, which clamps; x86 answers the "integer indefinite" (0x80000000, or 0x8000000000000000 for 64-bit) for NaN and anything out of range, and JSC's overflow test
(`cmp eax, 0x80000000`) therefore never fired. Fixed with a range select; engine/diff/cvtsi2test.mjs checks 156 cases (the interpreter oracle also got the cvtsd2si round-to-nearest-EVEN fix:
Math.round broke ties upward). The abort is NOT cured by this alone (cold26, rebuilt: 2 of 4 full-mix runs still abort), but this class of bug is exactly what the shadow compare finds; more remain.

### Shadow compare on the rebuilt cache (cvtt fix): no live divergence left
Jettison-stress full-mix shadow run over the whole JIT window (5a000000-5b000000) on the rebuilt cache: every reported divergence is a false positive. (1) fn 0x5a2608f3/0x5a2607f9 differ only in r11 at the exit after a syscall (rflags left by `syscall`; the shadow now ignores a flags-sized r11). (2) fn 0x5a224220 differs in an xmm1 double and the heap bytes it is stored to: the values are whole milliseconds in nanoseconds (203000000 vs 226000000, 399000000 vs 419000000), i.e. a clock read taken at different times by the two replays. So the abort is not a divergence the shadow comparator can see with this setup; remaining suspects are things the replay does not model (code being rewritten while translated code runs, self-modifying patch sites, concurrent writes between dispatches).

### Abort/TypeError hunt: what the bisects did and did not show
- The remaining failure is stochastic: roughly 35% of jettison-stress full-mix runs (3 rounds) fail with the same seed (OXWASM_DETRANDOM) too, so clocks and thread scheduling still vary the outcome. A one-run-per-probe bisect over ESC_RANGES therefore converges on noise (a 12-step bisect landed on a 48-byte range; replaying that range 3x gave fail/pass/fail against the control's pass/fail/fail).
- Symptoms are all iteration-protocol failures: `for (const [k, v] of m)` giving undefined, `0 is not a function (near '...e of o...')`, and an abort in a JSC helper whose guard is "this cell is an object" (a cell with JSType <= 0x20 where an object was expected): a wrong value loaded, not a crash in the translator.
- Escaping the whole LLInt handler range 25a0000-25d0000 passed 8 of 8 runs (about 3% chance at a 35% baseline), but neither half of it, nor any quarter, eighth, ... cured the failure in a statistical bisect (N=8): every half failed at every step. So there is no single bad instruction there; either several handlers matter or interpreting all of the LLInt handlers just slows the process enough to change when the baseline JIT tiers up and when the collector runs.
- Shadow compare, whole JIT window and bun text slices, with clock reads replayed and rflags in r11 ignored: no real divergence. The recurring "differences" are dead callee frames (the AOT elides callee-saved push/pop slots) and clock values.
- The opcode-table initializer 25a632c-25a9c9a (the code the first noisy bisect pointed at) matches the interpreter on 30 random states.
- NARROW=0 (spill/reload narrowing off): 1 failure in 6 runs, baseline 1 in 6: no signal.

### Invalidation walked tables of tens of thousands of keys per code write (objects 64 ms -> 23 ms)
A CPU profile of a 200-round objects run put 121 s of 320 s in `_invalidateCode` itself: every store that hit translated JIT code walked `_ftSeen`, `aotCalls`, `compiled`, `profile`, `aotFailed` and the four memo tables in full to find the few keys in the written range. These tables are now indexed by page (`PagedMap`/`PagedSet.keysIn`), and a write of a few pages looks only at the keys on them (a range wider than 64 pages still scans). Same run afterwards: 190 s total CPU, `_invalidateCode` out of the profile, objects steady state 23 ms (it was 64 ms in the same configuration). Suite green.

### Two guard "optimisations" that made things worse (reverted)
- Bulk stores (`rep movs/stos`) call the host for every run that overlaps the guard window, and 99.9% of those calls find no translated code (220,000 in a 100 s objects run). Testing the line bitmap first (first, middle and last line of runs up to 128 bytes) removes the calls but is unsafe: the bitmap only knows lines of registered translations, so a unit still being assembled, and the exact-extent bookkeeping behind `_cwDisjoint`, are bypassed. Steady objects went from 22 ms to 100-125 ms with hangs (2 of 4 runs). Reverted; the cost of the redundant calls is small next to that.
- Ignoring cancelled in-flight units in `_cwDisjoint` had the same effect (22 ms -> 100+ ms, hangs) and was reverted. Reproduce with 4 runs each: HEAD on cache cold26 gives 22/22/23 ms and one abort; each of the two changes gives 100-130 ms and hangs.
- Each call counts: a run-to-run spread of 22 to 130 ms with the same binary is normal for objects alone, so a single run proves nothing; compare at least four.

### Where the full-mix abort stands after the A/B sweeps (negative and narrowing results)
- In the baseline-abort configuration (BUN_JSC_useConcurrentJIT=0 useConcurrentGC=0 numberOfGCMarkers=1, 10-20 rounds) the full mix aborts in 7 of 8 and 3 of 3 runs, at about round 5 and right after the last baseline-JIT compile line in BUN_JSC_verboseCompilation (the nine functions tier up in one batch). Each phase alone (14 rounds, 3 runs each, 21 runs) never aborts: the failure needs the combination.
- A/B of JSC options, 8 runs each: base 7 failed; `useIterationIntrinsics=false` 3 failed (aborts move later, 96-105 s instead of 75-80 s); `forceICFailure=true` 8 failed; `useLLIntICs=false` 8 failed. So the iteration intrinsics (op_iterator_open/next fast paths) are involved but not the whole story.
- ESC_RANGES (instructions in the range always interpreted), base config, 4 runs per probe: JIT window 5a000000-5b000000: no abort (too slow to finish, so only "needs translated JIT code"); bun text 24c8400-3f00000: fails; bun text 3f00000-5baeb70: no abort but too slow to tell; JIT code-block half 5a240000-5b000000: 2 of 2 runs finish with no abort; thunk half 5a000000-5a240000: inconclusive (too slow). Bisecting inside the code-block half stalls because interpreting half of it reaches round 0 only after the guard time.
- Shadow compare over 5a240000-5b000000 in this configuration: 3063 s, no result (too slow).
- V8 side: `--experimental-wasm-inlining` and a 10x inlining budget leave steady state unchanged (objects/sorting/maps 22/50/70 ms either way). Explicit wasm bounds checks cost 20% on a cache-resident loop, and the worker runs at the trap-handler speed (170 ms against 166 ms on the main thread), so there is no hidden bounds-check penalty.
- Steady state does not re-translate: a 200-round objects run translates 150 units totalling 2.9 s of 89 s, almost all of it start-up and shutdown. Function entries (OXWASM_COUNTCALLS) are about 35,000 per objects round (22 ms): the dispatch protocol is a few percent of objects, so its price (8-12 ns per entry) is not the gap there. Fib is the call-bound phase (4 ms against 1 ms native).
- The GC option matters for the number you compare: with JSC defaults (concurrent GC on the helper threads) objects steady-states at 22 ms; with useConcurrentGC=0 and one marker a 14-round solo objects run measures 95 ms (not yet warmed up at 14 rounds, and the collector runs on the main thread).

### Where the abort comes from (data from abort-time dumps) and what does not cure it
OXWASM_ABORTDIAG=1 now dumps, at the abort: the raw stack, the JIT frame (rbp of the nearest JIT return address) with the cells its slots point at, and 6 KB of JIT code before the return address. Findings, 6 aborts, all the same stack:
- The abort is JSC's release assert in `jsAddSlowCase` (the JS `+` slow path): reached from `operationValueAddProfiled(globalObject, left, right, profile)`, called by the baseline JIT's add thunk, with an operand that is a cell whose JSType is an internal, non-object type (here a JSString/atom cell where an object or number was expected, or a stack address / 0).
- In the dumped JIT frame the local slots hold pointers into blocks of 16-byte string cells (headers `500200a1 00020800`, StringImpl pointers 57098d80, ...), including the slot the property loads read from. A pointer to an object that now points into reused string cells is what a premature free followed by reuse looks like.
- It is not the generational collector's remembered set: BUN_JSC_useGenerationalGC=false still fails 7 of 8. It is not stale translations (CWVERIFY reports none). `forceCodeBlockLiveness=true`, which an earlier note recorded as 0 of 6 failures, fails 5 of 8 full-mix runs here (30 rounds): that earlier result was luck or a different configuration, so it is NOT a workaround.
- Compile-time matters: jitPolicyScale=0.05 (baseline compile much earlier) fails 1 of 6, jitPolicyScale=20 fails 4 of 6.
- The two successful 30-round full-mix runs measured 242 and 265 ms steady state (fib 4, math 25, objects 23, strings 13, sorting 51, maps 68, json 33 ms; native 1, 5, 3, 3, 9, 13, 5).

### What the abort-time dumps say, and one more negative (loop-free driver)
- At the abort the JIT frame's local slots that feed the `+` (rbp-0x80, rbp-0x88) hold stale stack garbage (a JIT return address, 0), and the slot that holds the iterated object points into a block of 16-byte string cells. The add thunk at 5a2315c0 (int32 fast path, double path, profile update `or word [r11], 0x1b`, slow path to `operationValueAddProfiled`) is correct x86 for those inputs; the inputs are wrong before it runs.
- Disabling inline caches does not change the rate (`forceICFailure=true` 8 of 8 fail), nor the generational collector (`useGenerationalGC=false` 7 of 8 fail), nor never freeing code blocks (`forceCodeBlockLiveness=true` 5 of 8 fail), nor a loop-free benchmark driver (rounds scheduled with setImmediate: 3 aborts, 4 hangs, 1 ok of 8).
- The decoder is not the cause for the code examined: 3.5 million decoded GPR/memory operands and 261,000 SSE operands in the bun text (24c8400-3400000) agree with objdump.
- Escaping the JIT code-block half from translation (5a240000-5b000000, i.e. interpreting it) removes the abort in 2 of 2 runs; so it is in how translated JIT code and the interpreter/other translated code interact, or in the translation of that code, and the shadow comparator over 5a240000 ranges is too slow to catch it before its time limit.

### First real divergence in the JIT window: JIT epilogue thunk -> LLInt call return (unresolved)
With the shadow compare limited to short dispatches (OXWASM_SHADOW_CAP=3000 OXWASM_SHADOW_CAP2=0, range 5a000000-5a240000, base abort configuration) one divergence shows up in about half of the runs, always the same shape:
- fn 0x5a224060 is the JIT function epilogue thunk (`mov r12,[rbp-0x20]; mov r13,[rbp-0x18]; mov r14,[rbp-0x10]; mov r15,[rbp-8]; mov rsp,rbp; pop rbp; ret`). The `ret` returns into the LLInt `op_call` continuation at 25c4f7c, and the chain runs through about 190 interpreter steps of LLInt handlers to the exit 0x49598a7f.
- At that exit the compiled run has changed 4 bytes at rsp0+0x60..0x63 (f3dd5b90, i.e. rbp-0x30 of the calling JIT frame, the argument-count slot of the callee frame header that the next LLInt `op_call` writes with `mov [rcx+0x20], edx`) to a value that is not a small count (0x3573507d, 0x...), and the interpreter's replay did not write those bytes at all although its trace passes through 25c4f3c, the store.
- Both the old content and the new content look like random 32-bit values, so the AOT run writes a stale register or an uninitialised value there. This is the first divergence located in the translated JIT/LLInt chain and is the lead for the abort (the corrupted frame slots seen at the abort are of exactly this kind). Not yet root-caused: the next step is a store-by-store trace of this chain (the engine's page watch on f3dd5b90) comparing the AOT and the interpreter.

## Pricing the generated code by its machine code (tools: scratch watsize/snip), and the guard redesign
V8's `--print-wasm-code` gives the TurboFan machine code for a unit, so an emitter change can be priced in seconds instead of a
6-minute cache rebuild. Six hot functions of the objects/maps phases (50eee60, 5109300, 47ae960, 51069e0, 28f8220, 6d02b5; 8,100
bytes of x86 between them) compile to:

    base emitter (window bitmap guard)                     113,708 bytes   (14x the x86)
    guard off (pricing only, unsafe)                        80,804
    narrowing off (OXWASM_NARROW=0)                        132,604         (narrowing is worth 14%)
    NOACCT (fuel and nest off, unsound for yields)         104,796
    byte-map guard (one load and branch per store)         105,284
      + folded call check (one unsigned compare)           104,616
      + OXWASM_NOFUEL=1 (no chain fuel: node has no slices) 99,692
      + OXWASM_LOOPYIELD=0 (no back-edge budget, no nest)   85,648
      + i32 flag conditions for 32/16/8-bit sizes           85,676         (conditions were not the cost)
      + mask peephole (and 0xFFFFFFFF -> wrap/extend)       84,432         (V8 folded most masks already)

- Byte-map guard: one byte per 64-byte line over the whole guest memory, indexed by the store's wasm address (`CWBM` region past
  guest RAM, `CWBMLEN = ramPages * 1024`), replacing the window-relative bit map: a store costs `load8_u(map + (addr >> 6))` and a
  branch instead of two slot loads, a subtract, a compare and a bit test. The engine's marking and the interpreter's watch window are
  unchanged in meaning; only lines inside the anonymous executable ranges are ever marked. Suite green.
- The folded call check: `(fti >> 31) | depth | -(fuel == 0)` compared unsigned against the limit, one compare instead of three setcc chains.
- A 16-instruction JSC-style snippet (loads, a structure check, `add ecx,1; jo`, a guarded store) is 58 bytes of x86 and 404 bytes of
  machine code: a V8 frame and stack check, 8 regfile loads at entry, the depth tax, 4-8 regfile stores and the frame teardown at each
  `ret`, and the guard's deferred call block are most of it; the straight-line body itself is 2-3 machine instructions per x86 instruction.
- A cross-unit call site is about 60 machine instructions (regfile spills, inline-cache probe, the check, fuel/nest/depth updates, the
  indirect call's bounds and signature checks, reloads, the return-address check) plus the callee's ~20 of entry and exit, against
  `call`/`ret` natively. JSC's baseline code calls a thunk for almost everything, so this is the lever that is left: either inline the
  small callees into their callers (un-pruning, `OXWASM_UNPRUNE_TINY`) or change the ABI so registers stay in wasm locals across calls.
Runtime measurements of each build (cold61 byte-map guard, cold62 current emitter, cold63 node-mode knobs, cold64 un-prune 64) follow.

### Call density in JSC's baseline code, and the guard at run time
- 6 KB of baseline-JIT code captured at an abort (1,321 instructions) holds 80 calls, one every 16 instructions, most to a dozen thunks
  (10 to 5a224220 alone). At the ~80 machine instructions a translated call costs, the calls are most of what the translated JIT code
  executes, which is why the per-instruction expansion of 2-3x in straight-line code does not explain the 6-9x.
- The store guard at run time: a cache built without it (unsafe; it does not even finish `--version` reliably) ran sorting at 50-51 ms and
  maps at 73 ms, the same as with the guard. Its 29% of the machine code is the deferred slow-path blocks, which are cold.
- Suite runs for this round: suite 2 (byte-map guard) green; suite 3 one failure in an isolation test that asserts a sandbox timeout,
  during the disk-full outage; suite 4 (same code, after the outage) green. Committed as efe513b.

### Run-time results of the emitter changes, and a reverted "heal" of stale guard marks
- cold62 (byte-map guard, folded check, i32 conditions, peephole; 25% less machine code than the old emitter) runs exactly like the
  old cache: sorting 48-50 ms, maps 78-82, json 42-43, fib 4, math 23-24, strings 28-56, objects 111 or abort, full mix 272 ms
  (fib 4, math 25, objects 23, strings 17, sorting 53, maps 72, json 34). Machine-code size is not what the time is spent on.
- Clearing a marked guard line when a store's host call finds no translation covering it (so a stale mark stops calling in on
  every store) was tried as an engine-only change on the same cache: objects-only aborted 4 of 4 (with CWVERIFY, no stale
  translation reported), and the two full-mix runs that finished were 346 and 456 ms with objects at 31 and 52 ms. Reverted.
  The slow objects mode is therefore not only stale marks; the 9.2M-call storm seen once was one of its shapes, not its cause.

### Function entries per round: 13 million (OXWASM_COUNTCALLS, printed at each write syscall)
A full-mix round (fib, math, objects, strings, sorting, maps, json; 28-39 ms natively) enters 7.3-13.3 million translated wasm
functions, with only 1.5-15 thousand interpreted steps and 110-650 host dispatches. At 5 ns an entry the entries alone are 65 ms,
twice the whole native round, and the measured cost of a cross-unit call site (about 60 machine instructions plus the callee's 20) is
more like 10-15 ns. So the gap is the number of guest calls times the translated call protocol, and the straight-line code quality,
the guard, the counters and the interpreter are second order. The levers are the number of entries (inlining callees so the call
disappears; cold64 tests OXWASM_UNPRUNE_TINY=64) and the protocol itself (registers in wasm locals across calls instead of the
regfile round trip).

### cold63: OXWASM_NOFUEL=1 OXWASM_LOOPYIELD=0 (node mode)
Solo phases, 60 rounds, 2 runs each: sorting 45/46 ms (cold62: 48/50), maps 67/76 (78/82), json 41/37 (42/43), strings 12/12 (28/56),
objects 21 (good mode; the other run aborted), fib 4, math 23. Full mix 268 ms (fib 5, math 23, objects 22, strings 11, sorting 45,
maps 85, json 31) against 272. Each 60-round solo run completed in 52-62 s against 69-89 s: with no loop yield the warm-up
re-dispatches far less. A 5-10% steady-state gain, and the configuration to use on node. Aborts: 3 of 17 runs, as before.

### cold64: + OXWASM_UNPRUNE_TINY=64 (callees up to 64 instructions duplicated into their callers' units and inlined in loops)
Build: 310 s for the first round (5,320 units; the duplication is cheap at this size). Solo phases as cold63 except maps 65/71 ms
(67/76). Full mix 215 ms (fib 4, math 23, objects 21, strings 12, sorting 47, maps 63, json 34), the best so far against 268 (cold63)
and 272 (cold62). fib stays at 4 ms, so the calls that cost in the call-bound phase were not inlined (JIT function to JIT function
calls are bigger than the tiny threshold); cold66 counts the entries under this configuration. Aborts 3 of 17 runs, as before.

### Entries per round by phase (cold42, OXWASM_COUNTCALLS), and the objects slow mode is 13x the entries
    fib      150k entries   5 ms  (native 1)    2 entries per JS call, 33 ns an entry
    math     900k          24 ms  (5)           3 entries per iteration of a typed-array loop: the baseline JIT calls a thunk per arithmetic op
    strings  430k          15 ms  (3)
    json     665k          44 ms  (5)
    sorting  1.62M         51 ms  (9)
    maps     2.12M         79 ms  (13)
    objects  678k or 8.5-9.6M     46 ms in this run (3)
The objects phase does the same work in both modes; the slow mode makes 150 translated-function entries per loop iteration against
11, which is what every property access taking its slow path looks like, i.e. an inline cache that never hits. A translation built
from an IC's old immediate would do exactly that; the stale-translation verifier (OXWASM_CWVERIFY) can confirm or exclude it.
Clearing stale guard marks (the "heal") did not change the mode (control: 24, 112, 129 ms and one abort in 4 runs).

### Un-pruning does not cut the entries; larger inline budgets miscompile
- cold66 (cold64's knobs + OXWASM_COUNTCALLS): 7.1-7.8M entries per full-mix round, against 7.3-13.3M on the old cache (the spread
  there is the objects slow mode), full mix 268 ms. The 64-instruction un-prune inlines few of the calls that cost: the JIT code's
  calls go to other JIT functions and to thunks that themselves call into C++, neither of which inlining removes.
- cold65 (OXWASM_UNPRUNE_TINY=160 OXWASM_INLINE_TOTAL=2000 OXWASM_INLINE_BUDGET=200): `opencode --version` exits 127 within 6 s on
  every build round; the aggressive inlining miscompiles something. Not usable as is.
- Where that leaves the gap: at ~7.3M entries a round and ~15 ns a translated call, the call protocol is ~110 ms of a 215-268 ms
  round and the body expansion (2-3x) is most of the rest. Halving the protocol with a register-passing ABI is a large refactor
  worth ~25% of the round; neither it nor inlining reaches 1.2x native from here. The two items that still move the number are
  the objects slow mode (13x the entries, worth 5x on that phase and the mix variance) and the corruption bug, which also blocks
  DFG, the tier that would remove most of the thunk calls at the source.

### The JIT-window divergence, captured with a store watch: the extra write is an unguarded stack store
Shadow compare over the thunk half with OXWASM_WATCHPAGE/WATCHADDR on the diverging slot (f3dd5b90): in the divergent dispatch
(disp 26197, entry 5a224060, 199 interpreter steps to the exit) the watch log holds NO compiled store to the slot, so the bytes the
compiled run changed were written by a store the guard does not cover: an rsp- or rbp-relative store without an index (a push, a
call's return-address push, LLInt's `mov [rsp],rdx` at 25c4f71 while setting up the callee frame). The interpreter's replay of the
same chain executes those same instructions and writes elsewhere, so rsp or rbp differed between the two mid-chain and agreed
again by the exit (LLInt resets rsp from the CodeBlock at 25c4f9b, which hides an earlier drift). Next: a cache built with
OXWASM_GUARD_STACK=1 so the watch log names the compiled stack store, and the shadow trace now carries rsp per step.

### The slow mode is a stale translation, and there is a store the guard does not see
objects alone on the counting cache with OXWASM_CWVERIFY=1, five runs: the verifier reports 3-18 stale translations in EVERY run
(translations still registered whose source bytes have changed), and the slow mode (entries jumping from 0.68M to 6-9.7M a round
mid-run) appears in the runs where a hot one goes stale. The example repeats at the same address in three runs: translation
fn=5a2601f3 (extent 5a2600f9+2316), the last 4 bytes, a jump's rel32 patched from +0x735 to -0x10a05 (JSC relinking a jump to a
stub). The engine's recent-writes ring never saw a write there, but the ring is a dozen entries and the verifier runs every 256
writes, so that is inconclusive. Excluded by reading: the loop tier (inactive: compiledRuns=0), the bulk copies (range-guarded),
the interpreter (every size watched), the inline-cache probe (it reads the hash table that _ftDrop tombstones), slot reuse (slots
are not reused until a full rebuild), CPUID (baseline/v2, so glibc's memcpy uses SSE stores the guard covers). Still open: the
guard skips rsp/rbp-based stores without an index (OXWASM_GUARD_STACK=0), and anything else is unknown. Queued: a watch on the
4 bytes at 5a260a01 on the normal cache and on one built with OXWASM_GUARD_STACK=1, logging every store with its rip.

### The JIT-window "divergence" withdrawn: it was clock_gettime's timespec
With stack stores guarded too (cold67, OXWASM_GUARD_STACK=1) the watch on the diverging slot still logged no compiled store in the
divergent dispatch; the slot's old bytes were 0x288b4f86 = 680,480,646, a tv_nsec, written by the interpreter's clock_gettime in
the previous dispatch. clock_gettime and gettimeofday wrote their results into the wasm buffer directly, outside the memory journal
the shadow comparator replays, so the clock's own output read as a stray store. Both now journal their destination (jsnap). The
other divergence in that run (rdi/r8/r9 at a C++ allocation) is the replay re-executing an allocation. So the shadow comparator has
found nothing real in the JIT window; the stale translations the verifier reports are the lead.

### cold65's failure is a wasm trap in ld.so
With OXWASM_CHILD_ERRORS=1: "memory access out of bounds" at rip c598b00 (the dynamic linker's mapping) within 4 s of `--version`.
The larger inline budgets (TINY=160, TOTAL=2000, BUDGET=200) miscompile an inlined site in ld.so; the default budgets do not reach
it. Deterministic, so bisectable with OXWASM_INLINE_ONLY when the inliner is next worked on; not the default-configuration bug.

### Found: the unguarded store was an rbp-based store from frame-pointer-omitting C++
Tracing every set and clear of the guard line holding 5a260a01 (OXWASM_CWTRACE) showed the line marked at the time of the patch
and no x_cw call for it: the store never reached the guard. The emitter skipped the guard on every rsp- or rbp-based store
without an index (stack and frame slots never hold code), but C++ built with frame-pointer omission - libJavaScriptCore's
repatching code included - uses rbp as a general register, and JSC's `mov [rbp+disp], r32` of a jump's rel32 went straight
through. Fix (aot_wat.mjs): rbp counts as a frame pointer only in a function that sets it up as one (`mov rbp, rsp` or a
`leave`) and never writes it otherwise; an inlined callee using rbp as scratch counts as a write, so the skip is off for the
whole copy. On a cache built with the rule (cold68) CWVERIFY reports stale=0 across every run; before, 3-18 per run.

Two more things turned up on the way:
- The unit store wrote and later read empty .wasm files (23 of 8,021 in cold68, 6 in cold42): an assembler that answered with
  no bytes. Each failed every later run with "WebAssembly.Module(): BufferSource argument is empty" and stayed interpreted
  (278e310 x341 was the hottest). The store now refuses to write an empty unit and treats one on disk as a miss and unlinks it.
- The harness's own tail (sh, date, tail, kill after the rounds) and the guest's processes before bun (python, the shell)
  translate 300-400 units per run under program ids that change every run (their file mappings land at different addresses),
  so a whole-run profile is dominated by their translation and must be windowed to the rounds. The bench now takes an optional
  trailing Bun.sleepSync so the rounds end at a visible idle gap in the profile (proftl.mjs / profwin.mjs --to=).

### Where a steady objects round goes now (cold68, V8 CPU profile windowed to the rounds)
Rounds are 90% wasm self time; the engine's dispatch, translation, interpretation and V8 GC are the remaining 10%. The entries
per round are 150k (down from 678k; the stale translations were bouncing between old and new code). But the rounds are still
150-400 ms against a native phase of a few ms, and a single translated function (index 3633 of one module) is 22% of the
window by itself. The cached units carry no names, so the next step is a cache built with OXWASM_DEBUGNAMES=1 (cold69) and the
same profile, to name that function and the hot single-function JIT units (wasm-function[7] of a dozen small modules).

### The objects round is JSC's garbage collector, 43x slower per pause than native
Native objects(30000): 6 ms a round (3-13), 45 GC pauses over 12 rounds totalling 31 ms (0.68 ms each, BUN_JSC_logGC=1).
oxwasm (cold68): 140-700 ms a round, and the GC log's last 30 KB alone holds 101 pauses totalling 2,998 ms (29.7 ms each).
The named profile (cold69) agrees: the hottest translated functions in the rounds are JSC heap routines (f_50eee60,
f_5109300, f_47be830, f_478c050: 1,000-byte frames, bitmap and block-walking loops), not the JIT'd JS. Turning off the parallel
markers and the concurrent GC/JIT (BUN_JSC_numberOfGCMarkers=1, useConcurrentGC=0, useConcurrentJIT=0) changes nothing, so it is
not helper threads spinning under the time slicer; the marking and sweeping code itself runs ~40x slower than native, against
the 3-8x a translated C++ loop should cost. Queued: the deopt/callout log for those functions and their emitted WAT (a cold
cache with OXWASM_WATDIR), to find the instruction forms they hit that leave compiled code.

### Per-round engine counters, and what the variance is not
`[calls-w]` (OXWASM_COUNTCALLS=1) now prints, at every write syscall of the opencode process, the deltas since the last one:
wall ms, translation ms and count, invalidations, guarded stores reaching the engine (cw), deopts, callouts without a unit,
volatile pages, syscalls and their ms, and the V8 heap. On cold68 (objects, 12 rounds) a round reads for example
`ms=60 tu=0 inval=0 cw=0 deopt=2 callout=9 sys=128/0ms` - and that round took 60 ms, ten times native and the floor so far -
while `ms=796 cw=270001` was a round in which 270k guarded stores reached the engine: the JIT writes data (inline-cache slots,
counters) into lines that also hold code it no longer has a translation for, and a line stays marked until something unmarks
it. _codeWrite now clears a line on the disjoint store that finds it, when no registered translation covers the line
(`_cwLineCovered`, the same test the unmark path uses); after that cw is 0-4 a round.
What the counters rule out for the remaining 120-1,900 ms rounds: not translation (0-35 ms), not interpretation (hundreds to
a few thousand instructions), not syscalls (0-12 ms), not V8's GC (--trace-gc: 2.2 s in a 30 s run, --max-semi-space-size=128
changes nothing), not Liftoff (--no-liftoff and eager TurboFan change nothing), not JSC's helper threads. The slow rounds are
JSC's own collections: count per run matches native (12 vs 8), cost per pause is 40x. The indirect-call protocol in the
collector's visit loop (u_5109300, V8 machine code) is ~75 instructions plus the callee's entry against native's three, and
the straight-line code is ~8-12 machine instructions per guest instruction, so the marking code pays both.

### The jsAddSlowCase abort is a collector-thread interleaving bug, not stale code
With stale translations gone (cold68, CWVERIFY stale=0) the full mix still aborted, now 3/3, always after round 4, with one
signature: JSC's jsAddSlowCase (5637390) finds a `+` operand that is a cell of an impossible JSType - a freed cell still
referenced from the JS frame, which is what a missed GC root looks like. Bisecting the phases: no single phase aborts, nor any
pair; strings+json+math does, and adding fib to those three does not - heap-layout and timing dependent. Decisive:
BUN_JSC_useConcurrentGC=0 removes it (3/3 complete, control aborts), and so do OXWASM_ROTATE_MS=1 and =1000 against the
default 10 ms quantum (3/3 each). The bug is in how the collector thread and the mutator interleave under the engine's
scheduler - the suspend signal's ucontext, the stack bounds the conservative scan reads, or a safepoint the mutator reaches
with registers the collector cannot see. Then the full mix aborted
or hung with BUN_JSC_useConcurrentGC=0 too (2 aborts, 1 hang in 3), so the collector thread is a contributor, not the cause;
the three strings+json+math passes were luck at a lower rate.

What the full mix shows, every time, at round 5 (36-45 s in): either the abort above or a hang in which the engine stops
dispatching altogether (OXWASM_HEARTBEAT: the last line at ~50 s, nothing after; IDLEDIAG shows only the harness's sh and
sleep idle). Ruled out one by one, each with 2-4 runs of the mix: the line heal (OXWASM_CW_NOHEAL=1), a dispatch-table
rebuild (ftRebuild=0 at the abort), a stale xmm half of the register file after a compiled syscall hop (OXWASM_XMM_EAGER=1
syncs it eagerly), volatile pages (OXWASM_CW_VOLATILE=1000), the preemption quantum (1 and 1000 ms pass 3/3 but the mix was
not retried under them), Liftoff. Switching to the interpreter before round 5 (OXWASM_AOTSTOP) is too slow to reach it.
The abort diagnostic now also dumps the dispatch ring (OXWASM_DISPRING), the last 600 interpreted rips (OXWASM_RIPTRACE=1)
and 128 bytes of code at each of their lines: the ring shows the JS function's own baseline code at 5a265200-5a265d6a being
INTERPRETED instruction by instruction (callout-interp into it every iteration, no translation), with the thunks around it
compiled, and the crash entered from the slow-path thunk dispatched at 5a2345c0 after a different exit than the previous
iterations took. So the value was already bad when the JIT code tested it. The operand slots around it hold cells with the
header 500200a1/00020800 (one structure, JSType 2, the bench's strings); the bad one is a cell of JSType ≤ 0x20 outside
{2,3,6}: a zapped, freed cell - a root the collector did not see, or a store the mutator lost.

Next angle: the shadow comparator (OXWASM_SHADOW_RANGE over the JIT region) on rounds 4-5 only, now that its known false
positives (clocks, r11, timespec writes, re-executed allocations) are handled; and why 5a265200 is never translated.
The shadow comparator over the JIT region (OXWASM_SHADOW_RANGE=5a221000-5a400000, exit-matched, dispatches 24000-40000)
reached round 1 in 15 minutes - a shadowed JIT dispatch replays a whole loop iteration in the interpreter - with no
divergence in the 11 dispatches it compared. As a tool for round 5 it needs a trigger that arms it at the round, not a
dispatch count, and a cap per dispatch; parked.

### Where a steady objects round goes, by V8 tick (cold69, rounds 8-15, 3.2 s, 2,594 ticks)
`--prof` on the node command line (NODE_OPTIONS refuses it), ticks aligned to the rounds by the host-clock stamps.
60% of ticks attribute to code objects; the rest is V8/C++ (GC, runtime). Of the attributed: JSC's collector functions
f_50eee60 101, f_5109300 88, f_47be830 57, f_478c050 36, f_47ae960 36 (~20%); the engine's own JS ~23%: LoadIC /
LoadIC_Megamorphic / FindOrderedHashMapEntry / StrictEqual under `step` (the interpreter's per-instruction Map lookups and
compares: ~7 µs an interpreted instruction, a few thousand a round), `ftr` under dispatchAot 59 (the in-wasm hash probe:
32,768 slots for ~16k functions, so the inline first-slot probe misses about half the time and the linear walk runs),
DataView under registerAotFn 15. Inside f_5109300 the hot offsets are the indirect-call site: the table bounds and
signature checks, `call rbx`, and the regfile reloads after it.
The hash cannot grow in place: FTHASH at 0x60000 with 2^15 16-byte slots ends at 0xE0000, just under RAMOFF (1 MB); a
bigger table means moving RAMOFF, which every cached unit bakes into its address arithmetic (a cold rebuild either way).

### A 4x dispatch hash (cold73) changes nothing; the objects floor is 22 ms; the abort is allocation-driven
RAMOFF moved to 4 MB so the hash can hold 2^17 slots (FTMAP_MAX 60,000, which also lifts the unit ceiling). 40-round medians,
cold73 on this engine against cold68 on the previous one (git worktree): objects 460/443 vs 353/200 ms, strings+json+math
421 vs 382 - no gain, inside the noise, so the probe walk was not the cost it looked like in the tick profile. Kept for the
ceiling. One cold68 run reached 22 ms on round 36 (native 6 ms: 3.7x) before aborting: the floor is close; the rounds
around it are 10-20x because of the collections.
Both 40-round objects runs abort at round 37, 13-26 s after round 0, so the abort is not wall-time; objects allocates about a
seventh of what the mix does per round and the mix dies at round 5: the trigger is cumulative allocation - a particular
collection, or a heap threshold JSC crosses. Queued: BUN_JSC_logGC counts at the abort with and without doubled heap growth.

### The abort reproduces on objects alone at round 34-39; int3 was a real hole but not this one
objects with 40-60 rounds aborts at round 34-39 in ~80% of runs (the mix at round 5), identical signature. JSC's VM traps
are signal-based on x86-64 Linux and plant int3 in JIT code; the engine had no int3 at all (0xCC undecoded), which is now
fixed (SIGTRAP, rip past the trap, si_code SI_KERNEL) - but no int3 ever executes in these runs (JSC polls at the baseline
tier), so that was not the mechanism. BUN_JSC_usePollingTraps=1 and BUN_JSC_useConcurrentGC=0 each let objects run 60-120
rounds, yet the full mix aborts 3/3 with both set, so they shift the odds rather than remove the cause. The per-round
counters show the shape: three to four rounds before the abort, interpreted instructions jump from hundreds to 20-30k a
round and deopts from 1-6 to 17-35, and one round carries 112k guarded stores that each invalidate a translation (1 s) -
JSC rewriting its JIT memory wholesale (a mass jettison and re-JIT), after which the crash follows. Ruled out this round:
a stale decode cache (JIT pages carry 8/16-byte signatures), unwritten tids on clone, thread exit and stack reuse, SIGPWR
traffic (none in steady rounds), the quantum, xmm staleness, the line heal, volatile pages, table rebuilds.
Next: log the writers of that storm (OXWASM_CWLOG_FROM=<n> OXWASM_CWLOG=<k>) to name the JSC path, and check every
address-keyed table the engine keeps across a JIT region's reuse.
Measured with polling traps and the non-concurrent collector (cold73, 40 rounds): objects median 415 ms (p25 211, min 91),
strings+json+math median 102 (p25 86, min 76; phase floors math 24, strings 14, json 34). Native: objects 6, the three ~10.

### The abort is a miscompiled JIT-region function: interpreted JIT code never aborts
objects for 60 rounds with the JIT region left to the interpreter (OXWASM_EXEC_ANON=0): 980 s, 60 rounds, no abort.
Translated: abort at round 34-39 in most runs. So it is the translation of some baseline-JIT'd code or thunk, not JSC
and not the interpreter. Bisecting with OXWASM_FNDUMP (the entries considered) and OXWASM_FNVETO_FILE (entries left
interpreted) on objects pointed at the truthiness thunk at 5a2312c0 (r15/r14 tag tests, cell-type checks, ucomisd against
zero), but one of two confirmation runs with only it vetoed still aborted, so objects' 60-80% abort rate is too weak a
signal; the bisect now runs on the full mix (aborts at round 5 every time, 63 JIT entries), with vetoed runs allowed to be
slow (a vetoed hot function is interpreted at ~16 s a round) and "reached round 6" as the pass.

### Found: JavaScriptCore's slow-path call thunks, translated, are what aborts the mix
The bisect over the JIT region's entries (OXWASM_FNDUMP + OXWASM_FNVETO_FILE, the full mix as the oracle since it aborts
at round 5 every time) converged on the 0x40-aligned stub block at 5a234000: 13 entries of three shapes - ArithAdd IC fast
paths (`cmp rsi,r14; jb; cmp rdx,r14; jb; add; jo; or rax,r14; jmp done`), a getter stub, and JSC's slow-path call
thunks (`push rbp; mov [rbp+0x24],ecx; mov rdi,rbp; mov rsi,[rbp+0x10]; mov rsi,[rsi+0x50]; add rsi,rcx; movabs r11,C++;
call r11; pop rbp; jmp <exception check; ret>`). Vetoing the whole block: 5/5 clean. Vetoing only the three thunks: 2/2
clean; only the add ICs: aborts. So the thunk shape is miscompiled. Escaping its instructions one at a time with
OXWASM_ESC_RANGES (jmp, pop, call, store, push) did not isolate one: every variant still fails, mostly as the hang rather
than the abort, so the fault is in how a unit enters or leaves this shape (a called entry whose body is push / C++ call /
pop / tail jump into a `ret` continuation), not in one instruction's translation. Two things were fixed on the way and
stay: a call site now treats its callee as returned only when the exit rip is the return address as well as rsp being
back (JSC's continuation leaves with `add rsp,8; jmp handler` when an exception is pending, which the rsp test alone read
as a return), and int3 raises SIGTRAP. A mitigation that recognised the shape by bytes and kept it interpreted (as root and closure member) did not hold:
with 10 thunks so vetoed the mix aborted, hung, and once completed at 1.4 s a round (sorting 811 ms: the vetoed thunks
are hot), so the two clean thunks-only veto runs were luck and the block-veto result rests on the whole block. Reverted.
The root cause is open; what is established: interpreted JIT region = never aborts; the 13-entry block vetoed = clean 5/5.
An entry-state trace (OXWASM_TRACE_RANGE=lo-hi: compiled functions in the range call the engine at entry after the regfile
reloads; the interpreter logs 0x40-aligned rips in the range) was meant to diff a compiled run against an interpreted one
(OXWASM_EXEC_ANON=0). It cannot be aligned across runs: JSC lays its stubs out in a different order when the JIT region is
interpreted (the three stubs traced sit at different addresses in the two runs), and in-unit entries reached by a jump are
not function entries on the compiled side. A same-run comparator for nested calls is what this needs; the trace stays as a
tool. The tracing itself also changed the failure (a hang in round 1 instead of the round-5 abort), which is consistent with
a bug that depends on when a unit is entered relative to JSC's patching rather than on the bytes alone.

### A stable configuration: JSC with its JIT off runs the whole mix, 6.5-7.5x native
BUN_JSC_useJIT=0 (LLInt only: every instruction executed is static code, so every unit comes from the cache and nothing
lives in the JIT region) completes the 24-round mix 3/3 with a tight distribution: medians 778/677/731 ms, p25 within 6%,
phases fib 30 math 75 objects 99-121 strings 95 sorting 83 maps 130 json 90. Native with the same setting: 104 ms (fib 5
math 13 objects 16 strings 14 sorting 14 maps 28 json 9); native with the baseline JIT: 45 ms. So 6.5-7.5x against the
like-for-like native, 15x against the native default - but measurable to a few percent, with no abort and no GC-timing
noise. This is the configuration to optimise the translation against; the JIT-region miscompile stays open in parallel.

### Where the JIT-off mix goes (cold75, V8 ticks over rounds 8-15, 7.7 s)
One wasm function takes 14% of all ticks by itself: bundle_0's function 130, `(i32) -> (i64)` with a 1,257,483-byte body -
JavaScriptCore's LLInt, every bytecode handler in a single multi-entry function because the handlers chain through one
computed-goto table (`jmp *table(%rsi,%rax,8)`), which the analyzer keeps in one function. V8's optimizer compiles a
function that size with spills around the giant br_table, which fits a uniform 6-7x across phases. The per-function
instruction cap (OXWASM_UNIT_MAXINSNS, 30,000 for the opencode child) is a refusal, not a split, so no knob chops it; a
per-handler split would pay the call protocol per bytecode (~75 instructions) and is not obviously a win. Next after it:
the engine's own JS at ~15% (LoadIC/FindOrderedHashMapEntry/StrictEqual under `step`: ~21k interpreted instructions a
round at ~7 us each, driven by 3-9 callouts a round into refused functions - 5b9a4e0 x158, refused for a `jne` that
consumes the flags of a `call`), V8 internals ~15% (Liftoff compiles and instantiation of late units, the host GC).

### The engine side of the JIT-off mix, itemised (cold77, V8 ticks over rounds 9-23, 10.3 s)
With the cache complete and no tier-ups in steady state, the split is: wasm 71.5% (the LLInt function alone 21.5%, the
rest a long tail - the hottest other unit, f_5b6f410, is 1.9%), the x86 interpreter and its megamorphic property-load
builtins ~8% (LoadIC, LoadIC_Megamorphic, FindOrderedHashMapEntry, StrictEqual_Baseline under `step`), libc memcpy/memmove
reached from `memory.copy` 4.3% (guest work, native pays it too), V8 C++ ~5%, the rest JS. So the translated code runs
4.4x native by itself and the engine adds another 40% on top.

Three engine costs found and measured on this configuration:

- **madvise(DONTNEED) walked every table.** `_invalidateCode` only took its "no code on these pages" shortcut for ranges
  under 64 pages; JSC's and bmalloc's decommits are 256 KB-1 MB, so every one walked the 15k-entry function map and every
  keyed table: 150-180 slow invalidations a round, syscall 28 at 1,090 ms per 24-round run, 30-50 ms of a 650 ms round.
  The shortcut now costs the smaller of the range's pages and the code-page set, with the wide-extent functions checked
  by overlap. Syscall time per round fell to 9-14 ms (medians 660/676 vs 697-812 before).
- **The store guard is 8-10% of the JIT-off round.** A cache built without OXWASM_STOREGUARD measures 625/597 ms medians
  against 650/686 guarded, per phase fib 25-26 vs 30 and math 59-62 vs 75 (the arithmetic-heavy phases store least, so
  there the guard is a larger share of less). With the JIT off nothing writes code after the loader's relocations (47
  guarded stores hit a watched line in a run, all disjoint), so for this configuration the guard buys nothing; it is the
  JIT's requirement. A cheaper form - a page-granular map at a fixed wasm offset, saving the slot load and the add per
  store - is the next thing to try; the line map's precision only matters when the JIT is on.
- **The interpreted instructions are thread resumes, not missing units.** OXWASM_EPISODES=1 keys every top-level
  interpreted stretch by the rip it starts at and how it got there: 35,818 stretches and 402k instructions over 16 rounds,
  and the top ones all start at a RETURN ADDRESS (libc+0x9bd82, pthread_cond_timedwait's continuation after
  `call _pthread_cleanup_pop`: 2,113 x 27 instructions; a lock release at 4fd1aa0: 864 x 36). The mechanism: a futex wait
  deep in a compiled call chain blocks, BlockUnwind drops every wasm frame above it, and on resume the callee's last
  instructions run interpreted and `ret` INTO its unwound caller, whose continuation is mid-function - not an entry - so
  it stays interpreted until the next call into a unit, and so does every frame above it. The size gate was not it
  (OXWASM_SIZEGATE=0: identical 17-21k a round), and neither were callouts (0 a round).

**Continuation roots (OXWASM_RETROOT, default 8).** A return address the interpreter lands on - by an interpreted `ret`,
as a unit's exit rip, or as the rip a parked thread resumes at - eight times with no unit becomes a unit root, exactly
like a loop head. With a 3,000-instruction budget on the root's own function (a continuation inside JSC's LLInt
re-translated everything reachable from it: one root, 9.9 s; such roots now fail as 'function too large' and are never
retried) the interpreted count per round goes from 17-20k to 650-2,000 and dispatches from ~1,500 to ~250-330; 280 roots
over a run. Open as of this note: with the roots on, the opencode process hangs at exit with every thread but the main one
dead and the main one blocked without a deadline (the shell's `wait` never returns, so the harness times out with no
output); the three landing kinds are being bisected (OXWASM_RETROOT_KINDS).

**Resolved:** the hang was the 'exit' landing kind rooting at the rip a sigreturn resumes at - whatever instruction
dash's SIGCHLD interrupted inside its wait loop - and a unit rooted there broke the shell (`wait` returned only when
the guard expired, then commands came back 127). Only a unit's normal return (its ret, or the frame exit after an
in-frame deopt) roots now; an unwound exit (DeoptUnwind, BlockUnwind) does not. The shell reproduction
(scratchpad waittest.sh: 16 heated `wait`s, then a guarded job) passes with every kind on; suite17 EXIT=0 with the
roots on by default.

### Two codegen measurements on the machine code itself (node --print-wasm-code, TurboFan, offline)
Reading V8's output for one hot unit (f_530c370, 1,603 instructions) and the LLInt (465,958):

- **Memory operands already cost what they must.** Every guest access is `leal r,[reg+0x200000+disp]` then
  `[rbx+r]`: the 32-bit lea does the wrap and the base shift in one instruction. Folding the constant into the
  load's `offset=` immediate instead (a text pass over the module, 22,668 operands rewritten in the unit) made the
  machine code 0.6% LARGER: the i64 register still needs its own 32-bit move to zero-extend, and the displacement
  then costs four more bytes. Not adopted; the pass is in the scratchpad.
- **The LLInt's cost is register pressure.** 137,268 of its 465,958 instructions (29%) are spills and reloads to
  the wasm frame (`[rbp-N]`), against 21,007 guest memory accesses; 18,969 more are v128 spills of the xmm locals.
  Every bytecode handler re-enters the dispatch loop with all 16 GPR locals, the flag locals and the xmm locals
  live, so the allocator spills most of them and each handler reloads what it touches. Native LLInt keeps its
  working set pinned in registers. 2,563 `call rbx` sites (the slow-path call protocol) each cost the instance
  reload after return (7,963 `movq rsi,[rbp-0x10]`), and 1,899 loop-budget compares sit on the back edges. For
  the small unit the spill share is 15%.

### Continuation roots measured; the page-map guard is not a gain (cold77/cold82/cold83, 24-round JIT-off mix)
Same engine, three configurations, two runs each, medians of rounds 9-24:

| configuration | medians | interpreted/round | objects | strings | json |
|---|---|---|---|---|---|
| line guard, no roots (cold77) | 686, 681 | 15-20k | 101 | 82-85 | 76-83 |
| line guard, roots (cold83 = cold77 + roots) | 640, 613 | 0.7-1.4k | 90-91 | 72 | 65-71 |
| page-map guard, no roots (cold82) | 733, 677 | 18-23k | 119-129 | 82-89 | 82-89 |
| page-map guard, roots | 673 | 1-1.6k | 110 | 77 | 81 |

Continuation roots: 6-10% off the round, and the phases that block most (strings, json: allocation, hence GC
hand-offs between the mutator and its helper threads) gain the most. On by default (OXWASM_RETROOT=0 turns them
off). The page map (OXWASM_GUARDPG=1) is not faster despite the shorter guard sequence - its objects phase is
consistently worse, which a cache built from scratch with a different unit composition may explain as well as the
guard itself; it stays an opt-in knob. One of the three root runs (rr2) again returned from the guest only at the
guard's expiry (secs=643, rounds and medians intact), so the late `wait` is intermittent with roots on, not gone;
it is being hunted with the idle diagnostic.

One more flag-materialization peephole landed on the way: ZF of a subtraction is now the operands' equality
(`cmp a,b; je` instead of lea, movl, testl, jnz), 0.6% off the unit's machine code.

### Registers in memory lose, for the LLInt too (cold87/cold88, warmed caches, roots on)
| configuration | medians | fib | math | objects | strings | sorting |
|---|---|---|---|---|---|---|
| locals (cold83) | 683, 645 | 30 | 74-76 | 95-97 | 82-84 | 82 |
| OXWASM_MEMREG=1: the LLInt's registers in the regfile (cold87) | 707 | 36 | 86 | 96 | 83 | 87 |
| OXWASM_MEMREG=all: every function (cold88) | 886 | 40 | 96 | 134 | 117 | 118 |

Every phase runs in the LLInt (the JIT is off), and the tight-loop phases are 15-20% slower with its registers in
memory: a load at every register read and a store at every write cost more than the frame spills they replace,
because V8 keeps a handler's hot registers in machine registers between its spill points, and a guest store kills
whatever regfile loads it had hoisted. The 18% smaller machine code was instruction count, not time. Everywhere,
it is 30-40% slower. Both stay as opt-in levers; the default is locals. The reload-after-call block that profiled
hottest is therefore real work on this layout, and the next lever is narrowing it (the xmm half is caller-saved
and never read back by ABI-compliant code; OXWASM_ABIRELOAD already skips the six callee-saved GPRs).

The late `wait` with roots on recurred in two of seven runs (secs=641, 643, rounds and medians unaffected).

**The late `wait` was never the roots.** A short job (fib,objects x4, guard 200) returned at the guard's expiry in
every run, roots on or off (secs=213-235), and the timestamped signal trace showed why: opencode's exit raised
SIGCHLD to the subshell doing `wait $P`, the handler ran, and the sigreturn went back to the sigsuspend
INSTRUCTION rather than past it with EINTR, so the shell slept until the next SIGCHLD - the guard's sleep. The
subshell is a fork child that blocked in sigsuspend inside its vfork window; materialising it into its own engine
copied the thread without its sigsuspend marker (suspendOld), and every delivery path keys the EINTR-after-handler
rule on that marker. Carrying it through materialisation fixes it: the short job returns in 28 s. The two long
runs that returned at 641/643 s were the same race landing on a different timing; the roots only changed when
the shell's child exited relative to its sigsuspend.
