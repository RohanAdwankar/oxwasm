// Price the DISPATCH machinery, in isolation. The narrowing null proved the
// call-tax remainder is not regfile memory traffic; what is left around every
// engine call is how the callee is REACHED: a direct wasm call for in-unit
// targets, or an $ftr hash probe plus a megamorphic call_indirect for
// everything else (perl's opcode loop is entirely the latter). Same loop and
// leaf as idealcall (s += leaf(i) ^ leaf(s)), same minimal regmem protocol in
// every arm so dispatch is the only variable, two-N subtraction, interleaved:
//
//   direct   (call $leaf)
//   indir1   call_indirect, constant table index
//   indir2   call_indirect, index alternates between two identical leafs -
//            what V8's speculation loses when the target varies
//   ftr      the engine's exact $ftr hash probe (verbatim FTR_WAT, populated
//            FTHASH slots, two alternating guest-address keys) feeding the
//            engine's exact callind guard shape (ftHit + depth/fuel checks,
//            burn and restore) - the full out-of-unit dispatch price
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { FTHASH, FTHBITS, FTHMASK, FTDEPTH, FTDLIMIT, FTFUEL } from '../../engine/aot_wat.mjs';

const BIN = new URL('./kernels', import.meta.url).pathname;
const N1 = Number(process.env.N1 || 5e6), N2 = Number(process.env.N2 || 1e7);
const REPS = Number(process.env.REPS || 9);
const C = '2654435761';
const KEYA = 0x1428370, KEYB = 0x142b266;      // two ld.so-shaped guest addresses

const DEAD = (tag) => `(if (i64.eq (local.get $x) (i64.const 0xDEADBEEFCAFEBABE)) (then ` +
  Array.from({length: 24}, (_, i) => `(i64.store (i32.const ${8192 + i * 8}) (local.get $x))`).join(' ') + '))';

// identical leaf everywhere: arg in slot 56, result in slot 0, regmem shape
const LEAF = (name) => `(func ${name} (result i64) (local $x i64)
    (local.set $x (i64.load (i32.const 56)))
    ${DEAD(name)}
    (i64.store (i32.const 0) (i64.add (i64.mul (local.get $x) (i64.const ${C})) (i64.const 1)))
    (i64.const 0))`;

const FTR = `  (func $ftr (param $a i64) (result i32)
    (local $p i32) (local $k i64)
    (local.set $p (i32.add (i32.const ${FTHASH})
      (i32.shl (i32.shr_u (i32.mul (i32.wrap_i64 (local.get $a)) (i32.const 0x9E3779B1))
                          (i32.const ${32 - FTHBITS})) (i32.const 4))))
    (block $done
      (loop $probe
        (local.set $k (i64.load (local.get $p)))
        (br_if $done (i64.eq (local.get $k) (local.get $a)))
        (br_if $done (i64.eqz (local.get $k)))
        (local.set $p (i32.add (i32.const ${FTHASH})
          (i32.and (i32.add (i32.sub (local.get $p) (i32.const ${FTHASH})) (i32.const 16))
                   (i32.const ${FTHMASK}))))
        (br $probe)))
    (if (result i32) (i64.eq (i64.load (local.get $p)) (local.get $a))
      (then (i32.load (i32.add (local.get $p) (i32.const 8))))
      (else (i32.const -1))))`;

// the emitter's callind guard, verbatim shape (burn fuel, bump/restore depth)
const FTCALL = (keyExpr) => `
      (local.set $fti (call $ftr ${keyExpr}))
      (local.set $fts (i32.load (i32.const ${FTDEPTH})))
      (if (i32.and (i32.ge_s (local.get $fti) (i32.const 0))
                   (i32.and (i32.lt_u (i32.load (i32.const ${FTDEPTH})) (i32.const ${FTDLIMIT}))
                            (i32.ne (i32.load (i32.const ${FTFUEL})) (i32.const 0))))
        (then (i32.store (i32.const ${FTFUEL}) (i32.sub (i32.load (i32.const ${FTFUEL})) (i32.const 1)))
              (drop (call_indirect $ft (type $uft) (local.get $fti)))
              (i32.store (i32.const ${FTDEPTH}) (local.get $fts)))
        (else (unreachable)))`;

