// Differential: the packed shifts whose count is a REGISTER or memory operand.
//
// psrlw/psrld/psrlq, psraw/psrad and psllw/pslld/psllq all have an immediate
// form the emitter has done for a while and a by-operand form it refused, so
// any function using one stayed interpreted. The census over real binaries
// reported that refusal three times under `AOT sse op d3`.
//
// The rule is not wasm's. x86 takes the whole low QUADWORD of the source as
// the count and answers zero for a shift at or past the lane width; wasm takes
// the count modulo the width, so a count of 16 on i16x8 shifts by nothing
// instead of wiping the register. The arithmetic form is different again: it
// clamps to width-1, because shifting a signed lane out entirely leaves the
// sign behind. The counts here are chosen for exactly those edges - at the
// width, one past it, and values far too large to fit in the lane or in 32
// bits at all.
//
// Hardware is the oracle for both engines.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, BUF = 0x420000n, SENT = 0xdeadbee0n;
const OPS = ['psrlw','psrld','psrlq','psraw','psrad','psllw','pslld','psllq'];
const COUNTS = [0n, 1n, 7n, 8n, 15n, 16n, 17n, 31n, 32n, 63n, 64n, 255n,
                0x100000000n, 0xFFFFFFFFFFFFFFFFn, 0x8000000000000000n];
// one signed-looking pattern and one with bits at both ends of every lane
const DATA = [0x8001F0F07FFF0001n | (0xFFFF8000A5A5C3C3n << 64n),
              0x0123456789ABCDEFn | (0xFEDCBA9876543210n << 64n)];
const hex = (v) => v.toString(16).padStart(32, '0');

let bad = 0, n = 0, refused = 0;
for (const op of OPS) {
  for (const mem of [0, 1]) {
    // the count sits in the low quadword of the source; the high half is
    // ignored, so it is filled with something that would be wrong to read
    const src = mem ? '[0x420020]' : 'xmm1';
    const body = `movdqu xmm0, [0x420000]\nmovdqu xmm1, [0x420020]\n${op} xmm0, ${src}\nmovdqu [0x420100], xmm0\nret`;
    writeFileSync('/tmp/vs.asm', 'BITS 64\n' + body);
    execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/vs.bin', '/tmp/vs.asm']);
    const code = new Uint8Array(0x30000); code.set(readFileSync('/tmp/vs.bin'));
    let r;
    try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
    catch (e) { refused++; console.log(`  REFUSED ${op} mem=${mem}: ${e.message.slice(0, 60)}`); continue; }
    writeFileSync('/tmp/vs.wat', r.wat);
    execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/vs.wat', '-o', '/tmp/vs.wasm']);
    const mod = new WebAssembly.Module(readFileSync('/tmp/vs.wasm'));

    for (const A of DATA) for (const c of COUNTS) {
      const B = c | (0xDEADBEEFDEADBEEFn << 64n);
      const C = `int main(){unsigned char b[300] __attribute__((aligned(16)));unsigned long long*q=(unsigned long long*)b;
        q[0]=0x${(A & ((1n<<64n)-1n)).toString(16)}ULL; q[1]=0x${(A>>64n).toString(16)}ULL;
        q[4]=0x${(B & ((1n<<64n)-1n)).toString(16)}ULL; q[5]=0x${(B>>64n).toString(16)}ULL;
        asm volatile("movdqu %1,%%xmm0\\n\\tmovdqu %2,%%xmm1\\n\\t${op} ${mem ? '%2' : '%%xmm1'},%%xmm0\\n\\tmovdqu %%xmm0,%0"
          :"=m"(b[256]):"m"(b[0]),"m"(b[32]):"xmm0","xmm1");
        for(int i=271;i>=256;i--) __builtin_printf("%02x", b[i]); __builtin_printf("\\n"); return 0;}`;
      writeFileSync('/tmp/vs.c', C);
      execFileSync('gcc', ['-O1', '-o', '/tmp/vsbin', '/tmp/vs.c']);
      const hw = execFileSync('/tmp/vsbin').toString().trim();

      const m = new Memory([{ base: CODE, bytes: code.slice() }]);
      m.write(BUF, 8n, A & ((1n<<64n)-1n)); m.write(BUF + 8n, 8n, A >> 64n);
      m.write(BUF + 0x20n, 8n, B & ((1n<<64n)-1n)); m.write(BUF + 0x28n, 8n, B >> 64n);
      const cpu = new CPU(m);
      for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
      cpu.regs[4] = CODE + 0x1000n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
      let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 50) throw new Error('runaway ' + op); }
      const it = hex((m.read(BUF + 0x108n, 8n) << 64n) | m.read(BUF + 0x100n, 8n));

      const wmem = new WebAssembly.Memory({ initial: 4096 });
      const stub = () => { throw new Error('escape'); };
      const inst = new WebAssembly.Instance(mod, { js: { mem: wmem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                                   env: { syscall: stub, callout: stub, deopt: stub, loophot: stub, codewrite: stub } });
      const rv = new BigInt64Array(wmem.buffer, 0, 16), dv = new DataView(wmem.buffer);
      new Uint8Array(wmem.buffer).set(code, 0);
      const off = Number(BUF - CODE);
      dv.setBigUint64(off, A & ((1n<<64n)-1n), true); dv.setBigUint64(off + 8, A >> 64n, true);
      dv.setBigUint64(off + 0x20, B & ((1n<<64n)-1n), true); dv.setBigUint64(off + 0x28, B >> 64n, true);
      for (let q = 0; q < 16; q++) rv[q] = 0n;
      rv[4] = BigInt.asIntN(64, CODE + 0x1000n);
      dv.setBigUint64(0x1000, SENT, true);
      inst.exports[r.entryName]();
      const ao = hex((dv.getBigUint64(off + 0x108, true) << 64n) | dv.getBigUint64(off + 0x100, true));

      n++;
      if (hw !== it || hw !== ao) { bad++;
        if (bad <= 10) console.log(`  ${op} mem=${mem} count=${c.toString(16)}\n      hw     ${hw}` +
          (it !== hw ? `\n      interp ${it}` : '') + (ao !== hw ? `\n      aot    ${ao}` : '')); }
    }
  }
}
console.log(`\n${n - bad}/${n} by-operand packed shift results match hardware in BOTH engines ` +
            `(${OPS.length} ops x 2 operand forms x ${DATA.length} data x ${COUNTS.length} counts)`);
if (refused) console.log(`${refused} refused`);
if (bad || refused) process.exit(1);
