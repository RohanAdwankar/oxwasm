// One sandbox = one worker thread running one EngineHost.
//
// The thread is the safety boundary the in-process claim rests on. A guest that
// spins in compiled code never returns from a slice, so no amount of
// cooperation inside the engine can stop it; the parent can, by terminating
// this thread. The guest's memory dies with the thread and nothing else is
// affected.
import { parentPort, workerData } from 'node:worker_threads';
import { EngineHost } from './host.mjs';

let host = null;
let outstanding = 0;          // requests sent to the guest and not yet closed by a done/error frame
let pumping = false;
const background = new Set(); // pids of background commands: they only run while the guest is stepped

const post = (m) => parentPort.postMessage(m);
const sleep = (ms) => new Promise((r) => (ms > 0 ? setTimeout(r, ms) : setImmediate(r)));

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (host && (outstanding > 0 || background.size > 0)) {
      const r = host.step();
      if (r.exit !== undefined) {
        post({ t: 'fatal', message: `the guest exited (${r.exit}): ${host._stderr()}` });
        host = null; return;
      }
      if (r.blocked) { await sleep(r.waitMs); host?.eng?.wake(); }
      else await sleep(0);
    }
  } catch (e) {
    let where = '';
    if (process.env.OXWASM_DEBUG_MAPS) where = '\n' + (host?.eng?.maps ?? []).map((m) => `${m.at.toString(16)}+${m.len.toString(16)} ${m.path}`).join('\n');
    post({ t: 'fatal', message: `engine error: ${e.message}${where}` });
    host = null;
  } finally { pumping = false; }
}

function onFrame(f) {
  if (f.ev === 'done' || f.ev === 'error') {
    outstanding = Math.max(0, outstanding - 1);
    const pid = f.value && f.value.pid;
    if (pid) background.add(pid);
  }
  post({ t: 'frame', frame: f });
}

parentPort.on('message', (m) => {
  if (!host) return;
  if (m.t === 'req') {
    outstanding++;
    if (m.body.op === 'cmd_poll' && m.body.pid) m._poll = m.body.pid;
    host.send(m.body);
    pump();
  } else if (m.t === 'note') {                // parent noticed a background process end
    background.delete(m.pid);
  } else if (m.t === 'sigint') {
    host.sigint(); outstanding++; pump();     // keep stepping so the signal is delivered even if idle
    setTimeout(() => { outstanding = Math.max(0, outstanding - 1); }, 2000).unref();
  } else if (m.t === 'close') {
    host.close(); host = null; process.exit(0);
  }
});

try {
  host = await EngineHost.boot({ ...workerData, log: (s) => post({ t: 'log', message: s }) });
  host.onFrame = onFrame;
  post({ t: 'ready', info: host.bootInfo });
} catch (e) {
  post({ t: 'fatal', message: e.message });
}
