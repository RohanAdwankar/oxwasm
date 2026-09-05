// The AOT tier's assembler for node runs: wat text -> wasm bytes via wat2wasm.
//
// Spawning wat2wasm from the engine process is the cold-run tax: fork copies
// the parent's page tables, so a spawn costs 4 ms from a small process and
// 133 ms from one holding a 3 GB guest (measured), and a cold `java -version`
// spent 80% of its 230 s in spawnSync for 960 units. A tiny shell forked
// BEFORE the engine grows does the spawning instead; requests are a path per
// line over one FIFO, answers an exit status per line over another, both
// synchronous from the engine's point of view (a blocking readSync on a FIFO).
import { spawn, execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, openSync, writeSync, readSync, writeFileSync, readFileSync, unlinkSync, existsSync, rmSync, constants as FSC } from 'node:fs';

export function makeAssembler({ debugNames = false, tag = 'oxasm' } = {}) {
  const flags = ['--enable-tail-call', ...(debugNames ? ['--debug-names'] : [])];
  let n = 0;
  const direct = (wat) => {                        // fallback: spawn from here
    const w = `/tmp/${tag}_${process.pid}_${n++}`; writeFileSync(w + '.wat', wat);
    try { execFileSync('wat2wasm', [...flags, w + '.wat', '-o', w + '.wasm']); return new Uint8Array(readFileSync(w + '.wasm')); }
    finally { for (const s of ['.wat', '.wasm']) { try { unlinkSync(w + s); } catch {} } }
  };
  let broker = null;
  try {
    const dir = mkdtempSync(`/tmp/${tag}_`);
    const inF = dir + '/in', outF = dir + '/out';
    execSync(`mkfifo "${inF}" "${outF}"`);
    const sh = spawn('sh', ['-c',
      `while IFS= read -r p; do wat2wasm ${flags.join(' ')} "$p.wat" -o "$p.wasm" 2>"$p.err"; echo $?; done <"${inF}" >"${outF}"`],
      { stdio: ['ignore', 'ignore', 'inherit'] });
    sh.unref();
    // the shell opens `in` for reading first, then `out` for writing; pair them in that order
    // `out` is opened non-blocking so a deferred submit can be pumped without
    // waiting; the synchronous path spins on EAGAIN with 1 ms naps instead
    const inFd = openSync(inF, 'w'), outFd = openSync(outF, FSC.O_RDONLY | FSC.O_NONBLOCK);
    const line = Buffer.alloc(4096);
    broker = { sh, inFd, outFd, dir, line, buf: '', pending: [] };
    process.on('exit', () => { try { sh.kill(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  } catch (e) { broker = null; if (process.env.OXWASM_ASMDEBUG) console.error('<assembler broker unavailable: ' + e.message + '>'); }
  const nap = new Int32Array(new SharedArrayBuffer(4));
  // read whatever status lines are available now (non-blocking); returns the
  // complete lines, keeping a partial one for next time
  const readLines = () => {
    for (;;) {
      let k;
      try { k = readSync(broker.outFd, broker.line, 0, broker.line.length, null); }
      catch (e) { if (e.code === 'EAGAIN') break; throw e; }
      if (k <= 0) { if (k === 0) throw new Error('assembler broker closed'); break; }
      broker.buf += broker.line.toString('utf8', 0, k);
    }
    const parts = broker.buf.split('\n'); broker.buf = parts.pop(); return parts;
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
  const pump = () => {
    if (!broker || !broker.pending.length) return 0;
    let done = 0;
    for (const st of readLines()) {
      const job = broker.pending.shift(); if (!job) break;
      let bytes = null, err = null;
      try { bytes = finish(job.w, st); } catch (e) { err = e; }
      done++; try { job.cb(bytes, err); } catch (e) { if (process.env.OXWASM_ASMDEBUG) console.error('<assembler callback threw: ' + e.message + '>'); }
    }
    return done;
  };
  const viaBroker = (wat) => {
    // a synchronous request behind deferred ones must wait for their answers
    // first, or the status lines would be attributed to the wrong jobs
    while (broker.pending.length) { if (!pump()) Atomics.wait(nap, 0, 0, 1); }
    const w = `${broker.dir}/u${n++}`; writeFileSync(w + '.wat', wat);
    writeSync(broker.inFd, w + '\n');
    let lines;
    for (;;) { lines = readLines(); if (lines.length) break; Atomics.wait(nap, 0, 0, 1); }
    if (lines.length > 1 && process.env.OXWASM_ASMDEBUG) console.error('<assembler: unexpected extra status lines>');
    return finish(w, lines[0]);
  };
  const asm = (wat) => broker ? viaBroker(wat) : direct(wat);
  // submit(wat, cb): hand the text to the broker and return at once; cb(bytes,
  // err) runs from a later pump(). Without a broker the call is synchronous.
  asm.submit = (wat, cb) => {
    if (!broker) { let b = null, e = null; try { b = direct(wat); } catch (x) { e = x; } cb(b, e); return; }
    const w = `${broker.dir}/u${n++}`; writeFileSync(w + '.wat', wat);
    writeSync(broker.inFd, w + '\n'); broker.pending.push({ w, cb });
  };
  asm.pump = pump;
  asm.pendingCount = () => broker ? broker.pending.length : 0;
  return asm;
}
