// Decompose the call tax. Both prior hypotheses are dead - direct calls
// already bypass the funcref table, and narrowing the CALLER's spill/reload
// measured nothing on a 4%-resolution harness. What was never isolated is
// the rest of the per-call protocol: the callee's own regfile load at entry
// and store at exit, the stack-budget check, and whatever V8 charges for the
// call itself. Five arms, same loop as k_call (s += leaf(i) ^ leaf(s),
// leaf(x) = x*2654435761 + 1), interleaved, two-N subtraction everywhere:
//
//   native    the kernels binary
//   plain     wasm param/result calling convention, state in locals
//   budget    plain + the stack-budget load/compare/store at every call site
//   regmem    arguments and results through the linear-memory regfile slots
//             (store arg, call; callee loads, computes, stores; caller loads)
//   faithful  the emitter's full protocol: caller spills 9 regs + budget
//             check, callee loads 8 regs at entry and stores 8 at exit,
//             caller reloads 9 - the shape the README's dump shows
//
// Every wasm callee carries a never-taken branch full of dead stores so V8's
// wasm inliner cannot fold it into the caller - otherwise "plain" would
// measure the loop, not the call. The engine's real unit functions are far
// past the inlining budget anyway.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';

const BIN = new URL('./kernels', import.meta.url).pathname;
const N1 = Number(process.env.N1 || 5e6), N2 = Number(process.env.N2 || 1e7);
const REPS = Number(process.env.REPS || 7);
const C = '2654435761';

const DEAD = `(if (i64.eq (local.get $x) (i64.const 0xDEADBEEFCAFEBABE)) (then ` +
  Array.from({length: 24}, (_, i) => `(i64.store (i32.const ${4096 + i * 8}) (local.get $x))`).join(' ') + '))';

const CALLEE_PLAIN = `(func $leaf (param $x i64) (result i64) ${DEAD}
    (i64.add (i64.mul (local.get $x) (i64.const ${C})) (i64.const 1)))`;

// budget check as the emitter emits it: load counter, bounded compare,
// bump/restore around the call
const BUDGET = (call) => `(local.set $fts (i32.load (i32.const 65544)))
      (i32.store (i32.const 65544) (i32.add (local.get $fts) (i32.const 1)))
      ${call}
      (i32.store (i32.const 65544) (local.get $fts))`;

const mods = {
plain: `(module (import "js" "mem" (memory 256))
  ${CALLEE_PLAIN}
  (func (export "run") (param $n i64) (result i64)
    (local $i i64) (local $s i64)
    (loop $l
      (local.set $s (i64.add (local.get $s)
        (i64.xor (call $leaf (local.get $i)) (call $leaf (local.get $s)))))
      (local.set $i (i64.add (local.get $i) (i64.const 1)))
      (br_if $l (i64.ne (local.get $i) (local.get $n))))
    (local.get $s)))`,

budget: `(module (import "js" "mem" (memory 256))
  ${CALLEE_PLAIN}
  (func (export "run") (param $n i64) (result i64)
    (local $i i64) (local $s i64) (local $a i64) (local $fts i32)
    (loop $l
      ${BUDGET(`(local.set $a (call $leaf (local.get $i)))`)}
      ${BUDGET(`(local.set $s (i64.add (local.get $s) (i64.xor (local.get $a) (call $leaf (local.get $s)))))`)}
      (local.set $i (i64.add (local.get $i) (i64.const 1)))
      (br_if $l (i64.ne (local.get $i) (local.get $n))))
    (local.get $s)))`,

regmem: `(module (import "js" "mem" (memory 256))
  (func $leaf (local $x i64)
    (local.set $x (i64.load (i32.const 56)))
    ${DEAD}
    (i64.store (i32.const 0) (i64.add (i64.mul (local.get $x) (i64.const ${C})) (i64.const 1))))
  (func (export "run") (param $n i64) (result i64)
    (local $i i64) (local $s i64) (local $a i64)
    (loop $l
      (i64.store (i32.const 56) (local.get $i)) (call $leaf)
      (local.set $a (i64.load (i32.const 0)))
      (i64.store (i32.const 56) (local.get $s)) (call $leaf)
      (local.set $s (i64.add (local.get $s) (i64.xor (local.get $a) (i64.load (i32.const 0)))))
      (local.set $i (i64.add (local.get $i) (i64.const 1)))
      (br_if $l (i64.ne (local.get $i) (local.get $n))))
    (local.get $s)))`,

faithful: `(module (import "js" "mem" (memory 256))
  (func $leaf
    (local $r0 i64) (local $r1 i64) (local $r2 i64) (local $r3 i64)
    (local $r6 i64) (local $r7 i64) (local $r8 i64) (local $r9 i64) (local $x i64)
    (local.set $r0 (i64.load (i32.const 0)))  (local.set $r1 (i64.load (i32.const 8)))
    (local.set $r2 (i64.load (i32.const 16))) (local.set $r3 (i64.load (i32.const 24)))
    (local.set $r6 (i64.load (i32.const 48))) (local.set $r7 (i64.load (i32.const 56)))
    (local.set $r8 (i64.load (i32.const 64))) (local.set $r9 (i64.load (i32.const 72)))
    (local.set $x (local.get $r7))
    ${DEAD}
    (local.set $r0 (i64.add (i64.mul (local.get $x) (i64.const ${C})) (i64.const 1)))
    (i64.store (i32.const 0) (local.get $r0))  (i64.store (i32.const 8) (local.get $r1))
    (i64.store (i32.const 16) (local.get $r2)) (i64.store (i32.const 24) (local.get $r3))
    (i64.store (i32.const 48) (local.get $r6)) (i64.store (i32.const 56) (local.get $r7))
    (i64.store (i32.const 64) (local.get $r8)) (i64.store (i32.const 72) (local.get $r9)))
  (func (export "run") (param $n i64) (result i64)
    (local $i i64) (local $s i64) (local $a i64) (local $fts i32)
    (loop $l
      (i64.store (i32.const 0) (local.get $s))  (i64.store (i32.const 8) (local.get $i))
      (i64.store (i32.const 16) (local.get $a)) (i64.store (i32.const 24) (local.get $n))
      (i64.store (i32.const 32) (local.get $s)) (i64.store (i32.const 40) (local.get $i))
      (i64.store (i32.const 48) (local.get $a)) (i64.store (i32.const 56) (local.get $i))
      (i64.store (i32.const 64) (local.get $n))
      ${BUDGET(`(call $leaf)`)}
      (local.set $a (i64.load (i32.const 0)))
      (i64.store (i32.const 56) (local.get $s))
      ${BUDGET(`(call $leaf)`)}
      (local.set $s (i64.add (local.get $s) (i64.xor (local.get $a) (i64.load (i32.const 0)))))
      (local.set $i (i64.add (local.get $i) (i64.const 1)))
      (br_if $l (i64.ne (local.get $i) (local.get $n))))
    (local.get $s)))`,
};

