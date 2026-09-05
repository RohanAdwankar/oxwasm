// Where does a stroke's input->paint latency LIVE? cdp_draw's number spans
// event arrival to rAF blit, but its wait/work buckets are vestigial (the
// page stopped filling them), so the ~32ms was unattributed. With ?latprof
// the page records {in, inject} when the pump picks a motion up and
// {in, blit} when the rAF paints it; aligning the two splits the total into
//   input->inject   time the event sat before a pump slice took it
//   inject->blit    guest processing across slices + rAF alignment
//   node cdp_latprof.mjs URL(with ?latprof) [steps=24]
import { spawn } from 'node:child_process';

const [url, stepsS = '24'] = process.argv.slice(2);
const STEPS = +stepsS;
const PORT = 9377;
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

const rect = JSON.parse(await q('JSON.stringify(document.getElementById("screen").getBoundingClientRect())'));
const sx = rect.width / 1024;
const g = (gx, gy) => [rect.x + gx * sx, rect.y + gy * sx];
const wins = JSON.parse(await q(`(() => { const xs = window.__oxXs;
  return JSON.stringify(xs.root.children.filter(c=>c.mapped).map(c=>({x:c.x,y:c.y,w:c.w,h:c.h}))); })()`));
const main = wins.filter(w => w.w >= 400 && w.h >= 150).sort((a,b)=>b.w*b.h-a.w*a.h)[0];
if (!main) { console.log('no main window'); chrome.kill(); process.exit(1); }
if (!(await q('Array.isArray(window.__oxLat.trace)'))) { console.log('page lacks ?latprof'); chrome.kill(); process.exit(1); }

// need an image open or strokes damage nothing: File > New > OK, verified
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));
const winsQ = async () => JSON.parse(await q(`(() => { const xs = window.__oxXs;
  return JSON.stringify(xs.root.children.filter(c=>c.mapped).map(c=>({x:c.x,y:c.y,w:c.w,h:c.h,n:(xs.wmName&&xs.wmName(c))||""}))); })()`));
const click = async (gx, gy) => { const [x, yy] = g(gx, gy);
  await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x,y:yy});
  await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x,y:yy,button:'left',buttons:1,clickCount:1});
  await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x,y:yy,button:'left',buttons:0,clickCount:1}); };
const clickUntil = async (what, doClick, pred, settleMs) => {
  for (let t = 0; t < 3; t++) { await doClick(); await sleep(settleMs);
    const w = (await winsQ()).find(pred); if (w) return w; await sleep(1500); }
  console.log(`${what} never appeared`); chrome.kill(); process.exit(1); };
const menu = await clickUntil('File menu', () => click(main.x + 20, main.y + 13),
  w => w.h > 250 && w.h < 500 && w.w < 320 && w.x >= main.x && w.x < main.x + main.w, 1200);
const dlg = await clickUntil('New Image dialog', () => click(menu.x + 45, menu.y + 27),
  w => /New Image/.test(w.n), 2500);
await click(dlg.x + 328, dlg.y + 238); await sleep(4000);
const wins2 = await winsQ();
const img = wins2.filter(w => w.w >= 400 && w.h >= 150).sort((a,b)=>b.w*b.h-a.w*a.h)[0];

await q('window.__oxLat.trace = []');
const y = img.y + 90;
main.x = img.x;   // stroke origin below reuses main.x
let [x0, y0] = g(main.x + 80, y);
const mouse = (type, x, yy, extra={}) => cmd('Input.dispatchMouseEvent', { type, x, y: yy, ...extra });
await mouse('mouseMoved', x0, y0);
await mouse('mousePressed', x0, y0, { button: 'left', buttons: 1, clickCount: 1 });
for (let i = 1; i <= STEPS; i++) { const [x, yy] = g(main.x + 80 + i * 8, y);
  await mouse('mouseMoved', x, yy, { button: 'left', buttons: 1 });
  await new Promise(r => setTimeout(r, 30)); }
const [xe, ye] = g(main.x + 80 + (STEPS+1) * 8, y);
await mouse('mouseReleased', xe, ye, { button: 'left', buttons: 0, clickCount: 1 });
await new Promise(r => setTimeout(r, 600));

const trace = JSON.parse(await q('JSON.stringify(window.__oxLat.trace)'));
console.log('trace entries:', trace.length,
  'injects', trace.filter(e=>e.inject!==undefined).length,
  'blits', trace.filter(e=>e.blit!==undefined).length);
const injects = new Map(), blits = new Map();
for (const e of trace) { if (e.inject !== undefined) injects.set(e.in, e.inject); if (e.blit !== undefined) blits.set(e.in, e.blit); }
const rows = [...blits.keys()].sort((a,b)=>a-b).map(t => ({
  toInject: injects.has(t) ? +(injects.get(t) - t).toFixed(1) : null,
  injectToBlit: injects.has(t) ? +(blits.get(t) - injects.get(t)).toFixed(1) : null,
  total: +(blits.get(t) - t).toFixed(1) }));
const med = (a) => { const v = a.filter(x=>x!=null).sort((x,y)=>x-y); return v[v.length>>1]; };
console.log(`samples ${rows.length} | input->inject med ${med(rows.map(r=>r.toInject))}ms | inject->blit med ${med(rows.map(r=>r.injectToBlit))}ms | total med ${med(rows.map(r=>r.total))}ms`);
console.log(rows.slice(2, 14).map(r=>`${r.toInject}+${r.injectToBlit}=${r.total}`).join('  '));
chrome.kill();
process.exit(0);
