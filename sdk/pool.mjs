// Running many short tasks, each in its own clean sandbox, with a ceiling on how many run at once.
//
//   const pool = new SandboxPool({ size: 4, sandbox: { network: true } })
//   const out = await pool.run((s) => s.sh('uname -a'))      // a fresh sandbox per task
//   await pool.close()
//
// A task gets a sandbox no earlier task has touched. The pool keeps that cheap by building one
// pristine sandbox, snapshotting it, and restoring each new one from the snapshot (about a second
// and a half) instead of booting from scratch. If a sandbox dies mid-task for a reason that is
// not the task's fault (killed, timed out at the sandbox level), the task is retried on a new one.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox, SandboxNotFoundError, SandboxError } from './index.mjs';

export class SandboxPool {
  /**
   * @param {object} o  size: most sandboxes alive at once (default 4)
   *                    sandbox: options for Sandbox.create (rootfs, network, memMB, ...)
   *                    retries: extra attempts when a sandbox is lost under a task (default 1)
   *                    prepare(sandbox): run once on the pristine sandbox before it is snapshotted
   */
  constructor(o = {}) {
    this.size = o.size ?? 4; this.sandboxOpts = o.sandbox ?? {}; this.retries = o.retries ?? 1; this.prepare = o.prepare;
    this._active = 0; this._waiters = []; this._base = null; this._closed = false;
    this.stats = { started: 0, completed: 0, failed: 0, retried: 0, created: 0 };
  }

  async _ensureBase() {
    if (this._base) return this._base;
    return (this._base = (async () => {
      const dir = join(mkdtempSync(join(tmpdir(), 'oxpool-')), 'base');
      const s = await Sandbox.create(this.sandboxOpts);
      try { if (this.prepare) await this.prepare(s); await s.snapshot(dir); } finally { await s.kill().catch(() => {}); }
      return dir;
    })());
  }

  async _slot() {
    if (this._closed) throw new SandboxError('the pool is closed');
    if (this._active < this.size) { this._active++; return; }
    await new Promise((res) => this._waiters.push(res));
    if (this._closed) throw new SandboxError('the pool is closed');
  }
  _free() { const w = this._waiters.shift(); if (w) w(); else this._active--; }

  /** A fresh sandbox, restored from the pool's pristine snapshot. Pair with release(). */
  async acquire() {
    await this._slot();
    try {
      const dir = await this._ensureBase();
      this.stats.created++;
      return await Sandbox.create({ ...this.sandboxOpts, restore: dir });
    } catch (e) { this._free(); throw e; }
  }
  async release(sandbox) { try { await sandbox.kill(); } finally { this._free(); } }

  /** Run `fn(sandbox)` in a fresh sandbox and return its result. */
  async run(fn) {
    this.stats.started++;
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const s = await this.acquire();
      try {
        const r = await fn(s);
        this.stats.completed++;
        return r;
      } catch (e) {
        lastErr = e;
        const lost = e instanceof SandboxNotFoundError || !(await s.isRunning().catch(() => false));
        if (!lost || attempt === this.retries) { this.stats.failed++; throw e; }
        this.stats.retried++;
      } finally { await this.release(s); }
    }
    throw lastErr;
  }

  metrics() { return { ...this.stats, active: this._active, waiting: this._waiters.length, size: this.size }; }

  async close() {
    this._closed = true;
    for (const w of this._waiters.splice(0)) w();
    if (this._base) { try { const dir = await this._base; rmSync(join(dir, '..'), { recursive: true, force: true }); } catch {} }
  }
}
