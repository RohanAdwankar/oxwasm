// The browser-safe core of the oxwasm shell page: an engine running busybox's
// shell on a pseudo-terminal that the host (the page) owns. Nothing here
// touches node:* APIs; the same file runs in Node (for tests) and in a tab.
import { LinuxEngine } from 'ox/linux';

const enc = new TextEncoder();

/**
 * @param {object} o  busybox: Uint8Array, applets: string[], files: {path: Uint8Array|string},
 *                    cols, rows, onOutput(Uint8Array)
 */
export function startShell(o) {
  const files = { '/bin/busybox': o.busybox };
  for (const [p, v] of Object.entries(o.files || {})) files[p] = typeof v === 'string' ? enc.encode(v) : v;
  const eng = new LinuxEngine(o.busybox, {
    argv: ['sh', '-l'], files, mtimes: {}, memMB: o.memMB || 256, tty: false, ttyRows: o.rows || 24, ttyCols: o.cols || 80,
    env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME=/root', 'USER=root', 'LOGNAME=root',
          'TERM=xterm-256color', 'SHELL=/bin/sh', 'PS1=\\[\\e[1;32m\\]oxwasm\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]# ',
          'LANG=C.UTF-8', 'ENV=/etc/profile', ...(o.env || [])],
  });
  // the applets are links to the one binary; the engine resolves them like a filesystem does
  const m = eng._fsMeta();
  for (const a of o.applets || []) { m.links.set('/bin/' + a, '/bin/busybox'); }
  for (const d of ['/bin', '/sbin', '/usr', '/usr/bin', '/usr/sbin', '/usr/local', '/usr/local/bin', '/root', '/tmp', '/etc', '/var', '/var/tmp', '/home', '/dev', '/proc']) m.dirs.add(d);
  m.v++;

  // the terminal: slave end is stdin/stdout/stderr of the shell, master end is ours
  const pty = eng.newPty();
  const slave = () => eng.ptsHandle(pty);
  eng.fds.set(0, slave()); eng.fds.set(1, slave()); eng.fds.set(2, slave());
  { const r = eng._pgrec(eng.threads[eng.ti]); r.ctty = pty; pty.sid = r.sid; pty.pgrp = r.pgid; }

  const drain = () => {
    const chunks = pty.s2m.chunks;
    if (!chunks.length) return;
    let n = 0; for (const c of chunks) n += c.length - (c === chunks[0] ? pty.s2m.off : 0);
    const out = new Uint8Array(n); let k = 0;
    for (let i = 0; i < chunks.length; i++) { const c = i === 0 ? chunks[0].subarray(pty.s2m.off) : chunks[i]; out.set(c, k); k += c.length; }
    chunks.length = 0; pty.s2m.off = 0; pty.s2m.size = 0;
    o.onOutput(out);
  };

  return {
    eng, pty,
    /** one bounded slice of guest execution; returns true while the guest is runnable */
    step(budgetMs = 8) {
      eng.sliceDeadline = performance.now() + budgetMs;
      eng.run(2e6);
      eng.sliceDeadline = null;
      drain();
      if (eng.exitCode !== null) return false;
      if (eng.blocked) eng.wake();
      return true;
    },
    input(bytes) { eng.ttyInput(pty, typeof bytes === 'string' ? enc.encode(bytes) : bytes); },
    resize(cols, rows) { pty.win = { rows, cols }; eng._signalPgrp?.(pty.pgrp, 28); },
    get exited() { return eng.exitCode !== null; },
    get exitCode() { return eng.exitCode; },
  };
}
