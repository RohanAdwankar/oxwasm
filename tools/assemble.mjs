// The AOT tier's assembler for node runs: wat text -> wasm bytes via wat2wasm.
//
// Spawning wat2wasm from the engine process is the cold-run tax: fork copies
// the parent's page tables, so a spawn costs 4 ms from a small process and
// 133 ms from one holding a 3 GB guest (measured), and a cold `java -version`
// spent 80% of its 230 s in spawnSync for 960 units. A tiny shell forked
// BEFORE the engine grows does the spawning instead; requests are a path per
// line over one FIFO, answers an exit status per line over another, both
// synchronous from the engine's point of view (a blocking readSync on a FIFO).
import { threadId } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, openSync, writeSync, readSync, writeFileSync, readFileSync, unlinkSync, existsSync, rmSync, constants as FSC } from 'node:fs';

// A host with no wat2wasm on PATH does not break anything visibly: every unit
// the translator emits comes back "wat2wasm failed (127): not found", the
// engine treats that as one more refused translation and blacklists the entry,
// and the run finishes CORRECTLY on the interpreter. A whole breadth sweep can
// go green that way with the AOT tier dead - the only tell is aot=0 on every
// case. So prove the assembler works before the first unit is ever emitted:
// build a one-instruction module with the same flags the run will use, which
// catches a missing binary and a wabt too old for --enable-tail-call alike.
// Worker threads share a pid, and every sandbox builds its own assembler: names keyed on the pid alone collide.
const UID = () => `${process.pid}_${threadId}_${randomBytes(4).toString('hex')}`;

