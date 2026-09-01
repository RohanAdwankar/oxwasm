// Drive the tier probe: cold visit, then a reload in the same profile (the
// implicit-code-cache case), reporting per-call times for both.
import { spawn } from 'node:child_process';
const PORT = 9395, HTTP = 8399;
const profile = `/tmp/tierprof_${process.pid}`;
const chrome = spawn('/opt/pw-browsers/chromium', ['--headless','--disable-gpu','--no-sandbox',
  `--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'--disk-cache-size=1073741824','about:blank'],{stdio:'ignore'});
await new Promise(r=>setTimeout(r,2500));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise(r=>ws.onopen=r);
let id=0; const waiting=new Map();
ws.onmessage=(ev)=>{const m=JSON.parse(ev.data); if(m.id&&waiting.has(m.id)){waiting.get(m.id)(m.result);waiting.delete(m.id);}};
const cmd=(m2,p={})=>new Promise(res=>{const i=++id;waiting.set(i,res);ws.send(JSON.stringify({id:i,method:m2,params:p}))});
await cmd('Page.enable'); await cmd('Runtime.enable');
const q=async(e)=>(await cmd('Runtime.evaluate',{expression:e,returnByValue:true})).result.value;
const visit = async (tag) => {
  await cmd('Page.navigate',{url:`http://127.0.0.1:${HTTP}/index.html`});
  for (let i=0;i<200;i++){ await new Promise(r=>setTimeout(r,250));
    if (await q('!!window.__result')) break; }
  console.log(`${tag}: ${JSON.stringify(await q('window.__result'))}`);
};
await visit('cold  ');
await visit('reload');
chrome.kill(); process.exit(0);
