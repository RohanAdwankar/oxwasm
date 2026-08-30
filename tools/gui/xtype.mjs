// Type into xterm through the X server and see whether the shell running on
// the other end of the pty echoes it back. This is the first exercise of the
// canonical-mode line discipline against a real program rather than a unit
// test: keystrokes go X -> xterm -> pty master -> line discipline -> shell.
import { LinuxEngine } from '../../engine/linux.mjs';
import { XServer } from '../../engine/xserver.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';

const files = {}, mtimes = {};
const add=(g,h)=>{try{files[g]=new Uint8Array(readFileSync(h));mtimes[g]=0;}catch{}};
for (const d of ['/lib/x86_64-linux-gnu','/usr/lib/x86_64-linux-gnu','/lib64']) {
  let e;try{e=readdirSync(d);}catch{continue;}
  for(const f of e){try{const r=realpathSync(join(d,f));if(lstatSync(r).isFile())add(join(d,f),r);}catch{}}}
add('/etc/ld.so.cache','/etc/ld.so.cache');
(function w(d,g){let e;try{e=readdirSync(d);}catch{return;}
  for(const f of e){const hp=join(d,f),gp=g+'/'+f;let st;try{st=lstatSync(hp);}catch{continue;}
    if(st.isDirectory())w(hp,gp); else {try{add(gp,realpathSync(hp));}catch{}}}})('/usr/share/X11/locale','/usr/share/X11/locale');
for (const b of ['/usr/bin/xterm','/bin/dash','/bin/sh','/bin/echo']) add(b,b);

const CACHE = new URL('./watcache/', import.meta.url).pathname;
try { mkdirSync(CACHE, { recursive: true }); } catch {}
let an = 0;
const assembleWat = (wat) => {
  const h = createHash('sha1').update(wat).digest('hex'), cp = CACHE + h + '.wasm';
  if (existsSync(cp)) return new Uint8Array(readFileSync(cp));
  const w = `/tmp/xt_${process.pid}_${an++}`;
  writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
  const b = new Uint8Array(readFileSync(w + '.wasm'));
  try { unlinkSync(w + '.wat'); unlinkSync(w + '.wasm'); } catch {}
  try { writeFileSync(cp, b); } catch {}
  return b;
};

const xs = new XServer({ width: 480, height: 200 });
const eng = new LinuxEngine(files['/usr/bin/xterm'], {
  argv: ['/usr/bin/xterm'],
  env: ['DISPLAY=:0','PATH=/bin:/usr/bin','HOME=/root','LANG=C','SHELL=/bin/sh','TERM=xterm'],
  files, mtimes, memMB: 512, xserver: xs, tty: true, assembleWat });

// The shell DRAINS what it reads, so the residual buffers say nothing about
// what flowed. Tap each pty's two queues at creation and accumulate.
const tap = { toShell: [], toScreen: [] };
const newPty0 = eng.newPty.bind(eng);
eng.newPty = () => {
  const p = newPty0();
  for (const [buf, sink] of [[p.m2s, tap.toShell], [p.s2m, tap.toScreen]]) {
    const push0 = buf.chunks.push.bind(buf.chunks);
    buf.chunks.push = (...xs) => { for (const c of xs) sink.push(...c); return push0(...xs); };
  }
  return p;
};

const step = (ms) => { const t = Date.now();
  while (Date.now() - t < ms) { eng.run(2e7); if (eng.blocked) eng.wake(); } };

// char -> pc105 keycode, the same layout xserver.mjs builds
const KC = {};
[[10,'1234567890'],[24,'qwertyuiop'],[38,'asdfghjkl'],[52,'zxcvbnm']]
  .forEach(([s, cs]) => [...cs].forEach((c, i) => { KC[c] = s + i; }));
KC[' '] = 65; KC['\n'] = 36; KC['-'] = 20; KC['.'] = 60; KC['/'] = 61;

const type = (s) => { for (const ch of s) {
  const k = KC[ch]; if (k === undefined) continue;
  xs.injectKey(k, true); step(120); xs.injectKey(k, false); step(120); } };

step(12000);                                              // let xterm come up
const win = [];
(function walk(w){ if(!w) return; if(w.mapped && w.cls!==2) win.push(`${w.w}x${w.h}`); (w.children||[]).forEach(walk); })(xs.root);
console.log('windows:', win.join(' '));

// find the pty the shell is on, and watch what the SHELL receives + emits
const ptys = [...eng.ptys.values()];
console.log('ptys allocated:', ptys.length);

type('echo hi\n');
step(15000);

const dec = (b) => new TextDecoder().decode(new Uint8Array(b));
console.log('TOTAL -> shell:  ' + JSON.stringify(dec(tap.toShell).slice(0, 200)));
console.log('TOTAL -> screen: ' + JSON.stringify(dec(tap.toScreen).slice(0, 400)));
for (const p of ptys) console.log(`pty${p.n} pending line: ${JSON.stringify(dec(p.line || []))}`);
console.log('children:', (eng.children||[]).length, 'exit=', eng.exitCode);
console.log('stderr:', (eng.stderr||[]).join('').slice(0,200));
