// Sustained interaction latency: N menu open/close cycles, each timed
// end-to-end (native click -> the menu's pixels actually on the canvas),
// so 1st vs Nth interaction latency is a measured number.
//   node cdp_lat.mjs URL [cycles=8]
// Reports per-cycle open/close ms plus the page's own __oxLat aggregates
// (per-event input->paint latency, worst engine pump slice).
import { spawn } from 'node:child_process';

const [url, cyclesS = '8'] = process.argv.slice(2);
const N = +cyclesS;
const PORT = 9355;
const chrome = spawn('/opt/pw-browsers/chromium', ['--headless','--disable-gpu','--no-sandbox',
  `--remote-debugging-port=${PORT}`,'--window-size=1100,900','about:blank'],{stdio:'ignore'});
await new Promise(r=>setTimeout(r,2500));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise(r=>ws.onopen=r);
let id=0; const waiting=new Map();
ws.onmessage=(ev)=>{const m=JSON.parse(ev.data); if(m.id&&waiting.has(m.id)){waiting.get(m.id)(m.result);waiting.delete(m.id);}};
const cmd=(m2,p={})=>new Promise(res=>{const i=++id;waiting.set(i,res);ws.send(JSON.stringify({id:i,method:m2,params:p}))});
await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Page.navigate',{url});
for (let i=0;i<600;i++){ await new Promise(r=>setTimeout(r,200));
  if ((await cmd('Runtime.evaluate',{expression:'window.__oxReady===true'})).result.value) break; }
for (let i=0;i<150;i++){ await new Promise(r=>setTimeout(r,200));
  if ((await cmd('Runtime.evaluate',{expression:'window.__oxPerf&&window.__oxPerf.unitsApplied!==undefined'})).result.value) break; }
await new Promise(r=>setTimeout(r,3000));
const q=async(e)=>(await cmd('Runtime.evaluate',{expression:e,returnByValue:true})).result.value;
const guest=async(gx,gy)=>{ const r=JSON.parse(await q('JSON.stringify(document.getElementById("screen").getBoundingClientRect())'));
  const sx=r.width/1024; return [r.x+gx*sx, r.y+gy*sx]; };
const click=async(gx,gy)=>{ const [x,y]=await guest(gx,gy);
  await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
  await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1}); };
const key=async(code,vk)=>{ await cmd('Input.dispatchKeyEvent',{type:'keyDown',code,key:'x',windowsVirtualKeyCode:vk});
  await cmd('Input.dispatchKeyEvent',{type:'keyUp',code,key:'x',windowsVirtualKeyCode:vk}); };
// probe pixel inside the File menu's dropdown area (guest 470,470): menu
// background is near-white; the empty-window backdrop behind it is not
const probe = "(() => { const d = document.getElementById('screen').getContext('2d').getImageData(470,470,1,1).data; return d[0]+','+d[1]+','+d[2]; })()";
const pixel = () => q(probe);
const until = async (pred, timeoutMs) => {
  const s = Date.now();
  for (;;) { if (pred(await pixel())) return Date.now() - s;
    if (Date.now() - s > timeoutMs) return -1;
    await new Promise(r=>setTimeout(r,16)); }
};
const bg = await pixel();
console.log('baseline pixel:', bg);
const rows = [];
for (let c = 1; c <= N; c++) {
  await click(424,383);
  const open = await until(p => p !== bg, 30000);
  await new Promise(r=>setTimeout(r,300));
  await key('Escape',27);
  const close = await until(p => p === bg, 30000);
  rows.push([c, open, close]);
  console.log(`cycle ${c}: open ${open}ms · close ${close}ms`);
  await new Promise(r=>setTimeout(r,500));
}
console.log('lat:', await q('JSON.stringify(window.__oxLat)'));
console.log('stat:', await q("document.getElementById('stat').textContent"));
chrome.kill(); process.exit(0);
