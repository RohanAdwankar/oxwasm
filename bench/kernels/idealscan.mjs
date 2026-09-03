// Is `scan`'s 3.8x the emitter's code shape, or the wasm platform's floor?
//
// The tokenizer-shaped kernel (one byte per iteration, a chain of class
// compares and branches) is 3.80x native through the real emitter. Same
// method as idealmem: the SAME loop three ways, interleaved.
//
//   native    the kernels binary's k_scan (inlined into main), two counts
//   faithful  the EMITTER's WAT for that loop, verbatim from a unit dump of
//             the kernels binary (i64 locals, lazy flags in $fa/$fb/$fr with
//             width masks, sub-width compares masked to 8 bits, the index
//             wrapped and re-extended, addresses wrap(base)+wrap(idx)+K)
//   ideal     the same loop as a human would write it in wasm: i32 index and
//             byte, the buffer offset in the load's immediate, compares that
//             use the value directly
//
// faithful/native is what the translation costs; ideal/native the platform
// floor; faithful/ideal what the emitter could still win on this shape.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';

const BIN = new URL('./kernels', import.meta.url).pathname;
const N1 = Number(process.env.N1 || 1e8), N2 = Number(process.env.N2 || 3e8);
const REPS = Number(process.env.REPS || 7);

const BUFOFF = 1 << 20;
const GUESTBASE = 0x400000n;
const K = BUFOFF - Number(GUESTBASE);
const PAT = "define(`x', eval(12 * 3))dnl\nfoo bar 4711 baz  ";
const fillText = (mem) => { const t = new Uint8Array(mem.buffer, BUFOFF, 4096); for (let i = 0; i < 4096; i++) t[i] = PAT.charCodeAt(i % PAT.length); };

// $r5 = n, $r7 = guest address of text, $r0 = i, $r6/$r10/$r9 = digits/words/spaces, $r8 = s
const faithful = `(module
  (import "js" "mem" (memory 256))
  (func (export "run") (param $n i64) (result i64)
    (local $r0 i64) (local $r1 i64) (local $r2 i64) (local $r5 i64) (local $r6 i64) (local $r7 i64) (local $r8 i64) (local $r9 i64) (local $r10 i64)
    (local $fa i64) (local $fb i64) (local $fr i64)
    (local.set $r5 (local.get $n))
    (local.set $r0 (i64.const 0))
    (local.set $r9 (i64.const 0))
    (local.set $r10 (i64.const 0))
    (local.set $r6 (i64.const 0))
    (local.set $r8 (i64.const 0))
    (local.set $r7 (i64.const ${GUESTBASE}))
    (loop $loop_35
    (block $blk_45
    (local.set $fa (local.get $r5))
    (local.set $fb (local.get $r0))
    (local.set $fr (i64.and (i64.sub (local.get $r5) (local.get $r0)) (i64.const 18446744073709551615)))
    (br_if $blk_45 (i64.eqz (local.get $fr)))
    (block $blk_44
    (block $blk_43
    (local.set $r2 (local.get $r0))
    (local.set $r2 (i64.extend_i32_u (i32.and (i32.wrap_i64 (local.get $r2)) (i32.const 4095))))
    (local.set $r2 (i64.load8_u (i32.add (i32.add (i32.wrap_i64 (local.get $r7)) (i32.wrap_i64 (local.get $r2))) (i32.const ${K}))))
    (local.set $r1 (i64.and (i64.add (i64.const -48) (local.get $r2)) (i64.const 4294967295)))
    (local.set $fa (i64.and (local.get $r1) (i64.const 255)))
    (local.set $fb (i64.const 9))
    (local.set $fr (i64.and (i64.sub (i64.and (local.get $r1) (i64.const 255)) (i64.const 9)) (i64.const 255)))
    (br_if $blk_43 (i64.le_u (local.get $fa) (local.get $fb)))
    (block $blk_39
    (local.set $r1 (i64.and (local.get $r2) (i64.const 4294967295)))
    (local.set $r1 (i64.extend_i32_u (i32.or (i32.wrap_i64 (local.get $r1)) (i32.const 32))))
    (local.set $r1 (i64.extend_i32_u (i32.sub (i32.wrap_i64 (local.get $r1)) (i32.const 97))))
    (local.set $fa (i64.and (local.get $r1) (i64.const 255)))
    (local.set $fb (i64.const 25))
    (local.set $fr (i64.and (i64.sub (i64.and (local.get $r1) (i64.const 255)) (i64.const 25)) (i64.const 255)))
    (br_if $blk_39 (i64.gt_u (local.get $fa) (local.get $fb)))
    (local.set $r10 (i64.add (local.get $r10) (i64.const 1)))
    (br $blk_44)
    )
    (block $blk_42
    (local.set $fa (i64.and (local.get $r2) (i64.const 255)))
    (local.set $fb (i64.const 32))
    (local.set $fr (i64.and (i64.sub (i64.and (local.get $r2) (i64.const 255)) (i64.const 32)) (i64.const 255)))
    (br_if $blk_42 (i64.eqz (local.get $fr)))
    (local.set $fa (i64.and (local.get $r2) (i64.const 255)))
    (local.set $fb (i64.const 10))
    (local.set $fr (i64.and (i64.sub (i64.and (local.get $r2) (i64.const 255)) (i64.const 10)) (i64.const 255)))
    (br_if $blk_42 (i64.eqz (local.get $fr)))
    (local.set $r2 (i64.and (local.get $r2) (i64.const 255)))
    (local.set $r8 (i64.add (local.get $r8) (local.get $r2)))
    (br $blk_44)
    )
    (local.set $r9 (i64.add (local.get $r9) (i64.const 1)))
    (br $blk_44)
    )
    (local.set $r6 (i64.add (local.get $r6) (i64.const 1)))
    )
    (local.set $r0 (i64.add (local.get $r0) (i64.const 1)))
    (br $loop_35)
    )
    )
    (local.set $r0 (i64.mul (local.get $r8) (i64.const 31)))
    (local.set $r10 (i64.mul (local.get $r10) (i64.const 3)))
    (local.set $r0 (i64.add (local.get $r0) (local.get $r10)))
    (local.set $r0 (i64.add (local.get $r0) (local.get $r6)))
    (local.set $r9 (i64.mul (local.get $r9) (i64.const 7)))
    (i64.add (local.get $r0) (local.get $r9))))`;

