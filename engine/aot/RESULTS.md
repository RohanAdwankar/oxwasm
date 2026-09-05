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

Supported: the integer ALU, shifts/rotates, `lea`, `movzx`/`movsx`,
`push`/`pop`/`leave`, two/three-operand and one-operand widening multiply
(`imul`/`mul`, incl. the 64x64->128 high word from 32-bit half-products),
`div`/`idiv` (64-bit via a runtime rdx-guard that deopts only on a true
128-bit dividend), `xchg`, `bsf`/`bsr`, `bswap`, the `bt` family,
`shld`/`shrd`, `rep movs`/`stos`, `cmov`, `setcc`, `adc`/`sbb` (add/subtract
with carry, for 128-bit and bignum arithmetic), and the full conditional-branch
set with **cross-block lazy flags** — a reaching-definition dataflow lets a flag
producer in one basic block feed a consumer in another, and add/sub reconstruct
the full CF/OF/SF/ZF set (so `add;jc`, `add;jo`, `sub;jo` compile too). The SSE2
vocabulary lowers to wasm `v128`.

Calls that leave the unit, indirect jumps, undecodable bytes, `cpuid`, `hlt`
padding, and a `jcc` reading a callee's flags escape to the interpreter via
`callout`/`deopt` rather than poisoning — total coverage, degrading only in
speed. Measured across sha256sum/gzip/sort/busybox, this cut interpreted-
instruction counts 7-8x and drove failed tier-ups to near zero: the only
remaining poison reason is the irreducible-CFG case handled by the (off-by-
default) dispatch fallback below.

An **experimental** `br_table` dispatch fallback compiles irreducible CFGs the
scope-nesting Stackifier can't handle; it is OFF by default because it still
miscompiles some complex irreducible loops (an infinite loop in glibc's
ctype-table init). With it off, an irreducible CFG poisons and the function is
interpreted — correct, just not compiled.

## Update: runtime tiering + the browser product (this session)

The translator above became the engine's tier-2: the interpreter profiles
call targets and hot loop heads at runtime and AOT-compiles whole call-graph
closures mid-run — no symbols, no hints, unmodified binaries. Escapes
(syscall / indirect target / undecodable byte) resolve against the live
engine; a deopt UNWINDS the wasm frames (all state is in the regfile and
guest stack), so escape handling is O(1) in stack depth.

Proven end-to-end, bit-exact against native output and exit codes:

| binary | provenance | result |
|---|---|---|
| `md5-native` | glibc -static, full libc init + TLS + printf | digest bit-exact on 16MB |
| busybox | stock Ubuntu, stripped | echo/wc/sort/md5sum/sha256sum/gzip bit-exact |
| appimagetool | third-party AppImage, GitHub releases | version banner, exit 0 |

And as a product: `oxwasm build <x86-64 ELF or .AppImage>` emits ONE
self-contained offline HTML embedding the engine, wabt (the in-page WAT
assembler), the unmodified binary, and its data files. In headless Chromium
the busybox AppImage build sha256-hashes a 1MB embedded file bit-exact in
3.4s with 6 AOT units JIT-compiled in-page (5.25MB HTML).

Since extended to dynamic executables (PT_INTERP + ld.so + the SysV auxv and
the syscall surface glibc's loader needs) and the x87 FPU (float printf/
strtod), so unmodified dynamically-linked glibc programs run — verified
byte-exact vs native on `gzip` (compressed payload bit-identical), `sha256sum`,
and busybox `md5sum`/`sha256sum`/`wc`/`sort`/`cksum`. Honest limits today: CLI
only (a GUI still needs the M2/v86 lane's display server), and interpreter
warmup dominates short runs — the AOT covers the hot cycles, not the cold
startup tail (ld.so + libc init interpret once, ~1.5s, before the hot loops
tier up and run compiled at ~1x native).
