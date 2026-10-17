// single-function switch dispatcher with NH cases; each case does BODY ops on a pool of NL i64 locals (like a big translated unit)
import { writeFileSync } from 'node:fs';
const NH = +process.argv[2], NL = +process.argv[3], BODY = +process.argv[4], STEPS = 50_000_000;
let locals = ''; for (let i = 0; i < NL; i++) locals += `(local $l${i} i64) `;
let open = ''; for (let i = NH - 1; i >= 0; i--) open += `(block $c${i}\n`;
const sw = `(br_table ${Array.from({ length: NH }, (_, i) => '$c' + i).join(' ')} $c0 (i32.wrap_i64 (local.get $rex)))`;
let body = '';
for (let i = 0; i < NH; i++) {
  body += `) ;; end $c${i}\n`;
  for (let j = 0; j < BODY; j++) { const a = (i * 7 + j) % NL, b = (i * 3 + j * 5 + 1) % NL; body += `(local.set $l${a} (i64.add (i64.xor (local.get $l${a}) (local.get $l${b})) (i64.const ${i + j + 1})))\n`; }
  body += `(br $dispatch)\n`;
}
const wat = `(module
  (memory (export "mem") 1100)
  (func (export "run") (result i64) ${locals} (local $r8 i64) (local $rex i64)
    (local.set $rex (i64.const 1))
    (loop $dispatch
      (local.set $r8 (i64.add (local.get $r8) (i64.const 1)))
      (if (i64.gt_u (local.get $r8) (i64.const ${STEPS})) (then (return (local.get $l0))))
      (local.set $rex (i64.rem_u (i64.load8_u (i32.add (i32.const 1048576) (i32.and (i32.wrap_i64 (local.get $r8)) (i32.const 4095)))) (i64.const ${NH})))
      ${open}
      ${sw}
      ${body}
    )
    (local.get $l0)))
`;
writeFileSync('big.wat', wat); console.log('wat bytes', wat.length);
