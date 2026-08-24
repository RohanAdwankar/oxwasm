# M3 AOT — running unmodified x86-64 binaries in WebAssembly at native speed

The M3 engine takes an **unmodified, already-compiled** x86-64 function and
translates its machine code, whole-function, into one WebAssembly function
(`aot_wat.mjs`). No source, no recompilation, no annotations — the input is
the exact bytes `clang`/`gcc` emitted. Nothing about any specific program is
baked into the translator.

## How it works

1. Recover the control-flow graph from the raw bytes (decode reachable code,
   split into basic blocks, find leaders).
2. Reconstruct structured control flow (loops/blocks) from the CFG via a
   Stackifier over the reverse-postorder block layout — real wasm loops, not a
   `br_table` interpreter.
3. Emit one wasm function: the 16 GPRs live in wasm locals, memory accesses hit
   wasm linear memory, and CPU flags are computed **lazily** — a flag-setting
   instruction is only materialized if a later consumer (a `jcc`, `cmov`, or
   `setcc`) actually reads it before it is overwritten.
4. Registers used only as 32-bit working values become `i32` locals; the
   callee-saved 64-bit value still round-trips correctly through the prologue
   push / epilogue pop.

Every result below is **differential-tested**: the same decoded instructions
are executed by a BigInt interpreter oracle (validated against real hardware)
and by the compiled wasm, on identical inputs, and the outputs are compared
bit-for-bit.

## Measured performance

Two ceilings matter. **Native** is the x86 binary on real hardware.
**From-source wasm** is the *same C* compiled straight to wasm by `clang`'s
wasm backend and run in the same V8 — the best any wasm could do for that
program, and therefore the true ceiling the AOT is chasing. The AOT starts
from the *compiled x86 binary*, with none of the source.

| kernel          | character                          | native | from-src wasm | AOT wasm | AOT vs native | AOT vs wasm-ceiling |
|-----------------|------------------------------------|-------:|--------------:|---------:|:-------------:|:-------------------:|
| `collatz_total` | branchless `cmov`, no memory       | 25.1ms |     21.3ms    |  21.5ms  | **0.86x** (faster) | **1.01x** (at ceiling) |
| `fnv1a`         | byte hash, 64-bit mul, 1 load/byte |  1.26ms|      1.26ms   |   1.26ms | **1.00x** (parity) | **1.00x** (at ceiling) |
| `saxpy_sum`     | streams two int32 arrays           |  0.54ms|      0.72ms   |   1.04ms | 1.93x         | 1.45x               |
| `md5_blocks`    | rolled round loop, table in memory | 158ms  |      165ms    |   222ms  | 1.41x         | 1.35x               |

Reproduce: `node aot/bench-all.mjs` (needs `wat2wasm`; build the kernels with
`clang -O2 -fno-vectorize -fno-slp-vectorize -fcf-protection=none -static
aot/kernels.c aot/kernels_main.c -o /tmp/kernels_s`).

## What the numbers mean

**There is no inherent WebAssembly performance penalty.** On compute-bound
code the AOT sits *exactly on the wasm ceiling* and reaches native parity
(`fnv1a`, 1.00x) or beats native (`collatz`, 0.86x — and note the wasm
ceiling itself is 0.85x native here: V8's register allocation and code layout
for the tight `cmov` loop come out ahead of `clang`'s x86).

The `collatz`/`fnv1a` "at ceiling" column is the key result: where the AOT is
1.00–1.01x of hand-compiled-from-source wasm, there is nothing left for the
translator to recover — it is producing code as good as the source compiler's.

Two separable effects explain the memory-bound cases, and they split cleanly
into "V8's ceiling" vs "translator headroom":

- **V8's linear-memory ceiling (not recoverable by us).** Even from source,
  `saxpy` is 1.33x native — V8 reaches ~¾ of native memory bandwidth on a
  straight array scan, with no SIMD and no `base+index*4` addressing mode.
  That 1.33x is a floor no wasm translator can beat for this loop.

- **Translator headroom (recoverable).** Above that floor, the AOT is still
  1.45x over the wasm ceiling on `saxpy` and 1.35x over it on `md5` — that part
  *is* ours to close. `saxpy` headroom is strided-address computation (the x86
  uses 64-bit indexed loads; from-source advances an i32 pointer). `md5`
  headroom is that the x86 binary keeps its 64-round loop *rolled* with the
  message schedule *in memory* (16 GPRs forced that); from-source fully unrolls
  and keeps it in locals. Closing `md5` to its 1.05x ceiling means re-deriving
  that unrolling from the binary (loop unroll + constant-address rodata folding
  + array-to-local promotion) — re-optimizing, not just translating.

Progress so far on the recoverable part: emitting wasm's native
sign-extending loads for `movsx` of memory took `saxpy` from 2.22x to 1.93x
native (1.68x → 1.45x over the ceiling).

## Instruction coverage

Validated on four structurally different binaries. Supported: the integer ALU,
shifts/rotates, `lea`, `movzx`/`movsx`, `push`/`pop`/`leave`, two/three-operand
and widening multiply (`imul`/`mul`), `cmov`, `setcc`, and the full
conditional-branch set with lazy flags. Not yet: SSE/AVX vector instructions
(auto-vectorized loops), `div`/`idiv`, and calls that leave the function.
