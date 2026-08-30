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
