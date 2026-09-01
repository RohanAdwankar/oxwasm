// Build the faithful (emitter-shaped) module as a .wasm for the browser test.
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const BUFOFF = 1 << 20, GUESTBASE = 0x400000n, K = BUFOFF - Number(GUESTBASE);
const faithful = `(module
  (import "js" "mem" (memory 256))
  (func (export "run") (param $n i64) (result i64)
    (local $r0 i64) (local $r1 i64) (local $r2 i64) (local $r6 i64) (local $r7 i64)
    (local $fa i64) (local $fb i64) (local $fr i64)
    (local.set $r7 (i64.const ${GUESTBASE}))
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
writeFileSync('/tmp/tiertest/f.wat', faithful);
execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/tiertest/f.wat', '-o', '/tmp/tiertest/faithful.wasm']);
console.log('wrote', readFileSync('/tmp/tiertest/faithful.wasm').length, 'bytes');
