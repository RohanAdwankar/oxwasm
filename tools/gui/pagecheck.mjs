// Browser-side regression check for a packed sidecar page: serve DIR, open it
// in headless Chromium, click File > New > OK, draw strokes, pass iff ink
// appeared. The File-menu loss of 855590d was invisible to the node sweep
// (a `process` reference that only a browser lacks); this is the check that
// would have caught it.
//   node tools/gui/pagecheck.mjs [demo/gimp] [strokes=2] [steps=12]
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const [dir = 'demo/gimp', strokes = '2', steps = '12'] = process.argv.slice(2);
const port = 8300 + Math.floor(Math.random() * 500);
const serve = spawn(process.execPath, [join(here, 'serve.mjs'), dir, String(port)], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));
const t0 = Date.now();
const draw = spawn(process.execPath, [join(here, 'cdp_draw.mjs'), `http://127.0.0.1:${port}/index.html`, strokes, steps], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; draw.stdout.on('data', d => out += d); draw.stderr.on('data', d => out += d);
const timer = setTimeout(() => { draw.kill('SIGKILL'); }, 600000);
const code = await new Promise(r => draw.on('exit', r)); clearTimeout(timer); serve.kill();
const ok = code === 0 && /STROKES DREW/.test(out);
const med = (out.match(/SUMMARY warm stroke: input->paint med ([0-9.]+)ms/) || [])[1];
console.log(`${ok ? 'ok  ' : 'FAIL'} page ${dir}: ${ok ? 'File > New > OK, strokes drew' + (med ? `, ${med} ms median input->paint` : '') : (out.trim().split('\n').pop() || 'no output').slice(0, 120)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
process.exit(ok ? 0 : 1);
