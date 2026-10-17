const NH = 64, STEPS = 100_000_000;
const cases = Array.from({ length: NH }, (_, i) => i);
// nested blocks for br_table: block $c63 ... block $c0 (br_table 0..63) end ;; code for case 0 ... 
let open = '', close = '';
for (let i = NH - 1; i >= 0; i--) open += `(block $c${i}\n`;
const sw = `(br_table ${cases.map((i) => '$c' + i).join(' ')} $c0 (i32.wrap_i64 (local.get $rex)))`;
let body = '';
for (let i = 0; i < NH; i++) {
  body += `) ;; end $c${i}\n(local.set $r0 (i64.add (local.get $r0) (i64.const ${i + 1})))
    (local.set $r2 (i64.xor (local.get $r2) (i64.shl (local.get $r0) (i64.const 3))))
    (local.set $r6 (i64.add (local.get $r6) (i64.and (local.get $r2) (i64.const 255))))
    (br $dispatch)\n`;
}
const wat = `(module
  (memory (export "mem") 1100)
  (func (export "run") (result i64) (local $r0 i64) (local $r2 i64) (local $r6 i64) (local $r8 i64) (local $rex i64)
    (local.set $rex (i64.const 1))
    (loop $dispatch
      (local.set $r8 (i64.add (local.get $r8) (i64.const 1)))
      (if (i64.gt_u (local.get $r8) (i64.const ${STEPS})) (then (return (local.get $r0))))
      (local.set $rex (i64.load8_u (i32.add (i32.const 1048576) (i32.and (i32.wrap_i64 (local.get $r8)) (i32.const 4095)))))
      ${open}
      ${sw}
      ${body}
    )
    (local.get $r0)))
`;
import { writeFileSync } from 'node:fs'; writeFileSync('sw.wat', wat);