const ideal = `(module
  (import "js" "mem" (memory 256))
  (func (export "run") (param $n i64) (result i64)
    (local $i i64) (local $c i32) (local $t i32) (local $digits i64) (local $words i64) (local $spaces i64) (local $s i64)
    (block $done
    (loop $l
      (br_if $done (i64.eq (local.get $i) (local.get $n)))
      (local.set $c (i32.load8_u offset=${BUFOFF} (i32.and (i32.wrap_i64 (local.get $i)) (i32.const 4095))))
      (block $next
        (if (i32.le_u (i32.sub (local.get $c) (i32.const 48)) (i32.const 9))
          (then (local.set $digits (i64.add (local.get $digits) (i64.const 1))) (br $next)))
        (if (i32.le_u (i32.sub (i32.or (local.get $c) (i32.const 32)) (i32.const 97)) (i32.const 25))
          (then (local.set $words (i64.add (local.get $words) (i64.const 1))) (br $next)))
        (if (i32.or (i32.eq (local.get $c) (i32.const 32)) (i32.eq (local.get $c) (i32.const 10)))
          (then (local.set $spaces (i64.add (local.get $spaces) (i64.const 1))) (br $next)))
        (local.set $s (i64.add (local.get $s) (i64.extend_i32_u (local.get $c)))))
      (local.set $i (i64.add (local.get $i) (i64.const 1)))
      (br $l)))
    (i64.add (i64.add (i64.add (i64.mul (local.get $s) (i64.const 31)) (local.get $digits)) (i64.mul (local.get $words) (i64.const 3))) (i64.mul (local.get $spaces) (i64.const 7)))))`;

const SHARED = process.env.SHARED === '1', LIVE = process.env.LIVE === '1';
const memDecl = SHARED ? '(memory 4096 65536 shared)' : '(memory 256)';
const build = (wat0, name) => {
  let wat = wat0.replaceAll('(memory 256)', memDecl);
  if (LIVE && name === 'faithful') {
    // eight more guest registers live across the loop, as in the real unit
    wat = wat.replace('(local $fa i64)', '(local $r3 i64) (local $r4 i64) (local $r11 i64) (local $r12 i64) (local $r13 i64) (local $r14 i64) (local $r15 i64) (local $rsp0 i64) (local $fa i64)')
             .replace('(local.set $r7 (i64.const', '(local.set $r3 (i64.const 3)) (local.set $r4 (i64.const 4)) (local.set $r11 (i64.const 11)) (local.set $r12 (i64.const 12)) (local.set $r13 (i64.const 13)) (local.set $r14 (i64.const 14)) (local.set $r15 (i64.const 15)) (local.set $rsp0 (i64.const 16)) (local.set $r7 (i64.const')
             .replace('(i64.add (local.get $r0) (local.get $r9))))', '(i64.add (i64.add (local.get $r0) (local.get $r9)) (i64.mul (i64.const 0) (i64.add (i64.add (i64.add (local.get $r3) (local.get $r4)) (i64.add (local.get $r11) (local.get $r12))) (i64.add (i64.add (local.get $r13) (local.get $r14)) (i64.add (local.get $r15) (local.get $rsp0))))))))');
  }
  const w = `/tmp/is_${name}.wat`;
  writeFileSync(w, wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w, '-o', w + '.wasm']);
  const mod = new WebAssembly.Module(readFileSync(w + '.wasm'));
  const mem = SHARED ? new WebAssembly.Memory({ initial: 4096, maximum: 65536, shared: true }) : new WebAssembly.Memory({ initial: 256 });
  const inst = new WebAssembly.Instance(mod, { js: { mem } });
  unlinkSync(w); unlinkSync(w + '.wasm');
  fillText(mem);
  return { run: inst.exports.run, mem };
};
const timeNative = (n) => { const t0 = process.hrtime.bigint();
  const out = execFileSync(BIN, ['scan', String(n)]).toString().trim();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out }; };
const timeWasm = (f, n) => { const t0 = process.hrtime.bigint();
  const r = f.run(BigInt(n));
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out: `scan ${BigInt.asUintN(64, r)}` }; };

const fa = build(faithful, 'faithful'), id = build(ideal, 'ideal');
timeWasm(fa, 1e6); timeWasm(id, 1e6);
const want = timeNative(1e6).out;
for (const [name, f] of [['faithful', fa], ['ideal', id]]) {
  const got = timeWasm(f, 1e6).out;
  if (got !== want) { console.log(`ABORT: ${name} disagrees with native: ${got} vs ${want}`); process.exit(1); }
}
console.log(`outputs agree at n=1e6: ${want}`);
const arms = { native: [], faithful: [], ideal: [] };
for (let r = 0; r < REPS; r++) {
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
console.log(`\n  faithful/native ${(med(arms.faithful) / n).toFixed(2)}x   ideal/native ${(med(arms.ideal) / n).toFixed(2)}x   faithful/ideal ${(med(arms.faithful) / med(arms.ideal)).toFixed(2)}x`);
