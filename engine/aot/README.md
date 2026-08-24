# oxwasm AOT — whole-function x86-64 → WebAssembly (the Rosetta approach)

The tier-1 JIT is per-loop and block-local: it couldn't compile MD5's
unrolled transform at all, and I wrongly concluded ~2-3x was a translation
floor. It was a floor of *that architecture*, not of WebAssembly. This is
the AOT answer, and it refutes the claim.

`aot_wat.mjs` takes **unmodified compiled machine code**, recovers the whole
function's control-flow graph, and emits ONE wasm function:
- all 16 GPRs live in wasm i64 locals for the function's lifetime,
- any control flow lowered via the universal `br_table` dispatch loop
  (handles arbitrary CFGs — nested loops, early exits — with no interpreter),
- lazy flags: a flag-setting op stashes its inputs; the consuming `jcc`
  recomputes only the bit it needs.

## Measured — MD5 (`md5_blocks`, unmodified clang -O2), 64 MB

| runner | time | vs native |
|---|---|---|
| interpreter (tier-0) | ~9 s | ~55x |
| tier-1 JIT | *declined* — unrolled transform, no loop to catch | — |
| **AOT (this)** | **805 ms** | **5.1x** |
| native | 159 ms | 1.0x |

Bit-exact digest vs native and busybox on multiple inputs (verified). 17
basic blocks → 3155 bytes of wasm, assembled by wat2wasm, sharing the
engine's linear memory.

## Why 5x, and the path to parity

The remaining tax is the dispatch loop: every basic-block transition routes
through the loop header + `br_table` instead of a direct branch, and MD5's
hot inner loop is tiny (~64M dispatch round-trips). Real AOT translators
(Rosetta 2, ~1.1-1.4x native) don't do this — they **reconstruct structured
loops** so a guest loop becomes an actual wasm `loop` with a direct `br`.
That, plus flag-liveness pruning (only materialize flags a branch consumes)
and 32-bit-op narrowing, is the measured path from 5x toward native. The
dispatch loop is the correct *general* fallback; natural loops are the fast
path layered on top.

The honest headline: **AOT binary translation to wasm has no inherent
runtime penalty for this code.** 5x today is engineering headroom, not a law.