// IC hit-path shape: key/fti in a per-site slot, then the verbatim guard
const ICCALL = (ic, keyExpr) => `
      (if (i64.eq (i64.load (i32.const ${ic})) ${keyExpr})
        (then (local.set $fti (i32.sub (i32.load (i32.const ${ic + 8})) (i32.const 1))))
        (else (local.set $fti (call $ftr ${keyExpr}))
              (i64.store (i32.const ${ic}) ${keyExpr})
              (i32.store (i32.const ${ic + 8}) (i32.add (local.get $fti) (i32.const 1)))))
      (local.set $fts (i32.load (i32.const ${FTDEPTH})))
      (if (i32.and (i32.ge_s (local.get $fti) (i32.const 0))
                   (i32.and (i32.lt_u (i32.load (i32.const ${FTDEPTH})) (i32.const ${FTDLIMIT}))
                            (i32.ne (i32.load (i32.const ${FTFUEL})) (i32.const 0))))
        (then (i32.store (i32.const ${FTFUEL}) (i32.sub (i32.load (i32.const ${FTFUEL})) (i32.const 1)))
              (drop (call_indirect $ft (type $uft) (local.get $fti)))
              (i32.store (i32.const ${FTDEPTH}) (local.get $fts)))
        (else (unreachable)))`;

// hash + FIRST probe inlined at the site; $ftr call only on slot mismatch
const INLCALL = (keyExpr, pl, kl) => `
      (local.set ${pl} (i32.add (i32.const ${FTHASH})
        (i32.shl (i32.shr_u (i32.mul (i32.wrap_i64 ${keyExpr}) (i32.const 0x9E3779B1))
                            (i32.const ${32 - FTHBITS})) (i32.const 4))))
      (local.set ${kl} (i64.load (local.get ${pl})))
      (if (i64.eq (local.get ${kl}) ${keyExpr})
        (then (local.set $fti (i32.load (i32.add (local.get ${pl}) (i32.const 8)))))
        (else (local.set $fti (call $ftr ${keyExpr}))))
      (local.set $fts (i32.load (i32.const ${FTDEPTH})))
      (if (i32.and (i32.ge_s (local.get $fti) (i32.const 0))
                   (i32.and (i32.lt_u (i32.load (i32.const ${FTDEPTH})) (i32.const ${FTDLIMIT}))
                            (i32.ne (i32.load (i32.const ${FTFUEL})) (i32.const 0))))
        (then (i32.store (i32.const ${FTFUEL}) (i32.sub (i32.load (i32.const ${FTFUEL})) (i32.const 1)))
              (drop (call_indirect $ft (type $uft) (local.get $fti)))
              (i32.store (i32.const ${FTDEPTH}) (local.get $fts)))
        (else (unreachable)))`;

const LOOP = (callA, callB, extraLocals = '') => `(func (export "run") (param $n i64) (result i64)
    (local $i i64) (local $s i64) (local $a i64) ${extraLocals}
    (loop $l
      (i64.store (i32.const 56) (local.get $i)) ${callA}
      (local.set $a (i64.load (i32.const 0)))
      (i64.store (i32.const 56) (local.get $s)) ${callB}
      (local.set $s (i64.add (local.get $s) (i64.xor (local.get $a) (i64.load (i32.const 0)))))
      (local.set $i (i64.add (local.get $i) (i64.const 1)))
      (br_if $l (i64.ne (local.get $i) (local.get $n))))
    (local.get $s))`;

const HEAD = `(module (import "js" "mem" (memory 256))
  (type $uft (func (result i64)))
  (table $ft 8 funcref)
  ${LEAF('$leaf')}
  ${LEAF('$leaf2')}
  (elem (i32.const 1) $leaf $leaf2)`;

