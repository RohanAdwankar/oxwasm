# oxwasm benchmarks

## pybench.py — CPython-in-the-engine vs native

The same unmodified `python2.7` binary from the GIMP sysroot, run natively
(via the sysroot's own ld.so) and inside the engine:

    # native
    $SYSROOT/lib/x86_64-linux-gnu/ld-2.27.so --library-path \
      $SYSROOT/lib/x86_64-linux-gnu:$SYSROOT/usr/lib/x86_64-linux-gnu \
      $SYSROOT/usr/bin/python2.7 -E -S bench/pybench.py

    # engine (copy pybench.py to $SYSROOT/tmp first)
    node tools/gui/guishot.mjs $SYSROOT /usr/bin/python2.7 /tmp/out.ppm 640x480 100000 -E -S /tmp/pybench.py

2026-08-29 baseline (identical outputs, so correctness holds):

| test     | native | engine  | ratio |
|----------|--------|---------|-------|
| loop3M   | 106ms  | 23881ms | 225x  |
| dict300k | 40ms   | 6945ms  | 174x  |
| str200k  | 34ms   | 11263ms | 331x  |

Diagnosis: 42.7M deopt-chain hops, all landing at CPython's bytecode
handler entries — computed-goto dispatch pays a JS-boundary hop per
Python bytecode (67M chained unit runs vs only 14M interpreted steps;
the translated code itself is not the bottleneck). The planned fix is
in-unit jump tables: trace the table load feeding `jmp *reg`, read the
static table at translation time, and emit an in-wasm br_table over the
targets that fall inside the unit, deopt for the rest.

2026-08-29 later, after in-unit jump tables + wasm-to-wasm chaining
(same box, single runs; run-to-run variance on this box is ±30-50%, so
treat these as a band, not a point):

| test     | native | engine   | ratio | was    |
|----------|--------|----------|-------|--------|
| loop3M   | 106ms  | ~7300ms  | ~69x  | 225x   |
| dict300k | 40ms   | ~6500ms  | ~162x | 174x   |
| str200k  | 34ms   | ~7400ms  | ~219x | 331x   |

(After two coverage fixes the first chaining datapoint pointed at:
movntdq — glibc's non-temporal memcpy/memset store, now a plain
v128.store — and PLT stubs no longer being permanently poisoned when
their target hadn't compiled YET; memmove@plt et al. now re-alias once
the target tiers. str200k was the big winner: 14s -> 7.4s.)

The boundary traffic collapsed as designed — deopt round-trips
42.7M → 4.7k, top-level regfile-sync dispatches → 0.5M, JS chain hops
67M → ~0 — and loop3M (pure bytecode dispatch) got its 3x. dict/str
moved little because their time is in callout MISSES: hot callees the
translator refuses (fxsave, movnti/sse e7, entries that begin
undecodable), each interpreted in full per call (~33M interp steps).
That is a translator-coverage item, not a dispatch item: the next
multiplier lives in translating (or special-casing) those refusals.

2026-08-30, after real wasm tail calls (`return_call_indirect` at tail-jmp
sites; same box, single runs, ±30-50% variance):

| test     | native | engine   | ratio | was    |
|----------|--------|----------|-------|--------|
| loop3M   | 106ms  | ~5500ms  | ~52x  | ~69x   |
| dict300k | 40ms   | ~3500ms  | ~88x  | ~162x  |
| str200k  | 34ms   | ~3100ms  | ~91x  | ~219x  |

The diagnosis behind it: sampling the stack-budget word at interp time
showed 99.5% of ALL residual interpretation ran with FTDEPTH saturated at
its 1200 limit. `(return (call_indirect))` is not a tail call in core
wasm — every computed-goto hop kept its frame live, one bytecode loop
ratcheted the real stack (and the budget word) to the limit, and every
dispatch thereafter was refused for the rest of the loop. With genuine
tail calls the frame is replaced (tail sites hand back exactly their own
entry tax), chains hold constant stack, and the residual collapsed:
interp steps 19.1M -> 83k (230x), deopt round-trips 4.5k -> 0.5k,
budget-saturated interp samples 99.5% -> 0%.

## Steady state vs warmup

The table numbers above run each test once in a fresh process, so they
fold the whole tier-up pipeline (translate + assemble per unit) into the
measured phase — a CPU profile of such a run is ~49% wat2wasm subprocess
and ~17% translation. `pybench10.py` separates the two: it runs a warmup
pass of each kernel first, then times a 10x-sized run, giving the
marginal (steady-state) rate an interactive app sees after warmup:

| test (10x, warmed) | native | engine  | ratio |
|--------------------|--------|---------|-------|
| loop30M            | 994ms  | ~9200ms | ~9.3x |
| dict3M             | 380ms  | ~5700ms | ~15x  |
| str2M              | 318ms  | ~4000ms | ~12.5x|

A profile of the steady phase is ~40% wasm guest code, ~10% GC, ~20%
process-startup retranslation, ~5% JS dispatch/callout glue — the
remaining gap is translated-code quality (per-access address translation,
flag materialization, block-boundary register traffic), not dispatch.

2026-08-30, after wasm PLT stubs + the in-wasm dispatch driver (JS
boundary crossings 23.1M -> 2,950 for the run):

| test (10x, warmed) | native | engine  | ratio | was    |
|--------------------|--------|---------|-------|--------|
| loop30M            | 994ms  | ~9700ms | ~9.8x | ~9.3x  |
| dict3M             | 300ms  | ~3100ms | ~10x  | ~15x   |
| str2M              | 300ms  | ~1950ms | ~6.3x | ~12.5x |

(loop30M is pure bytecode dispatch inside one unit — never callout-bound
— so it moves only with translated-code quality; that is the open item.)

## GIMP filter (subprocess) benchmark

Filters>Blur>Blur on a 640x400 canvas in headless Chromium spawns the
real plug-in binary as a subprocess and runs the full wire protocol
(1197 tile messages). Wall-time progression as the subprocess engine
matured: first working run 140s (plug-in fully interpreted) -> 100s
(fork-window and CLOEXEC fixes) -> ~72s (child engine JITs organically —
358 units, its interpreted steps 41.7M -> 4.0M — plus parent/child
slice ping-pong). At 72s the pump profile shows the PARENT 94-98% busy
in run slices: the remaining time is GIMP core's own tile/projection
work executing at engine speed on paths the unit capture had never seen
— a coverage item (capture the filter flow), then translated-code
quality, not process machinery.

## Where the remaining loop30M gap actually is (2026-08-30)

Two measurements to stop guessing at the next multiplier.

**The computed-goto resolver is not the bottleneck.** Each in-unit computed
jump maps a target address to a block index through `$jtr`, a balanced BST
of i64 compares (log2 n per hop). A microbenchmark of that resolver alone
(N=100 targets, the shape of CPython's handler set, 30M resolves) against
an O(1) multiply-shift hash into a probe table:

| resolver | 30M resolves | rate |
|----------|--------------|------|
| BST (current) | 143-145ms | ~209M/s |
| hash + verify | 111-120ms | ~260M/s |

~1ns saved per computed goto. Against loop30M's ~9-11s that is ~1%, so the
BST stays — the complexity of a perfect-hash resolver buys nothing.

**A CPU profile of a full loop30M run** (node harness, cold process through
the timed steady phase; 24s wall):

| bucket | share |
|--------|-------|
| guest code (2 wasm functions) | 42.6% |
| wat2wasm subprocess (`spawnSync`) | 22.9% |
| translation (decode/analyze/emit) | 6.8% |
| harness wat-cache stat/read | 5.7% |
| js-to-wasm boundary | 3.3% |
| GC | 2.0% |

The timed steady window (11.2s of the 24s) is essentially all
`wasm-function[5]` and `[3]` — the translated CPython eval loop. Dispatch
machinery, boundary crossings, and flag/address lowering no longer show up:
lazy flags already lower `cmp`+`jcc` to a single `i64.lt_u` on the stashed
operands, and an address is one `i32.wrap_i64` plus a folded constant.
What is left is per-instruction code quality INSIDE the unit, which is
where the next multiplier has to come from. (`spawnSync` is a node-harness
artifact — the browser assembles in-process with wabt.js.)

### Inside the unit: regfile spill/reload is a third of the emitted code

Breaking down the 7.1MB of wat for CPython's eval-loop unit by pattern:

| pattern | count | share of bytes |
|---------|-------|----------------|
| regfile spill (`i64.store (i32.const N) (local.get $rK)`) | 28,038 | 16.8% |
| regfile reload (`local.set $rK (i64.load (i32.const N))`) | 27,389 | 16.0% |
| `i32.wrap_i64` of a register (address lowering) | 15,966 | 6.8% |
| width masks (`& 0xFFFFFFFF`) | 4,728 | 1.4% |

The unit has 1,725 callout sites and reloads a mean of 15.0 registers at
each. Every escape to an untranslated callee spills all 16 GPRs and reads
them all back, because the emitter has no idea which ones the rest of the
unit still needs.

### ...but dynamically it is worth ~13%, and trimming reloads is worth ~1%

Static byte share is not runtime share, so before building the dataflow
pass the cost was measured directly. Instrumenting every unit-to-unit call
site with a counter: **loop30M makes 330,120,276 unit-to-unit calls** — 11
per Python loop iteration — in an ~11s timed phase, i.e. ~33ns per call.

A microbenchmark of the two call ABIs (30M calls, callee with a realistic
body touching several registers and memory):

| call ABI | 30M calls | per call |
|----------|-----------|----------|
| regfile through linear memory (today: caller spills 16, callee prologue loads 16, callee exit spills 16, caller reloads 16) | 374-378ms | 12.5ns |
| registers as wasm params/results (multi-value) | 237-251ms | 8.1ns |

So the sync costs ~4.4ns of the ~33ns call. Passing registers instead is
worth ~1.45s of the 11s — **~13%** — and it is the largest single
identified win. Trimming just the caller-side reloads by liveness moves
about a tenth of the sync traffic, i.e. **~1-2% of runtime**: not worth
200 lines of dataflow on its own, though it remains a code-size win.

The rest of the 10x is broad. At ~33ns (~110 cycles) per call for callee
bodies of a few dozen instructions, translated code runs several cycles
per x86 instruction where native manages a fraction of one. That is the
per-instruction grind — i64 arithmetic for 32-bit operations, width masks,
wrap/extend churn, no scheduling for ILP — not any single structure.

The register ABI is a flag day: every unit, PLT stub, `$drive`, and the
funcref table type change together, and packed unit caches must be
regenerated. The JS boundary should keep the memory ABI (passing 16
BigInts per dispatch would be worse), so each unit wants a thin
memory-ABI entry wrapper alongside its register-ABI body, with two
parallel funcref tables indexed alike.

### The dataflow shape, if the reload trim is ever wanted

The spills cannot shrink — an interpreted callee reads the regfile,
so it must see all 16 — but the reloads can:

- Backward liveness over the block graph gives the registers actually read
  after a call. Analyzing the EMITTED text is exact and cheap: `local.get
  $rK` is a read, `local.set $rK` a write. Spills do not count as reads
  (they are conditional on the same analysis).
- Skipping a reload leaves that local stale, with the regfile authoritative
  — which is what a deopt needs. So every later spill of a stale register
  must be skipped too, and a write to it clears the staleness.
- The subtle part is a merge whose predecessors disagree: stale on one
  path, written-and-authoritative on the other. Spilling there writes
  garbage from one side; not spilling leaves the regfile behind on the
  other. Rather than emit compensation code on edges, resolve it by
  fixpoint — start optimistic (skip every dead reload), and wherever a
  block entry has predecessors that disagree about a register, demote the
  reload that caused it and re-run. Removing skips only shrinks the stale
  sets, so it terminates.

Small folds landed alongside this measurement (dead width masks on
already-narrow values, `xor r,r` / `sub r,r` as a constant zero, `test r,r`
emitting the value once, constant shift counts folded against their mask)
are worth ~2% of emitted bytes on their own — real for wat2wasm and
wabt.js time, but not the multiplier.

### The global funcref resolver was the real cost (landed: ~15% on loop30M)

Splitting those 330M calls by kind: 10% are same-module direct, 30% are
cross-unit static calls, and **60% are indirect** (CPython dispatching
through type slots). Every one of the latter two — 297M of them — resolved
its target through `$ftr`, which was a binary search over the sorted
`(addr, slot)` map.

Benchmarked against an open-addressed hash of the same entries, with 90% of
lookups deliberately landing on a 24-entry hot set (a scattered access
pattern is far worse for the search, so this is the charitable case):

| registered units | binary search | hash |
|------------------|---------------|------|
| 1,226 (the loop30M run) | 15.5ns | 3.6ns |
| 7,684 (packed GIMP) | 21.3ns | 4.2ns |

Landed as a hash table. loop30M end to end:

| | runs | mean |
|---|------|------|
| binary search | 11210, 11014, 10982, 10468ms | ~10.9s |
| hash | 9088, 9550ms | ~9.3s |

**~15%**, and it scales with the number of compiled units, so a large app
like GIMP gains more than CPython does. Registration also drops from an
O(n) memmove to a store, which cuts tier-up time.

Correction to an earlier claim here: the hash REPLACED the sorted array
rather than running alongside it — nothing writes `FTMAP+16` any more. A
unit built before the hash binary-searches that region and would
misresolve, so changing the resolver obliges a repack of any packed page.
`demo/gimp` has been repacked. Nothing was broken in between, because
every unit in every run measured here was compiled by the same engine that
read it, but the window existed and the note was wrong.

For scale, this is worth more than the register-passing call ABI (~13%)
and cost a fraction of the risk: no ABI change, no flag day, no repack.

### GIMP gains more than CPython (as predicted by unit count)

Same snapshot, same click script, engine BUSY time per interaction (clicks
are injected when the engine parks, so wall time does not enter). The two
runs did identical work — 5,541 units both, 1,507,965,828 vs 1,507,965,922
interpreted steps — so the difference is resolver cost alone:

| | binary search | hash | |
|---|---|---|---|
| snapshot restore, settle | 605ms | **229ms** | 2.6x |
| first menu open (cold path) | 4596ms | **682ms** | 6.7x |
| first menu close (cold path) | 5915ms | **614ms** | 9.6x |
| warm menu open, median of 8 | 120.4ms | **91.4ms** | 1.32x |
| warm menu close, median of 8 | 28.9ms | **19.3ms** | 1.50x |

Warm interactions gain 24-33%, more than loop30M's 15%, because GIMP has
7,684 registered units against CPython's 1,226 and the search was
O(log n) with cache misses. The cold first interaction gains far more
still: that path tiers units up, and registration itself was an O(n)
memmove per unit, which the hash replaces with a store.

Measuring interaction latency needs care about what "idle" means. A pump
loop that calls `eng.wake()` whenever `eng.blocked` is set turns GIMP's
poll-with-timeout into a busy spin: the first version of this harness
reported every interaction pinned at its 20s cap and burned 2.04 billion
interpreted steps doing it. The app is idle exactly when it is blocked on
a deadline that has not arrived yet.

These were node-harness numbers when first measured; `demo/gimp` has since
been repacked onto the hash resolver (7,653 units), so the shipped page
gets them too.

### Profiling only the interaction, not the process (a table grow was 12%)

A `--cpu-prof` of the whole GIMP run is useless for interaction latency:
the sysroot walk, snapshot restore and tier-up dominate it, and the menu
cycles are a rounding error. Starting and stopping the inspector profiler
around ONLY the eight measured cycles gives the real breakdown:

| | share of a warm cycle |
|---|---|
| guest wasm code | ~24% |
| `ftab.grow` | 12.0% |
| still tiering up new units | ~12% |
| profiler overhead (discount) | 10.2% |
| GC | 5.5% |
| X server raster (`copyArea`, `rasterFillRect`) | ~5% |

The `grow` was one call site: `this.ftab.grow(1024)` in `registerAotFn`.
Not the copy — every compiled unit IMPORTS that table, so a grow makes V8
fix up each importing instance's cached table base, which is
O(instances) once thousands of units exist. Sizing the table once at
construction, before any instance exists, costs nothing:

| | growing | pre-sized | |
|---|---|---|---|
| first menu open | 682.4ms | **330.0ms** | 2.1x |
| warm menu open, median of 8 | 91.4ms | **82.5ms** | -10% |
| warm menu close, median of 8 | 19.3ms | **18.2ms** | -6% |

That table above says ~12% of a warm cycle is tier-up. **It is wrong**,
and the way it is wrong is worth keeping: the profile covered all eight
measured cycles at once, and cycle 0 is a 330ms outlier that compiles 183
units. Averaging one cold cycle into seven warm ones and calling the
result "warm" hid which phase the compilation lived in. Per-cycle
accounting settles it — cycles 2-7 compile essentially nothing:

    cycle 0: new=183   cycles 2-5: new=0
    cycle 1: new=16    cycle 6: new=1, cycle 7: new=0
    (zero recompiles and zero failures throughout)

There is a real finding under the mistake: new units still appear in
cycles 0-1 even after three warmup cycles, because `aotCallThreshold` is
4. A function called once per interaction needs four interactions before
it tiers up, so the first several interactions after a load are
structurally slower whatever the shipped manifest contains.

### What a genuinely steady interaction is made of

Profiling only cycles 2 onward (1105ms of samples, of which the inspector
itself is 29.3% — discounted below, leaving ~781ms of real work):

| | share of real work |
|---|---|
| translated guest code (all wasm frames) | ~76% |
| X server blit and raster (`copyArea`, `rasterFillRect`) | ~13% |
| X protocol handling (`handle`, `clientData`) | ~3% |
| syscalls | ~2% |
| GC | <1% |

No tier-up, no table growth, no resolver. A steady GIMP interaction is
translated-code quality plus the JS X server's pixel work — the same
conclusion loop30M reached by a different route. The X server's ~13% is
the only remaining non-guest item and is plain JS pixel copying, so it is
the one place left where a targeted fix could still pay.

## Interaction latency in the PAGE (not the harness)

Every interaction number above came from the node harness. The packed page
has something the harness does not — a slice pump — so measuring the real
artifact was overdue. `cdp_lat.mjs` times native click to the menu's pixels
on the canvas, per cycle. The shipped page:

    warm open med=279ms p25=272 p75=286 · close med=76ms
    per-cycle: 789, 63, 280, 289, 286, 272, 279, 54, 278, 272

Bimodal, and that is the tell: ~272-289ms on most cycles, ~54-63ms on a
couple. Not compute — scheduling. The pump sleeps on a guest timer with
`setTimeout(pump, min(d, 250))`, and `poke()` bailed out whenever a timer
was already pending, so a click landing during that sleep waited it out
(up to 250ms) before any guest code ran. The fast cycles were clicks that
happened to land while the engine was already running.

With input cancelling the pending sleep (and re-arming through the
MessageChannel tick, which also dodges the ~4ms nested-setTimeout clamp):

| | before | after | |
|---|---|---|---|
| warm menu open, median of 8 | 279ms | **64ms** | 4.4x |
| open p25 / p75 | 272 / 286 | **61 / 65** | |
| warm menu close, median of 8 | 76ms | **18ms** | 4.2x |
| mean input->paint (30 samples) | 198ms | **70ms** | 2.8x |

The variance collapse matters as much as the median: erratic 54-289ms is
what made the page feel unpredictable, and it is now 57-65ms.

Two lessons worth keeping. The page is now FASTER than the node harness
(64ms vs ~82.5ms), so the harness's own settle loop was inflating its
numbers — harness figures were pessimistic, not optimistic. And a bug
living only in the shell is invisible to every engine-level measurement,
however careful: the artifact has to be measured as the artifact.

## Drawing: strokes in the page

The paint path takes different scheduling than a menu click — motion is
coalesced to the latest position per pump slice — so it needs its own
probe (`tools/gui/cdp_draw.mjs`): press, 24 moves at ~60Hz, release, five
strokes, reading input->paint latency from the page's own instrumentation.

It counts ink pixels as well as timing, and that earned its keep on the
first run, which reported no marks and zero paints. That looked like a
drawing regression. It was not: a fresh page opens GIMP's empty
"(untitled)" window, so the strokes had nothing to paint on and correctly
drew nothing. A screenshot showed it in one glance; neither of the two
probe-side explanations guessed beforehand (wrong coordinates, missing
instrumentation) was right. The probe now does File > New > OK first.

Two measurement defects had to be fixed before the numbers meant anything.
The probe fetched the canvas rect over CDP on every motion step, ~15ms of
self-inflicted overhead per move, which is what made an early reading say
"24 moves in 877ms". And the page only sampled latency on pointerdown, so
a 24-move drag reported 2 samples — press latency, not smoothness. It now
timestamps the move that is actually INJECTED, deliberately not every move:
coalescing drops the rest by design, and counting a dropped move as a slow
paint would measure the wrong thing.

| warm strokes (5 x 24 moves) | |
|---|---|
| input->paint, mean | **24.1ms** median across strokes |
| input->paint, worst | 59ms median |
| paints sampled per stroke | 27 |
| ink pixels | 0 -> 6912 (**strokes draw**) |

24ms mean sits above a 60Hz budget of 16ms — visible as slight lag on a
fast stroke rather than a stutter — so drawing is correct and usable but
not yet at parity. Menu latency is unchanged by the added instrumentation
(warm open median 62ms vs 64ms, same p25/p75 band).

### What a stroke is actually made of, and a measurement trap

A CPU profile of the stroke path taken IN THE BROWSER (the node harness has
neither the pump nor the blit) splits a drag's busy time very differently
from a menu open:

| busy time | stroke | menu open |
|---|---|---|
| translated guest code | **33.1%** | ~76% |
| X server JS raster | **~32%** | ~13% |
| — `paintU32` | 12.3% | |
| — `copyArea` | 10.8% | |
| — `rasterFillRect` | 5.1% | |
| interp `step` / `deopt` / `decode` | ~9% | ~0% |

For drawing the JS X server costs as much as the JIT, which inverts the
conclusion carried over from menu opens and means JIT work alone cannot
close the 24ms -> 16ms gap.

`paintU32` converts the whole 1024x768 framebuffer from XRGB to RGBA on
every blit, once per stroke move, however little changed. Replacing four
byte stores per pixel with one u32 store (endianness detected once, byte
path kept as fallback, output verified byte-identical):

| framebuffer convert, 1024x768 | |
|---|---|
| four byte stores | 1.92ms / frame |
| one u32 store | **1.03ms / frame** (1.8x) |

**The trap**: the first end-to-end reading said 25.5ms -> 20.5ms and looked
like a 20% win. It was noise. Paired samples are u32 20.5, 24.2 and byte
25.5, 22.3, 29.3 — overlapping, with a byte run beating a u32 run. The
component math explains why: ~0.9ms saved per blit at ~27 blits per stroke
is ~1ms per move against a 20-25ms budget, roughly 4%, well under this
box's ±3-5ms run-to-run spread. When the expected effect is smaller than
the noise, no number of end-to-end runs will resolve it — the component has
to be measured on its own. The change is kept because it is strictly fewer
stores and provably identical output, not because the stroke numbers moved.

Not attempted: dirty-rect blitting, the larger win. `dirty` is a bare
boolean set at 20+ sites, so adding rects means getting every one right and
one miss is visible corruption.

### copyArea 29x — and why stroke latency still does not move

`copyArea` was the largest JS item in a stroke after the blit fix (10.8% of
busy). It was a per-pixel double loop calling `plot()` per pixel; GIMP blits
its canvas through it constantly. Plain GXcopy with no clip list and no clip
mask is a pure rectangle move, so it becomes row-wise `set(subarray(...))`:

| 600x360 copy, GIMP-shaped | |
|---|---|
| per-pixel via plot() | 2.699ms |
| row-wise fast path | **0.094ms** (29x) |

Two mistakes, both caught before measuring. `copyWithin` copies WITHIN the
destination buffer, but the usual case is a copy between surfaces (pixmap ->
window) — `set(subarray(...))` reads the right buffer and still has memmove
semantics for self-overlapping scrolls. And clamping out-of-bounds rects
mismatched the per-pixel path on 145 of 300 random cases, because this
implementation writes 0 into the destination where the source rect falls
outside the source surface; what X's spec leaves undefined is irrelevant
when the job is to match the code being replaced. The fast path now requires
both rects fully in bounds. Differential test: 2000 random cases across
in/out of bounds and GXcopy/GXxor, zero mismatches, 212 on the fast path.

**And the end-to-end stroke latency does not move**, across three builds:

| build | warm stroke mean, per sample |
|---|---|
| byte blit | 25.5, 22.3ms |
| u32 blit (1.8x convert) | 20.5, 24.2ms |
| u32 + copyArea (29x) | 22.3, 24.0, 22.0ms |

Fully overlapping. Two verified component wins totalling a large share of
the X server's JS produce no measurable change, which is evidence about
where stroke latency actually lives: not in that JS. The likely floor is
scheduling — the blit is coalesced onto `requestAnimationFrame`, so
input->paint cannot beat roughly one frame (16.7ms) plus pump-slice
quantization, and ~22ms is about that. If so, drawing smoothness is a
scheduling problem like the 250ms input-wakeup bug was, not a throughput
one, and more JS optimization will keep returning nothing. That is the next
thing to test, and it is worth more than another component speedup.

### Where a stroke's 21.6ms actually goes (hypothesis disproved)

The previous section guessed stroke latency was rAF-scheduling-bound: the
blit is coalesced onto `requestAnimationFrame`, so input->paint should not
beat ~16.7ms. **That was wrong.** Splitting the measurement three ways —
input queued until the pump picks it up, pump work, and the wait for the
animation frame — gives:

| input->paint 21.6ms | | |
|---|---|---|
| wait, input -> pump | 2.2ms | 10% |
| compute, pump work | **14.0ms** | **65%** |
| rAF, blit requested -> frame fires | 5.8ms | 27% |

The pump picks input up almost immediately, so drawing is compute-bound,
not scheduling-bound. That also explains the two null results without any
exotic floor: the 1.8x convert and the 29x copyArea were each a small
slice of a 14ms compute half, so a large multiplier on a small part moved
~1-2ms and vanished under noise.

The consequence for planning: rAF's 5.8ms is a floor that stays (bypassing
it would wreck frame pacing), and 2.2ms of pickup is already negligible.
Reaching a 16ms/60Hz budget therefore needs compute at ~8ms, a 1.75x on
that half. The stroke profile puts ~33% of it in translated guest code and
the rest in X server JS and residual interpretation — so this lands back on
translated-code quality, the same place loop30M ends up.

Two measurement defects had to be cleared first, both of which produced
believable numbers:

- The probe's `resetLat` did not zero the accumulators newly added to the
  page, so `work` ran cumulatively (109.6 -> 194.2 across five strokes)
  while the divisor reset. The parts failing to sum to the total is what
  exposed it.
- The rAF counter's first patch attempt wrote nothing: the pattern occurs
  in BOTH shell templates, the assertion demanded exactly one, the write
  aborted — and an "ok" printed by a later block in the same output got
  read as success. The repacked page had no counter and reported a tidy
  -1.0. `git status` showing only the probe modified is what caught it.

Hence the rule now followed: grep the PACKED `index.html` for a new field
before believing any number that field is supposed to produce.

### Instruction expansion: ~13 wasm ops per x86 instruction

Both interaction paths and loop30M now point at translated-code quality, so
the bounding question is how many wasm ops the translator emits per guest
instruction — no amount of scheduling gets below that ratio.

Over a full CPython loop30M run: **4,383,601 wasm ops for 342,875 x86
instructions translated, ~12.8 ops per instruction** (72.2MB of wat, 389
units). Cross-check from a different angle: 72.2MB over 342,875
instructions is ~210 bytes of wat per instruction, and a typical emitted
line runs ~120 characters, so ~2 lines per guest instruction — consistent.

Caveats, because the measurement has real limits: the instruction counter
hooks only the dispatch-layout path, so units taking the structured layout
contribute ops without instructions and the true ratio is somewhat LOWER
than 12.8. The op counter also counts constants and block structure as ops.
And the per-unit pairing in the first version was simply invalid — it
reported a unit at 7253x, which is what a mis-joined index looks like; the
two counters are pushed from different functions and their lists do not
correspond. Only the aggregate is meaningful, and only as an order of
magnitude.

What it implies is robust to that uncertainty. At roughly ten wasm ops per
guest instruction, the 5-10x gap to native is not a handful of bad
patterns — it is systemic expansion. Reaching ~2x needs the ratio down
around 3-4, which means a genuinely better translator (SSA with real
register allocation, flag elision across blocks, addressing-mode folding),
not more peepholes. That is worth knowing before spending another burst on
local codegen tweaks.

Consistent with that: three codegen ideas were killed by measurement before
implementation this session — a hash for the computed-goto resolver (~1%),
spill/reload liveness (~1-2% of runtime), and using wasm's `offset=`
immediate instead of an explicit add (**0%** — 2.16ns per dependent load
either way, since V8 already folds the add into the addressing mode). The
wins all came from machinery instead: the funcref resolver hash (15-33%),
the input-wakeup fix (4.4x on menu latency), funcref table pre-sizing (2.1x
on first interaction), copyArea (29x).

## Where the emitted ops actually go (op histogram)

The 12.8-ops-per-instruction figure above says the expansion is systemic but
not where it lives, and the note ended by proposing "SSA with real register
allocation, flag elision across blocks, addressing-mode folding". Two of
those three turn out to be **already implemented**, which is worth recording
before another burst is spent re-inventing them:

- **Registers are already in wasm locals**, in both emitters. Function mode
  (`compileFunctionWatDispatch`) loads the regfile into `$r0..$r15` at entry
  and stores back at exit; unit mode (`emitUnitFunction`) does the same. The
  regfile at wasm offsets 0-511 is the *interface* between units, not the
  working representation inside one.
- **Flag elision across blocks is already implemented** — `modeled()`,
  `CLOBBER`, `flagKind()` and a reaching-definitions fixpoint over the CFG
  decide which flag writes are live; dead ones are never materialized, and a
  producer/consumer pair that spans blocks agrees on `(kind,size)` or the
  function is poisoned to the interpreter.

Checked by dumping the wat for `sub rdi, rsi; setb al`: `$fa`/`$fb` are set
*before* the subtraction (not re-read after, which would have made the flag
inputs the result), the 64-bit case skips the width mask entirely, and the
two registers load once at entry and store once at exit. That path is tight.

So a histogram, categorising every op emitted across 71 real units
(1,784,110 ops) in a dash pipeline of sha256sum/sort/tr/gzip:

|      share | category |
|-----------:|----------|
| 27.8% | constants |
| 24.0% | regfile `local.get`/`local.set` |
| 17.9% | guest memory load/store |
|  8.6% | address arithmetic + width conversion |
|  5.0% | scratch temps |
|  3.8% | structured control |
|  3.0% | lazy-flag locals |
|  2.4% | masking / logic |
|  2.4% | simd |
|  2.1% | compares |
|  1.1% | block dispatch (`br`) |
|  1.0% | calls / tail calls |

Two caveats, both load-bearing. The guest **faulted** partway through this
run (`fault: 8`) rather than exiting cleanly, so the workload is a partial
one — the units it did translate are real, but this is not a completed
program. And the biggest bucket is the least real: `i32.const`/`i64.const`
are counted as ops here, but V8 folds most of them into the consuming
instruction's immediate or addressing mode, exactly as the `offset=`
experiment already showed (0% difference). Discounting constants puts the
honest figure nearer **9 ops per guest instruction**, not 12.8.

That reframes the target. The remaining mass is register-local traffic
(24%) and guest memory access (17.9%) — and neither is obviously wasteful:
locals are what a good translator *should* emit, and guest loads/stores are
the program's actual work. The next measurement worth making is not another
codegen idea but a comparison against the same functions compiled natively,
to see how much of the 9 is irreducible x86-semantics tax (width masking,
lazy flags, the 32-bit zero-extend rule) versus recoverable. Until that
exists, "rewrite the translator" is not yet a justified plan.

## Where the gap to native actually is (per instruction class)

The aggregate figures — "5-10x off native", "~13 wasm ops per x86
instruction" — say the expansion is systemic without saying where it lives.
`bench/kernels/` answers that: six kernels, each leaning on one thing, the
same static binary run natively and on the engine. Each is timed at two
iteration counts and the difference taken, so startup, ELF load and JIT
compile cancel and only steady-state throughput is left; a kernel whose
engine output differs from native is aborted rather than compared.

| kernel | native (ms) | engine (ms) | ratio |
|--------|------------:|------------:|------:|
| call    |  42.1 | 401.0 | **9.5x** |
| mem     |  12.8 |  52.8 | 4.1x |
| subw    |  10.8 |  37.0 | 3.4x |
| alu     |  27.1 |  72.8 | 2.7x |
| branch  | 104.9 | 186.9 | 1.8x |
| muldiv  | 106.1 | 170.7 | 1.6x |

**call/ret is the outlier, at more than twice the next class.** Everything
else — the straight-line code a translator rewrite would target — is between
1.6x and 4.1x. That reverses the standing conclusion. The residual gap is
not uniform expansion needing SSA and better register allocation; it is
concentrated in one mechanism, the funcref table. Every guest `call` becomes
a hash lookup plus `call_indirect`, and the earlier 15-33% win from hashing
that resolver was an early sighting of the same thing.

The obvious lead is that a call whose target is known and lies inside the
same translation unit does not need the table at all — a direct wasm call
would skip both the lookup and the indirect dispatch. Unit boundaries are
what force the indirect path today.

Two caveats on the 9.5x. The callee is a two-operation leaf, so per-call
overhead is as exposed as it can possibly be; real functions amortise it,
and this is the worst case for call-heavy code rather than a whole-program
claim. And nothing here is 10x — the worst *code* class is 4.1x, so a mixed
workload sits nearer 2-3x than the 5-10x that has been assumed.

### The 0.9x that wasn't

The first run reported call at **0.9x** — faster than native — which would
have been a pleasing and completely false result. At `-O2` gcc inlined the
leaf, so `k_call` and `leaf` did not exist as symbols and the kernel
measured a multiply chain containing no calls. `objdump` showed one `call`
in the whole of main, and it was `printf`. With `__attribute__((noinline))`
the same kernel measures 9.5x.

A benchmark that cannot fail is not measuring anything. The check that
caught this — does the binary actually contain the instruction the kernel
claims to test — is worth running on any kernel added here.

### Correction: it is the spill/reload, not the funcref table

The conclusion above — that call/ret's 9.5x is the funcref table, and that
direct intra-unit calls would fix it — is **wrong on both halves**. Direct
calls are already implemented (`canDirect` in aot_wat.mjs emits
`(call $f_TARGET)` with no lookup), and dumping the emitted wat for the call
kernel shows the call to `leaf` taking exactly that direct path.

What surrounds it is the cost. One call to a function whose whole body is
`x * 2654435761 + 1`:

```
(local.set $r4 (i64.sub (local.get $r4) (i64.const 8)))   ; push return addr
(i64.store ... (i64.const 4200820))
(i64.store (i32.const 0)  (local.get $r0))                ; spill r0
(i64.store (i32.const 8)  (local.get $r1))                ; ... 9 registers
(i64.store (i32.const 16) (local.get $r2))
(i64.store (i32.const 24) (local.get $r3))
(i64.store (i32.const 32) (local.get $r4))
(i64.store (i32.const 40) (local.get $r5))
(i64.store (i32.const 48) (local.get $r6))
(i64.store (i32.const 56) (local.get $r7))
(i64.store (i32.const 64) (local.get $r8))
(local.set $fts (i32.load (i32.const 65544)))             ; stack budget
(if (i32.and (i32.lt_u ...) (i32.ne ...))
  (then ... (drop (call $f_401b80)) ...)                  ; the actual call
  (else (drop (call $x_callout ...))))
(local.set $r0 (i64.load (i32.const 0)))                  ; reload 9 registers
...
```

**~18 memory operations plus a budget check, to call a function that does
two.** Across the whole unit that is 21,948 regfile stores and 18,933 loads.
`spillAll()`/`reloadAll()` write back every touched register plus all xmm
around every call, because the regfile in memory is the interface between
translation units and the callee expects to find registers there.

The target is therefore narrowing that set, not removing an indirection that
is already gone. For a direct call the callee is known, so its actual read
set and clobber set can be computed and only those registers spilled — for
`leaf`, rdi in and rax out, so two operations instead of eighteen.

This also reconciles an earlier result. "Spill/reload liveness" was measured
at ~1-2% of runtime and dropped, but that was on loop30M, which is not
call-heavy. Both numbers are right for their workload: the cost is
negligible in a tight loop and dominant in call-dense code. The mistake was
generalising the first measurement to the whole engine.

### Narrowing the spill set: a negative result, and a noise floor

The obvious follow-up to the above was implemented: compute each function's
register footprint, close it transitively over direct callees, and at a
direct call site spill and reload only what the callee can touch (full set
retained on the `x_callout` fallback, which interprets and reads
everything). It works — the emitted call to `leaf` went from nine spills and
nine reloads to three and three — and the full differential suite passes.

It is reverted anyway, because **it cannot be shown to help.** A/B in one
session, same machine state:

| kernel | narrowed | full |
|--------|---------:|-----:|
| call   | 12.3x | 11.1x |
| alu (control, contains no calls) | 1.9x | 2.4x |

The control moved 26% between the two halves — and neither mode can affect
`alu`, which has no calls in it. Across four runs of nominally identical
configurations, `call` has measured 9.5x, 7.8x, 12.3x and 11.1x. The
run-to-run spread is larger than the effect, and what sign there is points
the wrong way.

So the honest state is: the mechanism is understood and the fix is written
and correct, but unproven. Carrying a codegen change with
silent-miscompilation surface for an unmeasurable gain is a bad trade, so it
is out of the tree until the measurement can resolve it.

**The blocker is now the harness, not the engine.** `run.mjs` reports the
spread alongside the ratio (`+/-N%`) and takes REPS repeats, because a
single figure hides how much of itself is noise — this change was very
nearly accepted on a difference smaller than the variance of a kernel it
could not touch. Before any further codegen work here, the harness needs to
produce a number that can distinguish a 10% effect: more repetitions, pinned
iteration counts, and ideally in-process A/B rather than separate runs.

### The harness, made trustworthy

Fixed, and measured against itself:

| | before | after |
|---|---:|---:|
| startup as a share of the measurement (`alu`) | 61% | 8.8% |
| run-to-run spread | +/-168% | +/-4% |
| **smallest effect it can resolve** | ~15% | **~4%** |

Three changes got there. Iteration counts are now **calibrated per kernel**
until steady-state work is at least 8x startup — one N could not serve
kernels that differ tenfold in cost per iteration, and at a fixed N=40M
`alu` was 61% startup, i.e. mostly timing the compiler. Each kernel gets a
**warm-up run** that is discarded, so the wat cache and V8 are hot. And the
**median of REPS** replaces best-of-2, which chases the one lucky run.

The harness now ends by measuring one kernel twice under identical
configuration and printing how far the two disagree. That number is its
resolution, and any claimed effect smaller than it is noise. It is the check
that would have stopped the spill-narrowing result being believed.

Calibration is capped (`N_CAP`), because chasing the ratio without a ceiling
made a run take longer than the work it was measuring; when the cap binds,
the startup% column shows it.

With this, `call` reads 7.71x, 8.13x, 7.80x on repeated runs — so the honest
figure is **~8x**, not the 9.5x-12.3x the earlier harness produced across
nominally identical configurations. The spill-narrowing change measured
~11%, which this harness could now resolve; re-testing it is the next step.

### Settled: spill/reload is not the call tax either

With the harness able to resolve ~4%, the reverted change was re-applied and
A/B'd properly. Same session, interleaved, `call` on a calibrated N:

| | ratio | spread | resolution |
|--|------:|-------:|-----------:|
| narrowed spill/reload | 7.96x | +/-2% | ~5% |
| full spill/reload     | 8.02x | +/-4% | ~3% |

The full interleaved run (two pairs, alternating) finished after that
conclusion was drawn and confirms it more strongly:

    narrow 7.96x   full 8.02x
    narrow 7.91x   full 7.91x

The second pair is identical. Four measurements, no separation between the
configurations at all — **on a harness that can see 4%.** The change has no
measurable effect even on the kernel built to expose it. Reverted again, and
this time the negative is trustworthy rather than merely unproven.

So both hypotheses about the call tax are dead. It is not the funcref table
(direct calls already bypass it) and it is not the register spill/reload
(removing two thirds of it changes nothing). The 18 wasm memory operations
around a call are real in the emitted text, but they evidently are not what
the ~8x is made of — plausibly V8 already collapses redundant stores and
loads to the same linear-memory slots, which would make the wat-level
instruction count a poor proxy for cost. That is worth remembering
generally: counting emitted ops has now mispredicted twice.

What is left as a candidate is the call machinery itself rather than what
surrounds it — the wasm frame, the stack-budget load/compare/store on every
call, and whatever V8 charges to enter a generated function. Measuring that
needs a different experiment: vary the callee's size and see how the per-call
cost amortises, which separates fixed frame cost from anything proportional
to the spill set.

## The call tax is fixed, and it amortises to near parity

Rather than guess a third mechanism after the funcref table and the
spill/reload both failed, measure the *shape* of the cost: identical call
structure, callees of 1, 8 and 64 operations.

| callee body | native (ms) | engine (ms) | ratio | spread |
|-------------|------------:|------------:|------:|-------:|
| 1 op   |  990.8 | 8083.8 | **7.78x** | +/-4% |
| 8 ops  |  939.2 | 2647.9 | **2.53x** | +/-2% |
| 64 ops | 1601.6 | 2470.5 | **1.38x** | +/-7% |

Monotonic, and steep. This is the signature of a **fixed per-call charge**,
not a cost proportional to anything around the call — which is why narrowing
the spill set did nothing, and why removing an indirection that was already
absent did nothing.

Two consequences, and the second is the important one.

**The 8x headline was an artifact of the callee's size.** A function whose
entire body is `x * 2654435761 + 1` pays the frame charge on every call with
nothing to amortise it against. Real code does not call functions that small
in hot loops, and where it does, compilers inline them — as gcc did to this
very kernel until `noinline` forced the issue.

**Translated code inside a function is close to native.** Fitting
engine = F + k*W across the last two points gives k ~ 1.2: the body itself
runs at roughly 1.2x native, with a fixed charge worth on the order of ten
leaf-bodies per call. That is a much better picture of the translator than
any aggregate so far, and it means the straight-line codegen — the thing an
SSA-and-register-allocation rewrite would target — is not where the
remaining gap lives.

The target is therefore the call boundary itself: the wasm frame, the
stack-budget load/compare/store executed on every call, and V8's cost to
enter a generated function. Whether any of that is reducible is the next
question; unlike the previous two candidates, this one is measured to matter
before anything is written.

Caveat: `call64` carries +/-7% spread at 10.8% startup, so 1.38x has real
uncertainty. The trend across three points does not.

## The stack-budget check is not the fixed charge either

The amortisation curve made the target specific: a fixed per-call charge
worth roughly ten leaf-bodies. Three things sit inside that boundary — the
stack-budget check, the wasm frame, and V8's cost to enter a generated
function. Only the first is under the translator's control, so it went
first.

The direct-call sequence normally emits a load of the depth counter, a
compare against the limit, a store, the call, and a restore. A
diagnostic-only build (`OXWASM_NO_STACKGUARD=1`) dropped all of it and
emitted the bare `call`. This is not shippable in any form: the check is
what stops deep guest recursion from blowing the wasm stack, and without it
the callout escape never fires. It exists to be measured and then removed.

Interleaved four times against the guarded build, on the 1-op callee where
the fixed charge is at its most visible:

| build | ratio | spread |
|-------|------:|-------:|
| guard   | 7.46x | +/-3% |
| noguard | 7.41x | +/-6% |
| guard   | 7.37x | +/-3% |
| noguard | 7.72x | +/-4% |

The two builds interleave rather than separate — the noguard points bracket
the guard points in both directions. At this harness's ~4% resolution the
stack-budget check costs nothing measurable, on the kernel constructed to
make it maximally visible.

That is the third mechanism eliminated inside the call boundary, after the
funcref table and the spill/reload. What remains — the wasm call frame and
V8's entry cost — is not something the translator emits, so it cannot be
emitted differently.

Which changes the question. If the per-call charge is fixed and none of its
components are ours, the lever is not making calls cheaper but **making
fewer of them**: inlining small callees into the caller's translation unit
so the frame never exists. The amortisation curve already says what that is
worth — a callee big enough to hide the charge runs at 1.38x, and a call
removed entirely pays nothing at all. That is the next hypothesis, and like
the last three it gets measured before it gets built.

## What real binaries actually call

Everything above measures the call boundary on kernels built to expose it.
None of it says what the boundary costs a real program, and the amortisation
curve makes that a question about the program rather than the translator: if
the charge is fixed at roughly 22 native instruction-times, what it costs
depends entirely on how far apart a program's calls are.

`tools/callprof.mjs` runs an unmodified binary in the interpreter, where
`cpu.onCall` fires on every executed call, counts targets, and sizes each one
with the same whole-function analysis the unit builder uses. Two input sizes
are differenced so the number is steady state, not ld.so — startup alone is
about 100k instructions at 96 per call, which on a short run *is* the
measurement.

| program | steady-state insns/call | charge share | hot callees |
|---------|------------------------:|-------------:|-------------|
| `sha256sum` 200KB | **184,223** | ~0% | none — 47 calls total |
| `gzip -1` 200KB   | **77**      | **~20%** | three, of 66/88/114 insns |

The two ends are as far apart as the question allows.

**sha256sum's hot loop calls nothing.** Its whole steady state — 8.66M
instructions of block transform — contains 47 calls. The per-call charge is
not a small cost here, it is not a cost at all, and no amount of work on the
call boundary would move this program by a measurable amount.

**gzip's hot loop calls constantly**, and one call every 77 instructions puts
the fixed charge at about a fifth of its engine time. But the shape of that
is much more specific than "gzip makes a lot of calls":

| callee | size | calls | share |
|--------|-----:|------:|------:|
| `0x408ce0` |  66 insns | 125,586 | 51.3% |
| `0x405190` |  88 insns |  67,012 | 27.4% |
| `0x404420` | 114 insns |  48,103 | 19.7% |

Three functions, 268 instructions between them, are **98.4%** of every call
gzip makes. Splicing those three into their callers is a bounded, concrete
change — not a general inliner, three functions — and it is the whole of the
20%.

Two things this settles.

**The 8x call figure never described a real program.** gzip, the most
call-dense real workload measured, pays ~20%, not 8x, because its callees are
66-114 instructions rather than one. The synthetic kernel measured the charge
correctly and represented nothing.

**Inlining is worth building, but as a targeted transform with a size budget
in the low hundreds.** A 64-instruction cutoff — the obvious first guess, and
the one this tool shipped with — classifies all three of gzip's hot callees
as too large and reports 0.2% inlinable. The opportunity sits just past where
an unmeasured threshold would have hidden it.

Caveat: the interpreter is a faithful stand-in for the *distribution* of call
targets, which is a property of the program, but instructions-per-call is not
the same as time-per-call. A program whose calls sit inside cheap
straight-line code pays the charge more often per unit of native time than
this ratio suggests, and one whose calls surround expensive instructions pays
it less. The two programs here are far enough apart that the ordering is not
in doubt; a number in the middle would need the timing done directly.

### What shape the inliner has to be

Before writing one: gzip's three hot callees, analyzed.

| callee | insns | blocks | rets | calls |
|--------|------:|-------:|-----:|------:|
| `0x408ce0` |  66 |  **9** | 1 | 1 |
| `0x405190` |  88 | **19** | 2 | 0 |
| `0x404420` | 114 | **32** | 1 | 0 |

The cheap version of this optimisation — splice single-block leaf callees,
whose translation is a straight-line instruction list that can be pasted into
the caller with no control flow to fix up — captures **none** of them. Not one
of the three is a single block, and two have more than one `ret`.

So the transform that is worth 20% of gzip is the expensive one: merge the
callee's block graph into the caller's, renumber the RPO indices the dispatch
loop branches on, and route every `ret` to a join block instead of a wasm
return. That is a real change to `emitUnitFunction`, not a special case at the
call site.

Worth knowing before starting rather than after. The easy version would have
compiled, passed the suite, and moved gzip by nothing.
