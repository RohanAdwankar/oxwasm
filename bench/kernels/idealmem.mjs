// Is `mem`'s 4.1x the emitter's code shape, or the wasm platform's floor?
//
// The kernel table says memory streaming is the worst straight-line class,
// and the WAT dump said its op count is already close to what the x86 does.
// This runs the SAME loop three ways and interleaves the reps:
//
//   native    the kernels binary's k_mem, timed at two iteration counts so
//             startup cancels (the harness's own methodology)
//   faithful  hand-written WAT in the EMITTER's exact shape: all state in
//             i64 locals, address = wrap(base + (i<<3)) + negative constant,
//             a lazy-flag compare ($fa/$fb/$fr) at the back edge
//   ideal     hand-written WAT as a human would: i32 index, the buffer
//             offset folded into the load/store offset immediate, one
//             compare at the back edge
//
// faithful/native isolates what the translation COSTS today; ideal/native is
// the wasm floor for this loop on this VM; faithful/ideal is the part the
// emitter could still win. Same buffer size (8KB, L1-resident) as k_mem.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';

const BIN = new URL('./kernels', import.meta.url).pathname;
const N1 = Number(process.env.N1 || 3e7), N2 = Number(process.env.N2 || 6e7);
const REPS = Number(process.env.REPS || 7);

const BUFOFF = 1 << 20;               // buffer at 1MB into wasm memory, like RAMOFF
// the emitter's address constant is (wasm base of the buffer) minus (guest
// base), a NEGATIVE i32 added after the wrap; model that exactly by giving
// the "guest" pointer a high base the constant subtracts away
const GUESTBASE = 0x400000n;
const K = BUFOFF - Number(GUESTBASE); // like -3145728 in the dumped unit, sign varies with layout

const faithful = `(module
  (import "js" "mem" (memory 256))
  (func (export "run") (param $n i64) (result i64)
    (local $r0 i64) (local $r1 i64) (local $r2 i64) (local $r6 i64) (local $r7 i64)
    (local $fa i64) (local $fb i64) (local $fr i64)
    (local.set $r7 (i64.const ${GUESTBASE}))
    (local.set $r0 (i64.const 0))
    (local.set $r6 (i64.const 0))
    (loop $l
      (local.set $r2 (local.get $r0))
      (local.set $r2 (i64.extend_i32_u (i32.and (i32.wrap_i64 (local.get $r2)) (i32.const 1023))))
      (local.set $r1 (i64.add (local.get $r7) (i64.shl (local.get $r2) (i64.const 3))))
      (local.set $r2 (i64.load (i32.add (i32.wrap_i64 (local.get $r1)) (i32.const ${K}))))
      (local.set $r2 (i64.add (local.get $r2) (local.get $r0)))
      (local.set $r0 (i64.add (local.get $r0) (i64.const 1)))
      (i64.store (i32.add (i32.wrap_i64 (local.get $r1)) (i32.const ${K})) (local.get $r2))
      (local.set $r6 (i64.xor (local.get $r6) (local.get $r2)))
      (local.set $fa (local.get $r0))
      (local.set $fb (local.get $n))
      (local.set $fr (i64.sub (local.get $r0) (local.get $n)))
      (br_if $l (i64.ne (local.get $fr) (i64.const 0))))
    (local.get $r6)))`;

const ideal = `(module
  (import "js" "mem" (memory 256))
  (func (export "run") (param $n i64) (result i64)
    (local $i i64) (local $s i64) (local $p i32) (local $v i64)
    (loop $l
      (local.set $p (i32.shl (i32.and (i32.wrap_i64 (local.get $i)) (i32.const 1023)) (i32.const 3)))
      (local.set $v (i64.add (i64.load offset=${BUFOFF} (local.get $p)) (local.get $i)))
      (i64.store offset=${BUFOFF} (local.get $p) (local.get $v))
      (local.set $s (i64.xor (local.get $s) (local.get $v)))
      (local.set $i (i64.add (local.get $i) (i64.const 1)))
      (br_if $l (i64.ne (local.get $i) (local.get $n))))
    (local.get $s)))`;

const build = (wat, name) => {
  const w = `/tmp/im_${name}.wat`;
  writeFileSync(w, wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w, '-o', w + '.wasm']);
  const mod = new WebAssembly.Module(readFileSync(w + '.wasm'));
  const mem = new WebAssembly.Memory({ initial: 256 });
  const inst = new WebAssembly.Instance(mod, { js: { mem } });
  unlinkSync(w); unlinkSync(w + '.wasm');
  return { run: inst.exports.run, mem };
};

// same steady-state extraction everywhere: time at N2 and N1, take the diff,
// so per-arm fixed costs (ELF load and JIT for native, instantiate and V8
// tier-up for wasm) cancel
const timeNative = (n) => { const t0 = process.hrtime.bigint();
  const out = execFileSync(BIN, ['mem', String(n)]).toString().trim();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out }; };
const timeWasm = (f, n) => {
  // native gets a FRESH process (zeroed BSS buf) every exec; the wasm arms
  // reuse one memory the kernel mutates, so without this the checksums
  // diverge from the second run on - the agreement check caught exactly that
  new Uint8Array(f.mem.buffer, BUFOFF, 8192).fill(0);
  const t0 = process.hrtime.bigint();
  const r = f.run(BigInt(n));
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out: `mem ${BigInt.asUintN(64, r)}` }; };

const fa = build(faithful, 'faithful'), id = build(ideal, 'ideal');
// warmup so V8's top tier is in place before any timed rep
timeWasm(fa, 1e6); timeWasm(id, 1e6);

// the three arms must AGREE on the result or the ratios mean nothing
const want = timeNative(1e6).out;
for (const [name, f] of [['faithful', fa], ['ideal', id]]) {
  const got = timeWasm(f, 1e6).out;
  if (got !== want) { console.log(`ABORT: ${name} disagrees with native: ${got} vs ${want}`); process.exit(1); }
}
console.log(`outputs agree at n=1e6: ${want}`);

const arms = { native: [], faithful: [], ideal: [] };
for (let r = 0; r < REPS; r++) {          // interleaved, so load drift hits all arms alike
  arms.native.push(timeNative(N2).ms - timeNative(N1).ms);
  arms.faithful.push(timeWasm(fa, N2).ms - timeWasm(fa, N1).ms);
  arms.ideal.push(timeWasm(id, N2).ms - timeWasm(id, N1).ms);
}
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const spread = (a) => { const s = a.slice().sort((x, y) => x - y); return (s[s.length - 1] - s[0]) / med(a) * 100; };
console.log(`\nsteady-state ms for ${N2 - N1} iterations (median of ${REPS}, interleaved):`);
for (const [k, a] of Object.entries(arms))
  console.log(`  ${k.padEnd(9)} ${med(a).toFixed(1).padStart(7)}ms  spread +/-${spread(a).toFixed(0)}%`);
const n = med(arms.native);
console.log(`\n  faithful/native ${(med(arms.faithful) / n).toFixed(2)}x   ` +
            `ideal/native ${(med(arms.ideal) / n).toFixed(2)}x   ` +
            `faithful/ideal ${(med(arms.faithful) / med(arms.ideal)).toFixed(2)}x`);
