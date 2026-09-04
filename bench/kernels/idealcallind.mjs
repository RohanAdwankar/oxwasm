// Ideal indirect-call kernel: the callind loop (s += tab[(i^(s>>3))&3](i) ^ tab[s&3](s))
// as hand-written wasm, state in locals, four leaves reached ONLY through
// call_indirect on a 4-entry table (megamorphic site, like perl's runloop).
// Prices V8's call_indirect floor against native's 825 ms / 120M calls.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
const leaf = (name, body) => `(func $${name} (param $x i64) (result i64)
  ;; never-taken branch of dead stores so V8's inliner cannot fold the leaf
  (if (i64.eq (local.get $x) (i64.const -7)) (then (i64.store (i32.const 0) (local.get $x)) (i64.store (i32.const 8) (local.get $x))))
  ${body})`;
const wat = `(module
  (memory 1)
  (type $t (func (param i64) (result i64)))
  (table $tab 4 funcref)
  ${leaf('a', '(i64.add (i64.mul (local.get $x) (i64.const 2654435761)) (i64.const 1))')}
  ${leaf('b', '(i64.add (i64.mul (local.get $x) (i64.const 40503)) (i64.const 3))')}
  ${leaf('c', '(i64.add (i64.xor (local.get $x) (i64.shr_u (local.get $x) (i64.const 7))) (i64.const 5))')}
  ${leaf('d', '(i64.add (i64.mul (local.get $x) (i64.const 9)) (i64.const 7))')}
  (elem (i32.const 0) $a $b $c $d)
  (func (export "run") (param $n i64) (result i64)
    (local $i i64) (local $s i64)
    (block $done (loop $l
      (br_if $done (i64.ge_u (local.get $i) (local.get $n)))
      (local.set $s (i64.add (local.get $s) (i64.xor
        (call_indirect (type $t) (local.get $i) (i32.and (i32.wrap_i64 (i64.xor (local.get $i) (i64.shr_u (local.get $s) (i64.const 3)))) (i32.const 3)))
        (call_indirect (type $t) (local.get $s) (i32.and (i32.wrap_i64 (local.get $s)) (i32.const 3))))))
      (local.set $i (i64.add (local.get $i) (i64.const 1)))
      (br $l)))
    (local.get $s)))`;
writeFileSync('/tmp/ici.wat', wat);
execFileSync('wat2wasm', ['/tmp/ici.wat', '-o', '/tmp/ici.wasm']);
const { instance } = await WebAssembly.instantiate(readFileSync('/tmp/ici.wasm'), {});
const N = 60000000n;
instance.exports.run(3000000n);   // warm
const t = [];
for (let r = 0; r < 5; r++) { const t0 = process.hrtime.bigint(); const s = instance.exports.run(N); t.push(Number(process.hrtime.bigint() - t0) / 1e6); if (r === 0) console.log('s =', s); }
t.sort((a, b) => a - b); console.log('ideal callind wasm: median', t[2].toFixed(0), 'ms for', N, 'iterations (2 calls each); native callind 825 ms ->', (t[2] / 825).toFixed(2) + 'x');
