import { spawn } from 'node:child_process';
import { chromePath } from './../chrome.mjs';
const chrome = spawn(chromePath(), ['--headless','--disable-gpu','--no-sandbox','--remote-debugging-port=9335','--window-size=1100,900','about:blank'],{stdio:'ignore'});
await new Promise(r=>setTimeout(r,2500));
const list = await (await fetch('http://127.0.0.1:9335/json')).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise(r=>ws.onopen=r);
let id=0; const waiting=new Map();
ws.onmessage=(ev)=>{const m=JSON.parse(ev.data); if(m.id&&waiting.has(m.id)){waiting.get(m.id)(m.result);waiting.delete(m.id);}};
const cmd=(m2,p={})=>new Promise(res=>{const i=++id;waiting.set(i,res);ws.send(JSON.stringify({id:i,method:m2,params:p}))});
await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Page.navigate',{url:'file://'+process.argv[2]});
for (let i=0;i<90;i++){ await new Promise(r=>setTimeout(r,1000));
  const rd=(await cmd('Runtime.evaluate',{expression:'window.__oxReady===true'})).result.value; if(rd) break; }
// let it run a while to trigger tier-ups
await new Promise(r=>setTimeout(r,20000));
const q = async (e) => (await cmd('Runtime.evaluate',{expression:e,returnByValue:true})).result.value;
console.log('tiers:', JSON.stringify(await q('window.__ox.eng.stats.tiers')));
console.log('aotFailed:', await q('window.__ox.eng.aotFailed?.size'));
console.log('aotFns:', await q('window.__ox.eng.aotFns?.size'));
console.log('hook onAotFail...');
await q(`window.__fails=[]; window.__ox.eng.onAotFail=(e,m)=>window.__fails.push(m.slice(0,200)); 'ok'`);
await new Promise(r=>setTimeout(r,15000));
console.log('recent fails:', JSON.stringify(await q('window.__fails.slice(0,5)')));
console.log('direct assembleWat-ish test:', await q(`(async () => { try {
  const wabt = await WabtModule();
  const m = wabt.parseWat('t.wat', '(module (func (export "f") (result i32) (i32.const 7)))');
  const b = m.toBinary({}).buffer; m.destroy(); return 'wabt ok ' + b.length;
} catch (e) { return 'wabt FAIL ' + e.message; } })()`));
for (const ent of ['0x81ef690n'])
  console.log('tierUp', ent, ':', await q(`(() => { try { const e = window.__ox.eng; e.aotFailed.delete(${ent}); e.tierUpAot(${ent});
    return 'aotFns=' + e.aotFns.size + ' failed=' + e.aotFailed.size + ' lastFail=' + JSON.stringify(window.__fails.slice(-1)); }
    catch (err) { return 'THREW: ' + err.message; } })()`));
console.log('wrap probe:', await q(`(() => { const e = window.__ox.eng;
  const orig = e.assembleWat;
  e.assembleWat = (wat) => { window.__watLen = wat.length;
    try { return orig(wat); } catch (err) { window.__lastStack = (err.stack||err.message||'').slice(0,500); throw err; } };
  e.aotFailed.delete(0x81ef690n);
  e.tierUpAot(0x81ef690n);
  e.assembleWat = orig;
  return 'watLen=' + window.__watLen + ' stack=' + (window.__lastStack ?? 'none') + ' fns=' + e.aotFns.size; })()`));
console.log('interp:', await q('window.__ox.eng.stats.interpreted'));
chrome.kill(); process.exit(0);
