# oxwasm engine (M3) — x86-64 → WASM

The core project: the fast engine that makes `oxwasm gimp.AppImage` literal.
This directory is the **verified foundation** — a decoder, a tier-0
interpreter proven correct against real hardware, and a tier-1 JIT seed that
emits actual WebAssembly.

```
$ node engine/diff/cases.mjs 300      # 316 synthetic cases vs the real CPU
316/316 cases passed, 6037 instructions verified against hardware
$ node engine/diff/realcode.mjs        # gcc -O1/-O2 fib, strlen, mix
6/6 real-code cases, 697 hardware-verified instructions
$ node engine/diff/jittest.mjs         # tier-1 wasm output vs tier-0
3/3 JIT blocks match tier-0
$ node engine/diff/looptest.mjs        # superblock loop JIT vs tier-0
3/3 loops verified
$ node engine/diff/bench2.mjs          # superblock JIT vs native
superblock JIT    2.3x native   (interpreter ~7200x)
```

## How correctness is established

The trick that makes an emulator trustworthy is a **differential oracle**.
`diff/stepper.c` runs a flat x86-64 binary on the real CPU under
`ptrace(SINGLESTEP)` and dumps architectural state — rip, all 16 GPRs, and
flags — after every instruction. `diff/run.mjs` runs the same bytes through
the tier-0 interpreter and asserts equality at every step. A test that
passes has been checked against the actual silicon, not against my
understanding of the manual.

`diff/cases.mjs` feeds it directed cases (every addressing mode, ALU op,
shift, branch, call/ret) plus a reproducible random instruction generator.
`diff/realcode.mjs` goes further: it compiles real C with gcc at -O1 and -O2
and single-steps the optimized output — the honest test, because compilers
emit instruction sequences a handwritten test never would.

Undefined-flag cases (SF/ZF/PF after `imul`, OF after a variable-count
shift) are masked in the comparison, because the hardware result there is
genuinely unspecified — asserting on it would test noise.

## The tiering engine (`engine.mjs`)

`Engine` ties the pieces into one runnable whole. It holds one
`WebAssembly.Memory` as canonical guest state — the 16-entry i64 register
file at offset 0, guest RAM mapped at a fixed offset — and gives the
interpreter a `Uint8Array` view over that same buffer, so interpreter and
compiled code share memory with zero copying; only the 16 registers sync
around a compiled-block call.

It interprets instruction by instruction, profiling backward-branch targets.
When a loop head crosses the hotness threshold it compiles it — SIMD
vectorizer first, superblock JIT second, interpreter fallback if both
decline — and thereafter reaching that head runs the compiled wasm to
completion and resumes interpreting at the loop exit.

```
$ node engine/diff/enginetest.mjs
pixel output: byte-exact vs interpreter
checksum: engine=522240 interpreter=522240  MATCH
tiers compiled: {"simd":1,"superblock":1}
instructions interpreted: 119  (vs 49152+ if fully interpreted)
PASS: correct end-to-end, both SIMD and superblock tiers fired
```

A whole program runs through it: cold preamble interpreted, a hot pixel loop
vectorized, a hot integer reduction superblock-compiled — 119 of ~49k
instructions actually interpreted, the rest run as compiled wasm, output
byte-exact. Integrating the tiers this way surfaced a real bug the
component tests had masked: the byte load used `i64.load8_s` (signed) where
byte *stores* hid the sign, but accumulating the full register value exposed
it — caught by the end-to-end differential, fixed to `load8_u`. That is the
case for an oracle and for integration testing, in one bug.

## The two tiers

- **tier 0 — `interp.mjs`.** BigInt-exact, slow, complete for the core
  integer ISA (mov/lea, the full ALU group incl. adc/sbb, imul, shifts,
  movzx/movsx, push/pop, jcc/jmp/call/ret, setcc, cmov, 8/16/32/64-bit
  operands with correct partial-register and zero-extension semantics).
  Its only job is to be right. It is the oracle every faster tier is
  measured against.

- **tier 1 — `jit.mjs`.** Compiles a straight-line block into a real
  `WebAssembly.Module` that mutates the guest register file in memory.
  Today it covers 32/64-bit mov and the reg/imm ALU ops and bails to the
  interpreter on anything else — exactly how a production tiering JIT hands
  control back. Small, but it closes the loop: `WebAssembly.instantiate`
  accepts the bytes, runs them, and the result matches tier-0.

## What's next (see ../docs/m3-engine.md)

Grow tier-1 to the opcodes GIMP's hot traces actually use (measured, not
guessed), add the software TLB for guest virtual memory, wire lazy flags so
the common define-then-overwrite pattern costs nothing, and swap emitted
modules in via table patching. The interpreter stays the correctness net the
whole way — every new tier-1 opcode is one `jittest` assertion against it.
