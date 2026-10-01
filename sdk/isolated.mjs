// A sandbox inside a process that Node's permission model has shut down.
//
// The worker-thread sandbox is as strong as the engine's own checks. This wraps the same worker in a
// child process started with --permission, so that a bug in the engine that hands a guest the
// ability to run arbitrary JavaScript in the sandbox's thread still finds, around it, a process that
// cannot read the host's files (beyond a short allow-list), cannot write anywhere but the cache and
// the directories named, and cannot start other processes.
//
// What it does not do: Node's permission model (v22) does not restrict the network or the process's
// own memory and CPU. Those need the operating system (a container, cgroups, a network namespace).
//
// The child speaks to the parent over an IPC channel; ProcessWorker presents it with the small slice
// of the Worker interface the SDK uses.
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, realpathSync, statSync, mkdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RUNNER = resolve(HERE, 'isolated-runner.mjs');

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/**
 * The paths the isolated process may read and write, from the sandbox's options, as --allow-fs-*
 * values. Node 22 grants a directory's contents only with a trailing /*; a bare path grants that
 * path alone (for writes) - so directories get the wildcard and files stay exact.
 */
export function permissionsFor(opts, cacheDir) {
  const read = new Set(), write = new Set();
  const grant = (set, p) => {
    const r = real(p);
    let isDir = false; try { isDir = statSync(r).isDirectory(); } catch { return; }
    set.add(isDir ? r.replace(/\/+$/, '') + '/*' : r);
  };
  try { mkdirSync(cacheDir, { recursive: true }); } catch {}
  grant(read, ROOT);                                     // the SDK, the engine, node_modules/wabt
  grant(read, cacheDir); grant(write, cacheDir);
  if (opts.rootfs) grant(read, opts.rootfs);
  for (const p of opts.packages ?? []) grant(read, p);
  if (opts.restore) grant(read, opts.restore);
  const ca = opts.network && typeof opts.network === 'object' ? opts.network.caBundle : null;
  if (ca) grant(read, ca);
  if (opts.network) grant(read, '/etc/resolv.conf');
  for (const p of opts.allowWrite ?? []) { try { mkdirSync(p, { recursive: true }); } catch {} grant(write, p); grant(read, p); }
  return { read: [...read], write: [...write] };
}

export class ProcessWorker extends EventEmitter {
  constructor(workerData, opts, cacheDir) {
    super();
    if (!opts.rootfs) throw new Error("isolation: 'process' needs a rootfs image: the host-borrowed Python image is assembled by running host tools (ldd), which this process is not allowed to do");
    const perm = permissionsFor(opts, cacheDir);
    const args = ['--permission', '--allow-worker',
      ...perm.read.map((p) => `--allow-fs-read=${p}`), ...perm.write.map((p) => `--allow-fs-write=${p}`),
      '--max-old-space-size=4096'];
    this.child = fork(RUNNER, [], { execArgv: args, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    this.child.on('message', (m) => this.emit('message', m));
    this.child.on('error', (e) => this.emit('error', e));
    this.child.on('exit', (code) => this.emit('exit', code ?? 1));
    this.child.send({ t: 'init', workerData });
  }
  postMessage(m) { if (this.child.connected) this.child.send(m); }
  terminate() { try { this.child.kill('SIGKILL'); } catch {} return Promise.resolve(0); }
  unref() { this.child.unref?.(); }
}