const build = (wat, name) => {
  const w = `/tmp/ic_${name}.wat`;
  writeFileSync(w, wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w, '-o', w + '.wasm']);
  const mod = new WebAssembly.Module(readFileSync(w + '.wasm'));
  const mem = new WebAssembly.Memory({ initial: 256 });
  const inst = new WebAssembly.Instance(mod, { js: { mem } });
  unlinkSync(w); unlinkSync(w + '.wasm');
  return { run: inst.exports.run };
};

const timeNative = (n) => { const t0 = process.hrtime.bigint();
  const out = execFileSync(BIN, ['call', String(n)]).toString().trim();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out }; };
const timeWasm = (f, n) => { const t0 = process.hrtime.bigint();
  const r = f.run(BigInt(n));
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out: `call ${BigInt.asUintN(64, r)}` }; };

const arms = {};
const want = timeNative(1e5).out;
for (const [name, wat] of Object.entries(mods)) {
  const f = build(wat, name);
  timeWasm(f, 1e6); timeWasm(f, 1e6);           // warm to top tier
  const got = timeWasm(f, 1e5).out;
  if (got !== want) { console.log(`ABORT: ${name} disagrees: ${got} vs ${want}`); process.exit(1); }
  arms[name] = { f, xs: [] };
}
console.log(`outputs agree at n=1e5: ${want}`);

const nat = [];
for (let r = 0; r < REPS; r++) {
  nat.push(timeNative(N2).ms - timeNative(N1).ms);
  for (const a of Object.values(arms)) a.xs.push(timeWasm(a.f, N2).ms - timeWasm(a.f, N1).ms);
}
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const spread = (a) => { const s = a.slice().sort((x, y) => x - y); return (s[s.length - 1] - s[0]) / med(a) * 100; };
console.log(`\nsteady-state ms for ${(N2 - N1) / 1e6}M iterations = ${(N2 - N1) * 2 / 1e6}M calls (median of ${REPS}, interleaved):`);
console.log(`  ${'native'.padEnd(9)} ${med(nat).toFixed(1).padStart(7)}ms  spread +/-${spread(nat).toFixed(0)}%`);
for (const [k, a] of Object.entries(arms))
  console.log(`  ${k.padEnd(9)} ${med(a.xs).toFixed(1).padStart(7)}ms  spread +/-${spread(a.xs).toFixed(0)}%  ${(med(a.xs) / med(nat)).toFixed(2)}x`);
