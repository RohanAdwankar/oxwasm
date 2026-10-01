#!/usr/bin/env node
// shellpage - build ONE static HTML file that is an interactive Linux shell.
//
//   node tools/shellpage.mjs [-o oxwasm-shell.html] [--busybox /path/to/static/busybox]
//
// The page carries the engine, a statically linked busybox (ash and ~270
// applets), a few example files and a terminal emulator (xterm.js). Open it
// from a file or any static host: no server, no network, nothing to install.
// The guest is a real x86-64 Linux userland executing in the tab.
//
// What it is not: it has no network (a browser has no raw sockets) and no
// package manager. For `apt install` use the Node SDK and `oxwasm shell`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const args = process.argv.slice(2);
let out = 'oxwasm-shell.html', bb = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') out = args[++i];
  else if (args[i] === '--busybox') bb = args[++i];
  else { console.error('usage: shellpage [-o out.html] [--busybox static-busybox]'); process.exit(2); }
}
bb ??= ['/bin/busybox', '/usr/bin/busybox'].find(existsSync);
if (!bb) { console.error('shellpage: no busybox found (install busybox-static, or pass --busybox)'); process.exit(1); }
const bbBytes = readFileSync(bb);
if (!(bbBytes[0] === 0x7f && bbBytes[1] === 0x45 && bbBytes[4] === 2)) { console.error('shellpage: busybox is not an ELF64'); process.exit(1); }
{ // a dynamic busybox would need a loader and libraries the page does not carry
  const phoff = Number(bbBytes.readBigUInt64LE(32)), phnum = bbBytes.readUInt16LE(56), phsz = bbBytes.readUInt16LE(54);
  for (let i = 0; i < phnum; i++) if (bbBytes.readUInt32LE(phoff + i * phsz) === 3) { console.error('shellpage: busybox is dynamically linked; use busybox-static'); process.exit(1); }
}
const applets = execFileSync(bb, ['--list']).toString().trim().split('\n').filter(Boolean);

const MODS = ['interp', 'decode', 'jit2', 'jitsimd', 'aot_wat', 'linux'];
const importMap = { imports: {} };
const dataUrl = (src) => 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
for (const m of MODS) importMap.imports['ox/' + m] = dataUrl(readFileSync(join(ROOT, 'engine', m + '.mjs'), 'utf8').replace(/from '\.\/(\w+)\.mjs'/g, "from 'ox/$1'"));
importMap.imports['ox/shell'] = dataUrl(readFileSync(join(ROOT, 'shellpage', 'shell-core.mjs'), 'utf8'));

const V = (f) => readFileSync(join(ROOT, 'shellpage', 'vendor', f), 'utf8');
const gzb64 = (b) => gzipSync(b).toString('base64');

const MOTD = `
  oxwasm - an x86-64 Linux userland running in this browser tab.
  Real binaries (busybox ash + ${applets.length} applets), no server, no network.

  Try:  ls /bin | head      echo "hello" | tr a-z A-Z      vi notes.txt
        seq 1 10 | awk '{s+=$1} END {print s}'      cat /etc/motd

`;
const FILES = {
  '/etc/motd': MOTD,
  '/etc/profile': 'cd /root\nalias ll="ls -la"\n',
  '/etc/passwd': 'root:x:0:0:root:/root:/bin/sh\n',
  '/etc/group': 'root:x:0:\n',
  '/root/hello.txt': 'hello from a file inside the sandbox\n',
  '/root/primes.sh': '#!/bin/sh\n# primes below 100, in shell\nn=2\nwhile [ $n -lt 100 ]; do\n  i=2; p=1\n  while [ $((i*i)) -le $n ]; do [ $((n%i)) -eq 0 ] && { p=0; break; }; i=$((i+1)); done\n  [ $p -eq 1 ] && printf "%d " $n\n  n=$((n+1))\ndone\necho\n',
};
const fileEntries = Object.entries(FILES);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>oxwasm shell</title>
<style>
${V('xterm.css')}
  html, body, #term { height: 100%; margin: 0; background: #000; }
</style>
</head>
<body>
<div id="term"></div>
<script>${V('xterm.js')}</script>
<script>${V('addon-fit.js')}</script>
<script type="importmap">${JSON.stringify(importMap)}</script>
<script type="module">
import { startShell } from 'ox/shell';
const BUSYBOX = ${JSON.stringify(gzb64(bbBytes))};
const APPLETS = ${JSON.stringify(applets)};
const FILES = ${JSON.stringify(fileEntries)};
async function inflate(b64) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Uint8Array(await new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
const term = new Terminal({ cursorBlink: true });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));
fit.fit();
const busybox = await inflate(BUSYBOX);
const shell = startShell({
  busybox, applets: APPLETS, files: Object.fromEntries(FILES), cols: term.cols, rows: term.rows,
  onOutput: (bytes) => term.write(bytes),
});
term.reset();
term.onData((d) => shell.input(d));
term.onResize(({ cols, rows }) => shell.resize(cols, rows));
addEventListener('resize', () => fit.fit());
term.focus();
// the guest runs in short slices between event-loop turns, so typing and painting stay live
const slice = new MessageChannel();
let running = true;
slice.port1.onmessage = () => {
  if (!running) return;
  try { running = shell.step(6); } catch (e) { term.write('\\r\\n[engine error: ' + e.message + ']\\r\\n'); running = false; }
  if (running) slice.port2.postMessage(0);
  else term.write('\\r\\n[shell exited with status ' + shell.exitCode + ' - reload to start again]\\r\\n');
};
slice.port2.postMessage(0);
</script>
</body>
</html>
`;
writeFileSync(out, html);
console.log(`shellpage: ${out}  ${(html.length / 1e6).toFixed(2)} MB  (busybox ${(bbBytes.length / 1e3).toFixed(0)} kB, ${applets.length} applets)`);
