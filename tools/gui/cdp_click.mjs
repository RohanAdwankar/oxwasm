// Drive the GIMP snapshot page in headless Chromium over CDP: wait for
// restore, click the File menu on the canvas, screenshot the result.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const page = process.argv[2], out = process.argv[3];
const clickX = +process.argv[4], clickY = +process.argv[5];
const chrome = spawn('/opt/pw-browsers/chromium', ['--headless', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=9333', '--window-size=1100,900', 'about:blank'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2500));
const list = await (await fetch('http://127.0.0.1:9333/json')).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') console.log('PAGE EXC:', JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  if (m.method === 'Runtime.consoleAPICalled') console.log('PAGE ERR:', JSON.stringify(m.params.args).slice(0, 300));
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } };
const cmd = (method, params = {}) => new Promise(res => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await cmd('Page.enable');
await cmd('Runtime.enable');
await cmd('Page.navigate', { url: 'file://' + page });
const status = async () => (await cmd('Runtime.evaluate', { expression: 'document.getElementById("stat")?.textContent ?? ""' })).result.value;
// wait for restore + engine running
for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 1000));
  const s = await status(); if (i % 10 === 0) console.log('stat:', s);
  if (/interp [\d,]+/.test(s)) break; }
await new Promise(r => setTimeout(r, 5000));
// canvas position — placeholder; measured fresh right before the click
let px = 0, py = 0;
const measure = async () => {
  const box = (await cmd('Runtime.evaluate', { expression: 'JSON.stringify(document.getElementById("screen").getBoundingClientRect())' })).result.value;
  const r = JSON.parse(box);
  const sx = r.width / 1024;
  px = r.x + clickX * sx; py = r.y + clickY * sx;
};
await measure();
// wait for the ready gate, then use NATIVE CDP mouse events (the real-user path)
for (let i = 0; i < 60; i++) { const rd = (await cmd('Runtime.evaluate', { expression: 'window.__oxReady === true' })).result.value;
  if (rd) break; await new Promise(r2 => setTimeout(r2, 1000)); }
await cmd('Runtime.evaluate', { expression: `window.PP=0; document.getElementById('screen').addEventListener('pointerdown', () => window.PP++); 'probe-set'` });
await measure();
await cmd('Runtime.evaluate', { expression: `
  const _im = window.__ox.xs.injectMotion.bind(window.__ox.xs);
  window.__ox.xs.injectMotion = (x, y) => { console.log('[dbg2] motion', x, y); return _im(x, y); };
  const _ib = window.__ox.xs.injectButton.bind(window.__ox.xs);
  window.__ox.xs.injectButton = (b, d) => { console.log('[dbg2] btn', b, d, 'ptr', window.__ox.xs.ptr.x, window.__ox.xs.ptr.y); return _ib(b, d); };
  'wrapped'` });
console.log('ready; native click at page coords', px.toFixed(0), py.toFixed(0));
await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, pointerType: 'mouse' });
await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
if (!process.env.PRESSONLY)
  await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
await new Promise(r2 => setTimeout(r2, 3000));
{ const early = await cmd('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out.replace('.png', '_early.png'), Buffer.from(early.data, 'base64')); }
await new Promise(r2 => setTimeout(r2, 9000));
console.log('stat:', await status());
console.log('xdiag:', (await cmd('Runtime.evaluate', { expression: `window.__ox.xs.diag().join(' | ')` })).result.value);
console.log('probe hits:', (await cmd('Runtime.evaluate', { expression: 'window.PP' })).result.value,
  'elemAt:', (await cmd('Runtime.evaluate', { expression: `document.elementFromPoint(${px},${py})?.id ?? 'none'` })).result.value);
const shot = await cmd('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out);
chrome.kill();
process.exit(0);
