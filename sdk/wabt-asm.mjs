// The AOT tier's assembler without a child process: wabt compiled to WebAssembly, in this thread.
//
// The wat2wasm broker (tools/assemble.mjs) needs a binary on PATH and the right to spawn processes.
// This needs neither, which is what lets a sandbox run in a process that is not allowed to start
// others, and it assembles as fast as the native tool does once the spawn is counted
// (about 40 ms for a 540 kB module either way).
//
// wabt parses recursively on a fixed 64 kB emscripten stack, so past some s-expression depth the
// parse overflows - and the overflow traps the instance, after which every later parse fails too.
// The depth that does it is a property of the wabt build, so it is probed once on a throwaway
// instance and deeper modules are refused. A refused unit is one function that stays interpreted;
// a dead assembler would have been all of them.
const SEED_DEPTH = 149;      // what the wabt builds seen so far allow; confirmed on both sides below

export const watDepth = (s) => {
  let d = 0, m = 0, q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') q = false; continue; }
    if (c === '"') q = true; else if (c === '(') { if (++d > m) m = d; } else if (c === ')') d--;
  }
  return m;
};

export async function makeInProcessAssembler() {
  const { default: WabtModule } = await import('wabt');
  let probe = await WabtModule();
  const fits = async (d) => {
    try { const m = probe.parseWat('p.wat', '(module (func $f ' + '(block '.repeat(d) + 'nop' + ') '.repeat(d) + '))', { tail_call: true }); m.destroy(); return true; }
    catch { probe = await WabtModule(); return false; }
  };
  let maxDepth;
  if (await fits(SEED_DEPTH) && !(await fits(SEED_DEPTH + 1))) maxDepth = SEED_DEPTH;
  else { let lo = 0, hi = 1024; while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (await fits(mid)) lo = mid; else hi = mid; } maxDepth = lo; }
  let wabt = await WabtModule();

  const assemble = (wat) => {
    if (watDepth(wat) > maxDepth) throw new Error(`wat nesting deeper than this assembler can parse (${maxDepth})`);
    let m;
    try {
      m = wabt.parseWat('unit.wat', wat, { tail_call: true });
      return new Uint8Array(m.toBinary({ write_debug_names: !!process.env.OXWASM_DEBUGNAMES }).buffer);   // OXWASM_DEBUGNAMES=1: function names for the CPU profile
    } catch (e) {
      // a trap leaves the instance dead: replace it before the next unit
      wabt = null;
      throw e;
    } finally { try { m?.destroy(); } catch {} }
  };
  const asm = (wat) => {
    if (!wabt) throw new Error('assembler instance lost; reinitialising');
    return assemble(wat);
  };
  // wabt must be re-created asynchronously after a trap; do it lazily on the next pump
  let reviving = null;
  const revive = () => { if (!wabt && !reviving) reviving = WabtModule().then((w) => { wabt = w; reviving = null; }); };
  const queue = [];
  asm.submit = (wat, cb) => { queue.push({ wat, cb }); };
  // run what is queued, for at most ~4 ms: the guest shares this thread
  asm.pump = () => {
    revive();
    let done = 0; const t0 = performance.now();
    while (queue.length && wabt && performance.now() - t0 < 4) {
      const { wat, cb } = queue.shift();
      let bytes = null, err = null;
      try { bytes = asm(wat); } catch (e) { err = e; }
      done++; try { cb(bytes, err); } catch {}
    }
    return done;
  };
  asm.pendingCount = () => queue.length;
  asm.close = () => {};
  asm.inProcess = true;
  asm.maxDepth = maxDepth;
  return asm;
}

/**
 * Hand units too deeply nested for wabt to a native wat2wasm, when the process can start one.
 * wabt parses on a fixed 64 kB stack, so the deepest functions (long br_table ladders) are the
 * ones it refuses, and those are often the hottest dispatch loops. `makeFallback` is called at
 * most once, on the first such unit; if it throws, those units stay refused as before.
 */
export function withNativeFallback(asm, makeFallback) {
  let fb = null, tried = false;
  const submit = asm.submit, pump = asm.pump, pending = asm.pendingCount;
  asm.submit = (wat, cb) => {
    if (watDepth(wat) > asm.maxDepth) {
      if (!tried) { tried = true; try { fb = makeFallback(); } catch { fb = null; } }
      if (fb) { fb.submit(wat, cb); return; }
    }
    submit(wat, cb);
  };
  asm.pump = () => pump() + (fb ? fb.pump() : 0);
  asm.pendingCount = () => pending() + (fb ? fb.pendingCount() : 0);
  const close = asm.close;
  asm.close = () => { close(); try { fb?.close?.(); } catch {} };
  return asm;
}
