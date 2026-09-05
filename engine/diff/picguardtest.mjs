// Analyzer test for the PIC jump-table guard: the entry count of a
// `lea table(%rip); movslq (tbl,idx,4); add; jmp *reg` switch comes from
// the bounds compare an UNSIGNED branch consumes. Three shapes, assembled
// flat with nasm and analyzed straight from the bytes:
//   t1: cmp $10,eax; ja  -> 11 entries
//   t2: cmp $4,eax;  jae -> 4 entries (K is the count, not the last index)
//   t3: the guard is on a copy (cl) and a case test `cmp $0x1f,eax; je`
//       sits between it and the load (LLVM's FindRoots): NO table - the
//       old rule took the case test for the bound, read 32 entries, and
//       two phantom leaders landed inside real instructions, hiding a jmp
//       (rustc's compile died on a wild address).
// Every decoded instruction must start where the previous one ended
// (no overlapping decode) - the property the phantom leaders broke.
import { analyze } from '../aot_wat.mjs';
import { Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'picguard-'));
const ORG = 0x400000;
const ASM = `
bits 64
org ${ORG}
t1: cmp eax, 10
    ja  .dflt
    lea rcx, [rel .tab1]
    movsxd rax, dword [rcx + rax*4]
    add rax, rcx
    jmp rax
.c0: inc rbx
.dflt: ret
.tab1: times 11 dd .c0 - .tab1
.junk1: dd 0x100, 0x200, 0x300, 0x400            ; would be entries 12-15
        nop

t2: cmp eax, 4
    jae .dflt
    lea rcx, [rel .tab2]
    movsxd rax, dword [rcx + rax*4]
    add rax, rcx
    jmp rax
.c0: inc rbx
.dflt: ret
.tab2: times 4 dd .c0 - .tab2
.junk2: dd 0x5000, 0x6000                          ; entries 5,6 would be wild
        nop

t3: movzx eax, byte [r14 - 0x18]
    lea ecx, [rax - 0x1e]
    cmp cl, 0xb
    jae .dflt
    cmp eax, 0x1f
    je .c0
    add eax, -0x1e
    lea rcx, [rel .tab3]
    movsxd rax, dword [rcx + rax*4]
    add rax, rcx
    jmp rax
.c0: inc rbx
.dflt: ret
.tab3: times 11 dd .c0 - .tab3
.after: dd 0x77, 0x78                             ; the bytes the 32-entry read walked into
        mov dword [rdx + rcx + 4], 1              ; c7 44 0a 04 01 00 00 00: an 8-byte insn a phantom leader split
        jmp .c0
        lea r10, [rbx*8]
        and r10, -0x20
        ret
`;
writeFileSync(join(dir, 't.asm'), ASM);
execFileSync('nasm', ['-f', 'bin', '-o', join(dir, 't.bin'), join(dir, 't.asm')]);
const bytes = new Uint8Array(readFileSync(join(dir, 't.bin')));
const mem = new Memory([{ base: BigInt(ORG), bytes }]);
const syms = {}; // entry offsets: nasm bin has no symbols, so find the three entries by their opening bytes
const find = (pat, from = 0) => { for (let i = from; i < bytes.length; i++) if (pat.every((b, k) => bytes[i + k] === b)) return i; return -1; };
syms.t1 = find([0x83, 0xf8, 0x0a, 0x77]);                       // cmp eax,10; ja
syms.t2 = find([0x83, 0xf8, 0x04, 0x73]);                       // cmp eax,4; jae
syms.t3 = find([0x41, 0x0f, 0xb6, 0x46, 0xe8]);                 // movzx eax, byte [r14-0x18]
let fails = 0;
const check = (name, want) => {
  const a = analyze(mem, BigInt(ORG + syms[name]), {});
  const tabs = [...(a.jtabs || [])].map(([k, v]) => v.length);
  const got = tabs.length ? tabs[0] : 0;
  // no overlapping decode anywhere in the function
  const insns = a.blocks.flatMap(b => b.insns).sort((x, y) => (x.rip < y.rip ? -1 : x.rip > y.rip ? 1 : 0));
  let overlap = null;
  for (let i = 1; i < insns.length; i++) if (insns[i].rip < insns[i - 1].rip + BigInt(insns[i - 1].len)) { overlap = insns[i].rip.toString(16); break; }
  const ok = got === want && !overlap;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: table entries ${got} (want ${want})${overlap ? ' overlapping decode at ' + overlap : ''}`);
};
check('t1', 11);
check('t2', 4);
check('t3', 0);
if (fails) { console.log(`picguardtest: ${fails} FAILED`); process.exit(1); }
console.log('picguardtest: all ok');
