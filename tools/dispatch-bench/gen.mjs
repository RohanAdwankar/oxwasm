// Model of an LLInt-style handler chain: NH handlers in a funcref table; each does a little work on guest regs, then jumps to
// the next handler chosen from a bytecode stream. Variants differ only in the jump protocol.
const NH = 64, STEPS = 100_000_000;
function handlerBody(variant, i) {
  const work = `(local.set $r0 (i64.add (local.get $r0) (i64.const ${i + 1})))
    (local.set $r2 (i64.xor (local.get $r2) (i64.shl (local.get $r0) (i64.const 3))))
    (local.set $r6 (i64.add (local.get $r6) (i64.and (local.get $r2) (i64.const 255))))`;
  // next handler index: byte stream at 1048576 + (pc & 4095), pc in r8
  const next = `(local.set $r8 (i64.add (local.get $r8) (i64.const 1)))
    (local.set $rex (i64.load8_u (i32.add (i32.const 1048576) (i32.and (i32.wrap_i64 (local.get $r8)) (i32.const 4095)))))`;
  const regs = ['r0','r2','r6','r8','r12'];
  const load = regs.map((r, k) => `(local.set $${r} (i64.load (i32.const ${k * 8})))`).join('\n    ');
  const store = regs.map((r, k) => `(i64.store (i32.const ${k * 8}) (local.get $${r}))`).join('\n    ');
  const decl = ['r0','r2','r6','r8','r12','rex'].map((r) => `(local $${r} i64)`).join(' ') + ' (local $fti i32) (local $icp i32)';
  if (variant === 'full') return `(func $h${i} (result i64) ${decl}
    ${load}
    (i32.store (i32.const 65544) (i32.add (i32.load (i32.const 65544)) (i32.const 1)))
    ${work}
    ${next}
    ${store}
    (local.set $icp (i32.add (i32.const 393216) (i32.shl (i32.shr_u (i32.mul (i32.wrap_i64 (local.get $rex)) (i32.const 0x9E3779B1)) (i32.const 17)) (i32.const 4))))
    (if (i64.eq (i64.load (local.get $icp)) (local.get $rex)) (then (local.set $fti (i32.load (i32.add (local.get $icp) (i32.const 8))))) (else (local.set $fti (i32.const -1))))
    (if (i32.and (i32.and (i32.ge_s (local.get $fti) (i32.const 0)) (i32.and (i32.lt_u (i32.load (i32.const 65544)) (i32.const 1200)) (i32.ne (i32.load (i32.const 65548)) (i32.const 0)))) (i32.or (i64.le_u (local.get $r12) (i64.const 1)) (i32.or (i32.eqz (i32.load (i32.const 65556))) (i32.load8_u (i32.add (i32.const 98304) (local.get $fti))))))
      (then (i32.store (i32.const 65548) (i32.sub (i32.load (i32.const 65548)) (i32.const 1))) (i32.store (i32.const 65544) (i32.sub (i32.load (i32.const 65544)) (i32.const 1))) (return_call_indirect (type $uft) (local.get $fti))))
    (i64.const -1))`;
  if (variant === 'min') return `(func $h${i} (result i64) ${decl}
    ${load}
    ${work}
    ${next}
    (if (i64.gt_u (local.get $r8) (i64.const ${STEPS})) (then (return (local.get $r0))))
    ${store}
    (return_call_indirect (type $uft) (i32.wrap_i64 (local.get $rex))))`;
  // params: registers passed on the tail call
  return `(func $h${i} (param $r0 i64) (param $r2 i64) (param $r6 i64) (param $r8 i64) (param $r12 i64) (result i64) (local $rex i64)
    ${work}
    ${next}
    (if (i64.gt_u (local.get $r8) (i64.const ${STEPS})) (then (return (local.get $r0))))
    (return_call_indirect (type $pft) (local.get $r0) (local.get $r2) (local.get $r6) (local.get $r8) (local.get $r12) (i32.wrap_i64 (local.get $rex))))`;
}
for (const v of ['full', 'min', 'params']) {
  const hs = Array.from({ length: NH }, (_, i) => handlerBody(v, i)).join('\n  ');
  const table = Array.from({ length: NH }, (_, i) => `$h${i}`).join(' ');
  const stop = v === 'params' ? '' : '';
  const wat = `(module
  (memory (export "mem") 1100)
  (type $uft (func (result i64)))
  (type $pft (func (param i64 i64 i64 i64 i64) (result i64)))
  (table $t ${NH} funcref)
  (elem (i32.const 0) ${table})
  ${hs}
  (func (export "run") (result i64)
    ${v === 'params' ? '(call $h0 (i64.const 0) (i64.const 0) (i64.const 0) (i64.const 0) (i64.const 1))' : '(call $h0)'}))
`;
  console.log(v, wat.length);
  (await import('node:fs')).writeFileSync(v + '.wat', wat);
}