function preflight(flags, tag) {
  const w = `/tmp/${tag}_pre_${UID()}`;
  try {
    writeFileSync(w + '.wat', '(module (func (export "f") (result i32) (i32.const 1)))');
    execFileSync('wat2wasm', [...flags, w + '.wat', '-o', w + '.wasm'], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (!readFileSync(w + '.wasm').length) throw new Error('wat2wasm produced no output');
  } catch (e) {
    const why = e.code === 'ENOENT' ? 'wat2wasm is not on PATH (install wabt)'
              : `wat2wasm ${flags.join(' ')} failed: ${String(e.stderr || e.message).slice(0, 200)}`;
    throw new Error(`the AOT tier cannot assemble: ${why}. Without it every unit is refused and the guest runs interpreted - correct, and many times slower.`);
  } finally { for (const s of ['.wat', '.wasm']) { try { unlinkSync(w + s); } catch {} } }
}

export function makeAssembler({ debugNames = false, tag = 'oxasm', workers = +(process.env.OXWASM_ASM_WORKERS || 1) } = {}) {
  const flags = ['--enable-tail-call', ...(debugNames ? ['--debug-names'] : [])];
  let n = 0;
  const uid = UID();
  preflight(flags, tag);
  // workers > 1: extra broker shells, each with its own fifo pair and queue;
  // deferred submissions go to the least loaded one, so several wat2wasm run
  // at once while the guest continues. The synchronous path uses shell 0.
  const extra = [];
  const direct = (wat) => {                        // fallback: spawn from here
    const w = `/tmp/${tag}_${uid}_${n++}`; writeFileSync(w + '.wat', wat);
    try { execFileSync('wat2wasm', [...flags, w + '.wat', '-o', w + '.wasm']); return new Uint8Array(readFileSync(w + '.wasm')); }
    finally { for (const s of ['.wat', '.wasm']) { try { unlinkSync(w + s); } catch {} } }
  };
  let broker = null, syncB = null;
  // one pre-forked shell per queue: a fifo pair, a status-line buffer and the
  // deferred jobs waiting on it. The shell opens `in` for reading first, then
  // `out` for writing; pair them in that order. `out` is opened non-blocking
  // so a deferred submit can be pumped without waiting; the synchronous path
  // spins on EAGAIN with 1 ms naps instead.
  const mkShell = (suffix) => {
    const dir = mkdtempSync(`/tmp/${tag}${suffix}_`), inF = dir + '/in', outF = dir + '/out';
    execSync(`mkfifo "${inF}" "${outF}"`);
    const sh = spawn('sh', ['-c',
      `while IFS= read -r p; do wat2wasm ${flags.join(' ')} "$p.wat" -o "$p.wasm" 2>"$p.err"; echo $?; done <"${inF}" >"${outF}"`],
      { stdio: ['ignore', 'ignore', 'inherit'] });
    sh.unref();
    const b = { sh, inFd: openSync(inF, 'w'), outFd: openSync(outF, FSC.O_RDONLY | FSC.O_NONBLOCK), dir, line: Buffer.alloc(4096), buf: '', pending: [] };
    process.on('exit', () => { try { sh.kill(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return b;
  };
  try {
    broker = mkShell('');
    // Synchronous requests (PLT stubs, a few lines each) get their own shell:
    // behind the deferred queue they waited for every closure unit ahead of
    // them to assemble first - 1.3 s of a 40 s clang -S, for stubs that
    // assemble in a millisecond.
    syncB = mkShell('s');
    for (let w = 1; w < workers; w++) extra.push(mkShell('w' + w));
  } catch (e) { broker = null; if (process.env.OXWASM_ASMDEBUG) console.error('<assembler broker unavailable: ' + e.message + '>'); }
  const nap = new Int32Array(new SharedArrayBuffer(4));
  // read whatever status lines are available now (non-blocking); returns the
  // complete lines, keeping a partial one for next time
  const readLines = (b = broker) => {
    for (;;) {
      let k;
      try { k = readSync(b.outFd, b.line, 0, b.line.length, null); }
      catch (e) { if (e.code === 'EAGAIN') break; throw e; }
      if (k <= 0) { if (k === 0) throw new Error('assembler broker closed'); break; }
      b.buf += b.line.toString('utf8', 0, k);
    }
    const parts = b.buf.split('\n'); b.buf = parts.pop(); return parts;
  };
  const finish = (w, status) => {                  // status line -> bytes, or throws with wat2wasm's message
    try {
      if (status.trim() !== '0') { const err = existsSync(w + '.err') ? readFileSync(w + '.err', 'utf8') : ''; throw new Error('wat2wasm failed (' + status.trim() + '): ' + err.slice(0, 400)); }
      return new Uint8Array(readFileSync(w + '.wasm'));
    } finally { for (const s of ['.wat', '.wasm', '.err']) { try { unlinkSync(w + s); } catch {} } }
  };
  // Deferred jobs answered so far: the shell answers in request order, so
  // each status line belongs to the oldest pending job. Returns how many
  // callbacks ran.
  const pumpOne = (b) => {
    if (!b.pending.length) return 0;
    let done = 0;
    for (const st of readLines(b)) {
      const job = b.pending.shift(); if (!job) break;
      let bytes = null, err = null;
      try { bytes = finish(job.w, st); } catch (e) { err = e; }
      done++; try { job.cb(bytes, err); } catch (e) { if (process.env.OXWASM_ASMDEBUG) console.error('<assembler callback threw: ' + e.message + '>'); }
    }
    return done;
  };
  const pump = () => { if (!broker) return 0; let d = pumpOne(broker); for (const b of extra) d += pumpOne(b); return d; };
  const viaBroker = (wat) => {
    const w = `${syncB.dir}/u${n++}`; writeFileSync(w + '.wat', wat);
    writeSync(syncB.inFd, w + '\n');
    let lines;
    for (;;) { lines = readLines(syncB); if (lines.length) break; Atomics.wait(nap, 0, 0, 1); }
    if (lines.length > 1 && process.env.OXWASM_ASMDEBUG) console.error('<assembler: unexpected extra status lines>');
    return finish(w, lines[0]);
  };
  const asm = (wat) => broker ? viaBroker(wat) : direct(wat);
  // submit(wat, cb): hand the text to the broker and return at once; cb(bytes,
  // err) runs from a later pump(). Without a broker the call is synchronous.
  asm.submit = (wat, cb) => {
    if (!broker) { let b = null, e = null; try { b = direct(wat); } catch (x) { e = x; } cb(b, e); return; }
    let b = broker; for (const x of extra) if (x.pending.length < b.pending.length) b = x;   // least loaded shell
    const w = `${b.dir}/u${n++}`; writeFileSync(w + '.wat', wat);
    writeSync(b.inFd, w + '\n'); b.pending.push({ w, cb });
  };
  asm.pump = pump;
  asm.pendingCount = () => broker ? broker.pending.length + extra.reduce((a, b) => a + b.pending.length, 0) : 0;
  return asm;
}
