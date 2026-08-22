// Directed + random differential cases.
import { runCase } from './run.mjs';

const directed = [
  ['mov-imm', 'mov rax, 42\nmov rbx, 0x123456789abcdef0\nmov ecx, 0xdeadbeef\nmov dl, 7\nmov si, 0x1234'],
  ['alu-reg', 'add rax, rbx\nsub rcx, rdx\nand rsi, rdi\nor r8, r9\nxor r10, r11\ncmp rax, rcx\ntest rbx, rdx'],
  ['alu-32', 'add eax, ebx\nsub ecx, 5\nxor edx, edx\nand esi, 0xff\nor edi, 0x100\ncmp eax, ebx'],
  ['alu-imm', 'add rax, 0x7f\nsub rbx, -128\nand rcx, 0x12345678\ncmp rdx, 0\nadd rax, -1'],
  ['inc-dec', 'inc rax\ndec rbx\ninc ecx\ndec edx\nneg rsi\nnot rdi\nneg r8'],
  ['mem-rw', `mov rbx, 0x20000100
mov rax, [rbx]
mov [rbx+8], rax
add rax, [rbx+16]
add [rbx+24], rax
mov ecx, [rbx+4]
mov [rbx+32], ecx
mov dl, [rbx+2]
mov [rbx+40], dl`],
  ['lea-sib', `mov rbx, 0x20000200
mov rcx, 8
lea rax, [rbx+rcx*4+16]
lea edx, [rbx+rcx*2]
mov rsi, [rbx+rcx*8]
lea rdi, [rax+rax*2]`],
  ['movzx-sx', `mov rbx, 0x20000300
movzx rax, byte [rbx]
movzx ecx, word [rbx+2]
movsx rdx, byte [rbx+5]
movsx rsi, word [rbx+6]
movsxd rdi, dword [rbx+8]
movzx r8, cl
movsx r9d, dl`],
  ['shifts-1', 'shl rax, 1\nshr rbx, 1\nsar rcx, 1\nshl edx, 1\nsar esi, 1'],
  ['shifts-n', 'shl rax, 5\nshr rbx, 17\nsar rcx, 33\nshr edx, 9\nmov cl, 12\nshl rsi, cl', { flagMask: 0x0C5n }],
  ['imul', 'imul rax, rbx\nimul rcx, rdx, 100\nimul esi, edi\nimul r8, r9, -3', { flagMask: 0x801n }],
  ['push-pop', 'push rax\npush rbx\npop rcx\npop rdx\npush 0x1234\npop rsi\npush -1\npop rdi'],
  ['call-ret', `call f
add rax, 1
jmp end
f:
mov rax, 99
ret
end:
nop`],
  ['branches', `mov rcx, 5
xor rax, rax
loop1:
add rax, rcx
dec rcx
jnz loop1
cmp rax, 15
je good
mov rbx, 0xbad
good:
mov rbx, 0x600d`],
  ['setcc-cmov', `cmp rax, rbx
setb dl
sete cl
setg r8b
cmovl rsi, rbx
cmovge rdi, rax
cmp eax, eax
cmove edx, ecx`],
  ['fib-loop', `mov rdi, 20
xor rax, rax
mov rbx, 1
fib:
test rdi, rdi
jz done
mov rcx, rax
add rax, rbx
mov rbx, rcx
dec rdi
jmp fib
done:
nop`],
];

// random straight-line generator (xorshift for reproducibility)
let seed = 0x9E3779B9n;
const rnd = (n) => { seed ^= seed << 13n & 0xFFFFFFFFn; seed ^= seed >> 17n; seed ^= seed << 5n & 0xFFFFFFFFn; return Number(seed % BigInt(n)); };
const R64 = ['rax','rbx','rcx','rdx','rsi','rdi','r8','r9','r10','r11'];
const R32 = ['eax','ebx','ecx','edx','esi','edi','r8d','r9d','r10d','r11d'];
const R8  = ['al','bl','cl','dl','r8b','r9b','r10b','r11b'];
const pick = (a) => a[rnd(a.length)];
const imm32 = () => (rnd(2) ? -1 : 1) * rnd(0x7fffffff);
function randomCase(idx) {
  const lines = [`mov r12, 0x${(0x20000000 + 0x400 + rnd(0x400)).toString(16)}`, `mov r13, ${rnd(64)}`];
  let usedVarShift = false, usedImul = false;
  const n = 12 + rnd(12);
  for (let i = 0; i < n; i++) {
    switch (rnd(14)) {
      case 0: lines.push(`mov ${pick(R64)}, ${imm32()}`); break;
      case 1: lines.push(`mov ${pick(R32)}, ${imm32()}`); break;
      case 2: lines.push(`${pick(['add','sub','and','or','xor','cmp','test'])} ${pick(R64)}, ${pick(R64)}`); break;
      case 3: lines.push(`${pick(['add','sub','and','or','xor','cmp'])} ${pick(R32)}, ${pick(R32)}`); break;
      case 4: lines.push(`${pick(['add','sub','and','or','xor','cmp'])} ${pick(R64)}, ${imm32()}`); break;
      case 5: lines.push(`mov ${pick(R64)}, [r12+${rnd(128)}]`); break;
      case 6: lines.push(`mov [r12+${rnd(128)}], ${pick(R64)}`); break;
      case 7: lines.push(`${pick(['add','sub','xor'])} ${pick(R64)}, [r12+${rnd(128)}]`); break;
      case 8: lines.push(`lea ${pick(R64)}, [r12+r13*${pick([1,2,4,8])}+${rnd(256)}]`); break;
      case 9: lines.push(`${pick(['movzx','movsx'])} ${pick(R64)}, byte [r12+${rnd(128)}]`); break;
      case 10: { const c = rnd(63) + 1; if (c !== 1) usedVarShift = true;
        lines.push(`${pick(['shl','shr','sar'])} ${pick(R64)}, ${c}`); break; }
      case 11: usedImul = true; lines.push(`imul ${pick(R64)}, ${pick(R64)}`); break;
      case 12: lines.push(`${pick(['inc','dec','neg','not'])} ${pick(R64)}`); break;
      case 13: lines.push(`${pick(['add','xor','cmp'])} ${pick(R8)}, ${pick(R8)}`); break;
    }
  }
  let mask = 0x8C5n;
  if (usedVarShift) mask &= ~0x800n;
  if (usedImul) mask &= ~0x0C4n;
  return [`rand-${idx}`, lines.join('\n'), { flagMask: mask }];
}

const N_RANDOM = Number(process.argv[2] || 200);
const all = [...directed];
for (let i = 0; i < N_RANDOM; i++) all.push(randomCase(i));

let pass = 0, fail = 0, totalSteps = 0;
for (const [name, asm, opts] of all) {
  const r = runCase(name, asm + '\nret', opts);
  if (r.ok) { pass++; totalSteps += r.steps; }
  else { fail++; console.log('FAIL', JSON.stringify(r)); console.log('--- asm:\n' + asm); if (fail > 4) break; }
}
console.log(`\n${pass}/${pass + fail} cases passed, ${totalSteps} instructions verified against hardware`);