const mods = {
direct: `${HEAD}
  ${LOOP('(drop (call $leaf))', '(drop (call $leaf))')})`,

indir1: `${HEAD}
  ${LOOP('(drop (call_indirect $ft (type $uft) (i32.const 1)))',
         '(drop (call_indirect $ft (type $uft) (i32.const 1)))')})`,

indir2: `${HEAD}
  ${LOOP('(drop (call_indirect $ft (type $uft) (i32.const 1)))',
         '(drop (call_indirect $ft (type $uft) (i32.const 2)))')})`,

ftr: `${HEAD}
${FTR}
  ${LOOP(FTCALL(`(i64.const ${KEYA})`), FTCALL(`(i64.const ${KEYB})`),
         '(local $fti i32) (local $fts i32)')})`,

// the IC hit path: two constant-address loads + compare feeding the same guard
icarm: `${HEAD}
${FTR}
  ${LOOP(ICCALL(0xE0000, `(i64.const ${KEYA})`), ICCALL(0xE0010, `(i64.const ${KEYB})`),
         '(local $fti i32) (local $fts i32)')})`,

// the $ftr body's FIRST probe inlined at the site (no wasm call), with the
// out-of-line $ftr only as the chain-miss fallback that never fires here
inlprobe: `${HEAD}
${FTR}
  ${LOOP(INLCALL(`(i64.const ${KEYA})`, '$p1', '$k1'), INLCALL(`(i64.const ${KEYB})`, '$p2', '$k2'),
         '(local $fti i32) (local $fts i32) (local $p1 i32) (local $k1 i64) (local $p2 i32) (local $k2 i64)')})`,
};

const slotOf = (a) => FTHASH + ((((Math.imul(a, 0x9E3779B1) >>> (32 - FTHBITS)) << 4)) & FTHMASK);
const build = (wat, name) => {
  const w = `/tmp/id_${name}.wat`;
  writeFileSync(w, wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w, '-o', w + '.wasm']);
  const mod = new WebAssembly.Module(readFileSync(w + '.wasm'));
  const mem = new WebAssembly.Memory({ initial: 256 });
  const inst = new WebAssembly.Instance(mod, { js: { mem } });
  unlinkSync(w); unlinkSync(w + '.wasm');
  const dv = new DataView(mem.buffer);
  // populate the hash slots and give the guard room: depth 0, fuel maxed
  for (const [key, idx] of [[KEYA, 1], [KEYB, 2]]) {
    const p = slotOf(key);
    dv.setBigUint64(p, BigInt(key), true); dv.setUint32(p + 8, idx, true);
  }
  dv.setUint32(FTDEPTH, 0, true); dv.setUint32(FTFUEL, 0x7fffffff, true);
  return { run: inst.exports.run, dv };
};

const timeNative = (n) => { const t0 = process.hrtime.bigint();
  const out = execFileSync(BIN, ['call', String(n)]).toString().trim();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out }; };
const timeWasm = (f, n) => {
  f.dv.setUint32(FTFUEL, 0x7fffffff, true);    // refuel: the guard burns one per call
  const t0 = process.hrtime.bigint();
  const r = f.run(BigInt(n));
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out: `s=${BigInt.asUintN(64, r)}` }; };

const arms = {};
let want = null;
for (const [name, wat] of Object.entries(mods)) {
  const f = build(wat, name);
  timeWasm(f, 1e6); timeWasm(f, 1e6);           // warm to top tier
  const got = timeWasm(f, 1e5).out;
  if (want === null) want = got;
  else if (got !== want) { console.log(`ABORT: ${name} disagrees: ${got} vs ${want}`); process.exit(1); }
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
console.log(`  ${'native'.padEnd(7)} ${med(nat).toFixed(1).padStart(7)}ms  spread +/-${spread(nat).toFixed(0)}%`);
for (const [k, a] of Object.entries(arms))
  console.log(`  ${k.padEnd(7)} ${med(a.xs).toFixed(1).padStart(7)}ms  spread +/-${spread(a.xs).toFixed(0)}%  ${(med(a.xs) / med(nat)).toFixed(2)}x`);
