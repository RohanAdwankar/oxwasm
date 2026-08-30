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
