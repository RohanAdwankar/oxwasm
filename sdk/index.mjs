// oxwasm's sandbox SDK.
//
//   const s = await Sandbox.create()
//   await s.run('x = 10')            // python, with state
//   await s.sh('ls /')               // a shell
//
// The code runs on an unmodified CPython inside a worker thread of YOUR
// process, not on someone else's machine. Where a feature is not built, the
// call throws `NotSupportedError` saying so; nothing is a silent no-op.
import { Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { Execution, Result, OutputMessage, ExecutionError } from './messaging.mjs';
import {
  SandboxError, TimeoutError, InvalidArgumentError, NotEnoughSpaceError, NotFoundError,
  FileNotFoundError, SandboxNotFoundError, AuthenticationError, CommandExitError,
} from './errors.mjs';

export { Execution, Result, OutputMessage, ExecutionError };
export { SandboxError, TimeoutError, InvalidArgumentError, NotEnoughSpaceError, NotFoundError,
         FileNotFoundError, SandboxNotFoundError, AuthenticationError, CommandExitError };

export class NotSupportedError extends SandboxError {
  constructor(what) { super(`${what} is not supported by oxwasm sandboxes yet`); this.name = 'NotSupportedError'; }
}
export const FileType = { FILE: 'file', DIR: 'dir', SYMLINK: 'symlink' };

const WORKER_URL = new URL('./worker.mjs', import.meta.url);
const DEFAULT_LIFETIME_MS = 300_000;     // default sandbox lifetime
const DEFAULT_REQUEST_MS = 60_000;       // default for runCode and commands.run
const SIGINT_GRACE_MS = 5_000;           // how long a cell gets to unwind after SIGINT before the sandbox is abandoned

const REGISTRY = new Map();              // sandboxId -> Sandbox, for connect() and list()

const mapGuestError = (f) => {
  const m = f.message || 'error';
  switch (f.type) {
    case 'FileNotFound': return new FileNotFoundError(m);
    case 'NotFound': return new NotFoundError(m);
    case 'NotEnoughSpace': return new NotEnoughSpaceError(m);
    case 'InvalidArgument': return new InvalidArgumentError(m);
    default: return new SandboxError(`${f.type}: ${m}`);
  }
};

const b64 = (data) => {
  if (typeof data === 'string') return Buffer.from(data, 'utf8').toString('base64');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('base64');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
  throw new InvalidArgumentError('data must be a string, ArrayBuffer, typed array, Blob or ReadableStream');
};
const toBytes = async (data) => {
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (typeof ReadableStream !== 'undefined' && data instanceof ReadableStream)
    return new Uint8Array(await new Response(data).arrayBuffer());
  return data;
};

const entryOf = (e) => ({ ...e, modifiedTime: e.modifiedTime != null ? new Date(e.modifiedTime) : undefined });

class Filesystem {
  constructor(sbx) { this._s = sbx; }

  async read(path, opts = {}) {
    const f = await this._s._call({ op: 'fs_read', path }, { timeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_MS });
    const buf = Buffer.from(f.value, 'base64');
    switch (opts.format || 'text') {
      case 'bytes': return new Uint8Array(buf);
      case 'blob': return new Blob([buf]);
      case 'stream': return new Blob([buf]).stream();
      default: return buf.toString('utf8');
    }
  }

  async write(pathOrFiles, dataOrOpts, maybeOpts) {
    if (Array.isArray(pathOrFiles)) {
      const out = [];
      for (const e of pathOrFiles) out.push(await this.write(e.path, e.data, dataOrOpts));
      return out;
    }
    const bytes = await toBytes(dataOrOpts);
    const f = await this._s._call({ op: 'fs_write', path: pathOrFiles, data: b64(bytes) },
                                  { timeoutMs: maybeOpts?.requestTimeoutMs ?? DEFAULT_REQUEST_MS });
    const { name, type, path } = f.value;
    return { name, type, path };
  }
  writeFiles(files, opts) { return this.write(files, opts); }

  async list(path, opts = {}) {
    const f = await this._s._call({ op: 'fs_list', path, depth: opts.depth }, { timeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_MS });
    return f.value.map(entryOf);
  }
  async makeDir(path, opts) { return (await this._s._call({ op: 'fs_mkdir', path }, { timeoutMs: opts?.requestTimeoutMs ?? DEFAULT_REQUEST_MS })).value; }
  async rename(oldPath, newPath, opts) {
    return entryOf((await this._s._call({ op: 'fs_rename', old: oldPath, new: newPath }, { timeoutMs: opts?.requestTimeoutMs ?? DEFAULT_REQUEST_MS })).value);
  }
  async remove(path, opts) { await this._s._call({ op: 'fs_remove', path }, { timeoutMs: opts?.requestTimeoutMs ?? DEFAULT_REQUEST_MS }); }
  async exists(path, opts) { return (await this._s._call({ op: 'fs_exists', path }, { timeoutMs: opts?.requestTimeoutMs ?? DEFAULT_REQUEST_MS })).value; }
  async getInfo(path, opts) { return entryOf((await this._s._call({ op: 'fs_info', path }, { timeoutMs: opts?.requestTimeoutMs ?? DEFAULT_REQUEST_MS })).value); }
  async watchDir() { throw new NotSupportedError('files.watchDir'); }
}

class CommandHandle {
  constructor(sbx, pid, opts) {
    this._s = sbx; this.pid = pid; this._o = opts;
    this._stdout = ''; this._stderr = ''; this._exit = undefined; this._err = undefined;
    this._done = this._poll();
    this._done.catch(() => {});
  }
  get stdout() { return this._stdout; }
  get stderr() { return this._stderr; }
  get exitCode() { return this._exit; }
  get error() { return this._err; }

  async _poll() {
    for (;;) {
      let exit;
      try {
        const f = await this._s._call({ op: 'cmd_poll', pid: this.pid }, {
          timeoutMs: 30_000,
          onEvent: (e) => {
            if (e.ev === 'stdout') { this._stdout += e.line; this._o.onStdout?.(e.line); }
            else if (e.ev === 'stderr') { this._stderr += e.line; this._o.onStderr?.(e.line); }
          },
        });
        exit = f.exitCode;
      } catch (e) { if (e instanceof SandboxNotFoundError) return; throw e; }
      if (exit !== null && exit !== undefined) { this._exit = exit; this._s._noteEnded(this.pid); return; }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async wait() {
    await this._done;
    const result = { exitCode: this._exit ?? -1, error: this._err, stdout: this._stdout, stderr: this._stderr };
    if (result.exitCode !== 0) throw new CommandExitError(result);
    return result;
  }
  async kill() { return this._s.commands.kill(this.pid); }
  async disconnect() {}
  async sendStdin(data) { return this._s.commands.sendStdin(this.pid, data); }
  async closeStdin() { throw new NotSupportedError('closeStdin'); }
}

class Commands {
  constructor(sbx) { this._s = sbx; this._handles = new Map(); }

  async run(cmd, opts = {}) {
    const body = { op: 'cmd', cmd, cwd: opts.cwd, envs: opts.envs, background: !!opts.background, stdin: !!opts.stdin };
    if (opts.background) {
      const f = await this._s._call(body, { timeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_MS });
      const h = new CommandHandle(this._s, f.value.pid, opts);
      this._handles.set(f.value.pid, h);
      return h;
    }
    let stdout = '', stderr = '';
    const f = await this._s._call(body, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_REQUEST_MS,
      onEvent: (e) => {
        if (e.ev === 'stdout') { stdout += e.line; opts.onStdout?.(e.line); }
        else if (e.ev === 'stderr') { stderr += e.line; opts.onStderr?.(e.line); }
      },
    });
    const result = { exitCode: f.exitCode, error: undefined, stdout, stderr };
    if (result.exitCode !== 0) throw new CommandExitError(result);
    return result;
  }
  async list() { return (await this._s._call({ op: 'cmd_list' })).value; }
  async kill(pid) {
    const ok = (await this._s._call({ op: 'cmd_kill', pid })).value;
    if (ok) this._s._noteEnded(pid);
    return ok;
  }
  async sendStdin(pid, data) {
    await this._s._call({ op: 'cmd_stdin', pid, data: b64(data) });
  }
  async closeStdin() { throw new NotSupportedError('commands.closeStdin'); }
  async connect(pid) {
    const h = this._handles.get(pid);
    if (!h) throw new SandboxError(`process ${pid} was not started by this sandbox handle`);
    return h;
  }
  get supportsStdinClose() { return false; }
}

export class Sandbox {
  /** @param {string|object} [templateOrOpts]  A template name may come first; it is accepted and ignored. */
  static async create(templateOrOpts, maybeOpts) {
    const opts = (typeof templateOrOpts === 'string' ? maybeOpts : templateOrOpts) || {};
    return Sandbox._start(opts);
  }

  static async _start(opts) {
    const worker = new Worker(WORKER_URL, {
      workerData: { python: opts.python, packages: opts.packages, memMB: opts.memMB, cache: opts.cache,
                    commands: opts.commands, bootTimeoutMs: opts.bootTimeoutMs },
      resourceLimits: { maxOldGenerationSizeMb: 4096, maxYoungGenerationSizeMb: 128 },
    });
    const sbx = new Sandbox(worker, opts);
    try { await sbx._booted; }
    catch (e) { try { await worker.terminate(); } catch {} throw e; }
    REGISTRY.set(sbx.sandboxId, sbx);
    if (opts.envs && Object.keys(opts.envs).length) await sbx._call({ op: 'env', envs: opts.envs });
    return sbx;
  }

  constructor(worker, opts = {}) {
    this._w = worker; this._opts = opts;
    this.sandboxId = 'ox' + randomBytes(9).toString('hex');
    this.sandboxDomain = 'localhost';
    this.metadata = opts.metadata || {};
    this.files = new Filesystem(this);
    this.commands = new Commands(this);
    this._id = 0; this._pending = new Map(); this._chain = Promise.resolve();
    this._dead = false; this._deadReason = null; this._lifetimeTimer = null;
    this.startedAt = new Date();
    this.boot = null;                                   // { restored, totalMs, ... } once up

    this._booted = new Promise((resolve, reject) => {
      worker.on('message', (m) => {
        if (m.t === 'ready') { this.boot = m.info; resolve(); }
        else if (m.t === 'fatal') { const e = new SandboxError(m.message); if (!this.boot) reject(e); this._destroy(m.message); }
        else if (m.t === 'frame') this._onFrame(m.frame);
      });
      worker.on('error', (e) => { if (!this.boot) reject(e); this._destroy(`worker error: ${e.message}`); });
      worker.on('exit', () => { if (!this.boot) reject(new SandboxError('worker exited during boot')); this._destroy('worker exited'); });
    });
    this._booted.then(() => this.setTimeout(opts.timeoutMs ?? DEFAULT_LIFETIME_MS)).catch(() => {});
  }

  // ---- lifecycle --------------------------------------------------------------
  static async connect(sandboxId) {
    const s = REGISTRY.get(sandboxId);
    if (!s || s._dead) throw new SandboxNotFoundError(`sandbox ${sandboxId} not found (oxwasm sandboxes live in this process)`);
    return s;
  }
  async connect() { return this; }
  static list() {
    const infos = [...REGISTRY.values()].filter((s) => !s._dead).map((s) => s.getInfoSync());
    let given = false;
    return { hasNext: true, nextItems: async () => { given = true; return infos; }, get done() { return given; } };
  }
  static async kill(sandboxId) {
    const s = REGISTRY.get(sandboxId);
    if (!s || s._dead) return false;
    return s.kill();
  }
  getInfoSync() {
    return { sandboxId: this.sandboxId, templateId: 'oxwasm-python', name: 'oxwasm', metadata: this.metadata,
             startedAt: this.startedAt, endAt: this._endAt, state: this._dead ? 'paused' : 'running' };
  }
  async getInfo() { return this.getInfoSync(); }
  async isRunning() { return !this._dead; }

  async setTimeout(timeoutMs) {
    clearTimeout(this._lifetimeTimer);
    this._endAt = new Date(Date.now() + timeoutMs);
    this._lifetimeTimer = setTimeout(() => this._destroy('sandbox timeout reached'), timeoutMs);
    this._lifetimeTimer.unref?.();
  }

  async kill() {
    if (this._dead) return false;
    try { this._w.postMessage({ t: 'close' }); } catch {}
    await this._destroy('killed');
    return true;
  }

  _destroy(reason) {
    if (this._dead) return Promise.resolve();
    this._dead = true; this._deadReason = reason;
    clearTimeout(this._lifetimeTimer);
    REGISTRY.delete(this.sandboxId);
    const err = reason === 'killed' || reason === 'worker exited' || reason === 'sandbox timeout reached'
      ? new SandboxNotFoundError(`sandbox ${this.sandboxId} is not running (${reason})`)
      : new SandboxError(reason);
    for (const [, p] of this._pending) p.reject(p.timedOut ? new TimeoutError(`request timed out (${reason})`) : err);
    this._pending.clear();
    return this._w.terminate().catch(() => {});
  }

  _noteEnded(pid) { try { this._w.postMessage({ t: 'note', pid }); } catch {} }

  // ---- request plumbing ---------------------------------------------------------
  /**
   * One request at a time per sandbox: the guest is a single process reading a
   * single stream, so two overlapping calls would interleave their frames.
   */
  _call(body, { onEvent, timeoutMs } = {}) {
    const job = () => new Promise((resolve, reject) => {
      if (this._dead) return reject(new SandboxNotFoundError(`sandbox ${this.sandboxId} is not running (${this._deadReason})`));
      const id = ++this._id;
      const entry = { onEvent, timedOut: false, timer: null, kill: null };
      const end = (fn) => (v) => { clearTimeout(entry.timer); clearTimeout(entry.kill); this._pending.delete(id); fn(v); };
      entry.resolve = end(resolve); entry.reject = end(reject);
      this._pending.set(id, entry);
      if (timeoutMs) entry.timer = setTimeout(() => {
        entry.timedOut = true;
        // Soft first: a real SIGINT reaches a real process, CPython raises
        // KeyboardInterrupt, and the sandbox survives with its state.
        try { this._w.postMessage({ t: 'sigint' }); } catch {}
        // A guest spinning in compiled code without a syscall cannot take it.
        // The thread is abandoned; the sandbox is gone, the host is fine.
        entry.kill = setTimeout(() => this._destroy('the request did not answer SIGINT'), SIGINT_GRACE_MS);
      }, timeoutMs);
      this._w.postMessage({ t: 'req', body: { ...body, id } });
    });
    const p = this._chain.then(job, job);
    this._chain = p.catch(() => {});
    return p;
  }

  _onFrame(f) {
    const e = this._pending.get(f.id);
    if (!e) return;
    if (f.ev === 'stdout' || f.ev === 'stderr' || f.ev === 'result') { e.onEvent?.(f); return; }
    if (e.timedOut) return e.reject(new TimeoutError(
      'The request timed out: it ran longer than timeoutMs. The sandbox was interrupted and is still usable.'));
    if (f.ev === 'error') return e.reject(mapGuestError(f));
    e.resolve(f);
  }

  // ---- the short form ---------------------------------------------------------------
  // The fuller methods below give control over results and streaming. These two are the
  // ones the docs lead with: one call to run python, one call to run a shell
  // command, and neither makes you unpack a result object to get the answer.

  /** Run python. Returns what the cell printed plus its last expression, as a string. Throws on a python error. */
  async run(code, opts = {}) {
    const ex = await this.runCode(code, opts);
    if (ex.error) {
      const e = new SandboxError(ex.error.value);
      e.name = ex.error.name; e.traceback = ex.error.traceback; e.execution = ex;
      throw e;
    }
    const out = ex.logs.stdout.join('') + ex.logs.stderr.join('');
    return out + (ex.text !== undefined ? ex.text + '\n' : '');
  }

  /** Run a shell command. Never throws on a nonzero exit: returns { stdout, stderr, exitCode }. */
  async sh(cmd, opts = {}) {
    try { return await this.commands.run(cmd, opts); }
    catch (e) {
      if (e instanceof CommandExitError) return { stdout: e.stdout, stderr: e.stderr, exitCode: e.exitCode };
      throw e;
    }
  }

  async close() { return this.kill(); }

  // ---- code interpreter ------------------------------------------------------------
  async runCode(code, opts = {}) {
    const results = [], logs = { stdout: [], stderr: [] };
    const exec = new Execution(results, logs);
    const f = await this._call({ op: 'run', code, ctx: opts.context?.id, language: opts.language, envs: opts.envs }, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_REQUEST_MS,
      onEvent: async (e) => {
        if (e.ev === 'result') {
          const r = new Result(e.data, !!e.main); results.push(r); await opts.onResult?.(r);
        } else {
          const msg = new OutputMessage(e.line, Math.round((e.ts || Date.now() / 1000) * 1000), e.ev === 'stderr');
          (e.ev === 'stdout' ? logs.stdout : logs.stderr).push(e.line);
          await (e.ev === 'stdout' ? opts.onStdout : opts.onStderr)?.(msg);
        }
      },
    });
    exec.executionCount = f.executionCount;
    if (f.error) { exec.error = new ExecutionError(f.error.name, f.error.value, f.error.traceback); await opts.onError?.(exec.error); }
    return exec;
  }

  async createCodeContext(opts = {}) {
    return (await this._call({ op: 'ctx_create', cwd: opts.cwd, language: opts.language })).value;
  }
  async removeCodeContext(context) { await this._call({ op: 'ctx_remove', ctx: context.id ?? context }); }
  async listCodeContexts() { return (await this._call({ op: 'ctx_list' })).value; }
  async restartCodeContext(context) { await this._call({ op: 'ctx_restart', ctx: context.id ?? context }); }

  // ---- not built --------------------------------------------------------------------
  get pty() { throw new NotSupportedError('pty'); }
  get git() { throw new NotSupportedError('git'); }
  getHost() { throw new NotSupportedError('getHost (oxwasm sandboxes have no network)'); }
  async pause() { throw new NotSupportedError('pause'); }
  async betaPause() { throw new NotSupportedError('betaPause'); }
  async createSnapshot() { throw new NotSupportedError('createSnapshot'); }
  async fork() { throw new NotSupportedError('fork'); }
  async getMetrics() { throw new NotSupportedError('getMetrics'); }
  async uploadUrl() { throw new NotSupportedError('uploadUrl'); }
  async downloadUrl() { throw new NotSupportedError('downloadUrl'); }

  async [Symbol.asyncDispose]() { await this.kill(); }
}

export default Sandbox;
