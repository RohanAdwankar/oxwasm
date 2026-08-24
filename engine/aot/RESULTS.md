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

## Measured performance (AOT wasm vs the native binary, same function)

| kernel          | character                         | native | AOT wasm | ratio  |
|-----------------|-----------------------------------|-------:|---------:|-------:|
| `collatz_total` | branchless `cmov`, no memory      | 25.1ms |  21.5ms  | **0.86x** (faster than native) |
| `fnv1a`         | byte hash, 64-bit mul, 1 load/byte|  1.26ms|   1.26ms | **1.00x** (native parity) |
| `saxpy_sum`     | streams two int32 arrays          |  0.54ms|   1.20ms | 2.22x  |
| `md5_blocks`    | rolled round loop, table in memory | 158ms |   223ms  | 1.41x  |

Reproduce: `node aot/bench-all.mjs` (needs `wat2wasm`; build the kernels with
`clang -O2 -fno-vectorize -fno-slp-vectorize -fcf-protection=none -static
aot/kernels.c aot/kernels_main.c -o /tmp/kernels_s`).

## What the numbers mean

**There is no inherent WebAssembly performance penalty.** On compute-bound
code the AOT reaches native parity (`fnv1a`, 1.00x) and can even beat native
(`collatz`, 0.86x — V8's register allocation and code layout for the tight
`cmov` loop come out slightly ahead of `clang`'s x86).

The gap that remains is on **memory-streaming-bound** code (`saxpy`, `md5`),
and it is not a flaw in the translation — it is two known, separable effects:

- **The wasm linear-memory model.** V8 reaches roughly half of native memory
  bandwidth on a straight array scan; there is no SIMD and no `base+index*4`
  addressing mode, so each element load costs an extra address computation.
  This is what makes `saxpy` (pure streaming) the worst case.

- **Inherited compilation decisions.** `md5_blocks` is 1.41x because the x86
  binary keeps its 64-round loop *rolled* and its message-schedule array *in
  memory* — a consequence of x86 having only 16 GPRs. The AOT faithfully
  reproduces that. The *same MD5 source* compiled straight to wasm runs at
  **1.05x native** (`md5-fromsrc.wasm`, 165ms vs 158ms) because `clang`'s wasm
  backend fully unrolls the loop and keeps the schedule in locals. So the
  ceiling for this algorithm under wasm is 1.05x; closing the AOT's 1.41x to
  that ceiling means *re-deriving* the compiler's unrolling from the binary
  (loop unroll + constant-address rodata folding + array-to-local promotion),
  i.e. re-optimizing, not just translating.

## Instruction coverage

Validated on four structurally different binaries. Supported: the integer ALU,
shifts/rotates, `lea`, `movzx`/`movsx`, `push`/`pop`/`leave`, two/three-operand
and widening multiply (`imul`/`mul`), `cmov`, `setcc`, and the full
conditional-branch set with lazy flags. Not yet: SSE/AVX vector instructions
(auto-vectorized loops), `div`/`idiv`, and calls that leave the function.
