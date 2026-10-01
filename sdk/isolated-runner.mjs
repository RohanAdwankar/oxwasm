// Runs inside the permission-restricted process (see isolated.mjs): hosts the sandbox's worker thread
// and forwards its messages to and from the parent.
import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';

const WORKER_URL = new URL('./worker.mjs', import.meta.url);
let worker = null;
// the parent is the only thing that gives this process a purpose: if it goes, so do we
process.on('disconnect', () => process.exit(0));

process.on('message', (m) => {
  if (m.t === 'init') {
    worker = new Worker(WORKER_URL, { workerData: m.workerData, resourceLimits: { maxOldGenerationSizeMb: 4096, maxYoungGenerationSizeMb: 128 } });
    worker.on('message', (x) => process.send(x));
    worker.on('error', (e) => process.send({ t: 'fatal', message: `worker error: ${e.message}` }));
    worker.on('exit', () => process.exit(0));
  } else if (m.t === 'selftest') {
    // what this process is, and is not, allowed to do - asked for by the isolation tests
    const tried = {};
    const attempt = async (name, fn) => { try { await fn(); tried[name] = 'allowed'; } catch (e) { tried[name] = e.code || e.name; } };
    (async () => {
      await attempt('read /etc/passwd', () => readFileSync('/etc/passwd'));
      await attempt('read /proc/self/environ', () => readFileSync('/proc/self/environ'));
      await attempt('write /tmp/oxwasm-selftest', async () => (await import('node:fs')).writeFileSync('/tmp/oxwasm-selftest', 'x'));
      await attempt('spawn a process', async () => (await import('node:child_process')).execFileSync('/bin/true'));
      await attempt('read a file under $HOME', () => readFileSync(process.env.HOME + '/.bashrc'));
      process.send({ t: 'selftest-done', tried });
    })();
  } else if (worker) worker.postMessage(m);
});
