// Does moving the assembler into a worker actually take work off the main
// thread? The per-unit tier probe cannot answer that: every page load
// compiles a DIFFERENT set of units (10, 15, 19, 39 across four runs), so
// comparing the worst unit in one arm against the worst in another compares
// unit sets, not assemblers - and two paired runs disagreed on the sign.
//
// This removes that variance by assembling the SAME text both ways in the
// same page. It reports main-thread blocking, which is the quantity that
// matters: for the sync path that is the whole parse, for the worker it is
// the postMessage.
//   node cdp_asmbench.mjs URL [reps=5]
import { spawn } from 'node:child_process';
import { chromePath } from './../chrome.mjs';

const url = process.argv[2], REPS = +(process.argv[3] || 5);
const PORT = 9385;
const chrome = spawn(chromePath(), ['--headless','--disable-gpu','--no-sandbox',
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
const q=async(e)=>(await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result.value;
for (let i=0;i<600;i++){ await new Promise(r=>setTimeout(r,200));
  if (await q('window.__oxReady===true')) break; }
for (let i=0;i<150;i++){ await new Promise(r=>setTimeout(r,200));
  if (await q('window.__ox && window.__ox.eng && window.__ox.eng.cacheOnly === false')) break; }
console.log('worker available:', await q('!!window.__ox.eng.assembleWatAsync'));

// Collect real unit texts as the engine emits them, by driving a menu.
await q(`(() => { window.__wats = [];
  window.__ox.eng.onUnitWat = (n, e, u) => { if (window.__wats.length < 40) window.__wats.push(u.wat); };
  return 1; })()`);
const _rect = JSON.parse(await q('JSON.stringify(document.getElementById("screen").getBoundingClientRect())'));
const _sx = _rect.width / 1024;
const click = async (gx, gy) => { const x=_rect.x+gx*_sx, y=_rect.y+gy*_sx;
  await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
  await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1}); };
await click(424,383); await new Promise(r=>setTimeout(r,1200));
await click(452,422); await new Promise(r=>setTimeout(r,2500));
await click(587,526); await new Promise(r=>setTimeout(r,4000));
const n = await q('window.__wats.length');
console.log(`captured ${n} unit texts`);
if (!n) { console.log('nothing to measure'); chrome.kill(); process.exit(1); }

// Assemble the same texts both ways, alternating, and report main-thread
// blocking per text. Sizes are reported so a slow one is attributable.
const out = await q(`(async () => {
  const eng = window.__ox.eng;
  const wats = window.__wats.slice().sort((a,b)=>b.length-a.length).slice(0, 8);
  const rows = [];
  for (const wat of wats) {
    let sync = [], asyncB = [];
    for (let r = 0; r < ${REPS}; r++) {
      // interleaved, so drift in machine load hits both arms equally
      let t = performance.now();
      try { eng.assembleWat(wat); } catch (e) {}
      sync.push(performance.now() - t);
      if (eng.assembleWatAsync) {
        t = performance.now();
        const p = eng.assembleWatAsync(wat);
        asyncB.push(performance.now() - t);       // main-thread blocking only
        try { await p; } catch (e) {}
      }
    }
    const med = (a) => a.slice().sort((x,y)=>x-y)[a.length >> 1];
    rows.push({ len: wat.length, sync: med(sync), worker: asyncB.length ? med(asyncB) : null });
  }
  return JSON.stringify(rows);
})()`);
const rows = JSON.parse(out);
console.log('\n  WAT bytes   main-thread block: sync (parse)   worker (postMessage)   ratio');
let ts=0, tw=0;
for (const r of rows) {
  ts += r.sync; if (r.worker !== null) tw += r.worker;
  // a worker handoff can land under the clock's resolution; printing
  // sync/~0 as a ratio would invent a number the measurement cannot support
  const ratio = r.worker !== null && r.worker >= 0.05 ? `${(r.sync/r.worker).toFixed(0)}x` : '(below timer res)';
  console.log(`  ${String(r.len).padStart(9)}   ${r.sync.toFixed(1).padStart(21)}ms   ` +
              (r.worker === null ? '            n/a' : `${r.worker.toFixed(2).padStart(18)}ms   ${ratio}`));
}
console.log(`\n  totals: sync ${ts.toFixed(1)}ms vs worker ${tw.toFixed(2)}ms of main-thread blocking` +
            (tw > 0 ? ` (${(ts/tw).toFixed(0)}x less)` : ''));
chrome.kill(); process.exit(0);
