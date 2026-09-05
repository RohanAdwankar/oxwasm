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
import { mkdtempSync, openSync, writeSync, readSync, writeFileSync, readFileSync, unlinkSync, existsSync, rmSync } from 'node:fs';

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
    const inFd = openSync(inF, 'w'), outFd = openSync(outF, 'r');
    const line = Buffer.alloc(16);
    broker = { sh, inFd, outFd, dir, line };
    process.on('exit', () => { try { sh.kill(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  } catch (e) { broker = null; if (process.env.OXWASM_ASMDEBUG) console.error('<assembler broker unavailable: ' + e.message + '>'); }
  const viaBroker = (wat) => {
    const w = `${broker.dir}/u${n++}`; writeFileSync(w + '.wat', wat);
    try {
      writeSync(broker.inFd, w + '\n');
      let got = '';                                // one status line back
      while (!got.includes('\n')) { const k = readSync(broker.outFd, broker.line, 0, broker.line.length, null); if (k <= 0) throw new Error('assembler broker closed'); got += broker.line.toString('utf8', 0, k); }
      if (got.trim() !== '0') { const err = existsSync(w + '.err') ? readFileSync(w + '.err', 'utf8') : ''; throw new Error('wat2wasm failed (' + got.trim() + '): ' + err.slice(0, 400)); }
      return new Uint8Array(readFileSync(w + '.wasm'));
    } finally { for (const s of ['.wat', '.wasm', '.err']) { try { unlinkSync(w + s); } catch {} } }
  };
  return (wat) => broker ? viaBroker(wat) : direct(wat);
}
