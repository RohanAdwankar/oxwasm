// Run a GUI binary from a sysroot on the M3 engine (pure interp), screenshot at IDLE.
//   node guishot.mjs SYSROOT /usr/bin/gimp-2.8 out.ppm [WxH] [maxChunks]
import { LinuxEngine } from '../../engine/linux.mjs';
import { XServer } from '../../engine/xserver.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
let asmN = 0;
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync as mkdirSync0 } from 'node:fs';
const WATCACHE = new URL('./watcache/', import.meta.url).pathname;
try { mkdirSync0(WATCACHE, { recursive: true }); } catch {}
let watHits = 0, watMisses = 0;
const usedHashes = new Set();
const assembleWat = (wat) => {
  const h = createHash('sha1').update(wat).digest('hex');
  usedHashes.add(h);
  const cp = WATCACHE + h + '.wasm';
  if (existsSync(cp)) { watHits++; return new Uint8Array(readFileSync(cp)); }
  watMisses++;
  const w = `/tmp/gs_${process.pid}_${asmN++}`;
  writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', [w + '.wat', '-o', w + '.wasm']);
  const bytes = new Uint8Array(readFileSync(w + '.wasm'));
  try { unlinkSync(w + '.wat'); unlinkSync(w + '.wasm'); } catch {}
  try { writeFileSync(cp, bytes); } catch {}
  return bytes;
};
const [sysroot, binPath, outPpm = 'gui.ppm', size = '1024x768', maxChunks = '600'] = process.argv.slice(2);
const [W, H] = size.split('x').map(Number);
// Lazy sysroot: index every path up front (mtimes for cache validation, host
// paths for content), but read file bytes only on first access via a Proxy.
const hostPath = {}, mtimes = {}, fileCache = {};
(function walk(dir, guest) {
  let dm = 0; try { dm = Math.floor(lstatSync(dir).mtimeMs/1000); } catch {}
  if (guest) mtimes[guest] = dm;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), g = guest + '/' + name;
    let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) { try { const real = realpathSync(p); const rst = lstatSync(real);
        if (rst.isFile()) { hostPath[g] = real; mtimes[g]=Math.floor(rst.mtimeMs/1000); }
        else if (rst.isDirectory()) walk(real, g); } catch {} }
    else if (st.isDirectory()) walk(p, g);
    else if (st.isFile()) { hostPath[g] = p; mtimes[g]=Math.floor(st.mtimeMs/1000); }
  }
})(sysroot, '');
const files = new Proxy(fileCache, {
  get(t, k) {
    if (typeof k !== 'string' || k in t) return t[k];
    const hp = hostPath[k]; if (hp === undefined) return undefined;
    try { return t[k] = new Uint8Array(readFileSync(hp)); } catch { return undefined; }
  },
  has(t, k) { return k in t || k in hostPath; },
  ownKeys(t) { return [...new Set([...Object.keys(hostPath), ...Object.keys(t)])]; },
  getOwnPropertyDescriptor(t, k) {
    if (k in t) return Object.getOwnPropertyDescriptor(t, k);
    if (k in hostPath) return { enumerable: true, configurable: true, writable: true, value: undefined };
    return undefined;
  },
});
files['/lib64/ld-linux-x86-64.so.2'] = files['/lib/x86_64-linux-gnu/ld-2.27.so'];
const xs = new XServer({ width: W, height: H });
const extraArgs = process.argv.slice(7);
const eng = new LinuxEngine(files[binPath], { argv:[binPath, ...extraArgs],
  env:['DISPLAY=:0','HOME=/root','USER=root','LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu'],
  files, mtimes, memMB: +(process.env.MEMMB || 1024), xserver: xs,
  ...(process.env.CALLTH ? { aotCallThreshold: +process.env.CALLTH } : {}),
  ...(process.env.LOOPTH ? { aotLoopThreshold: +process.env.LOOPTH } : {}),
  ...(process.env.NOJIT ? {} : { assembleWat }) });
if (process.env.PANGO_ONLY !== undefined && !process.env.NOJIT) {
  const want = new Set(process.env.PANGO_ONLY.split(',').map(Number));
  let pn = 0;
  eng.unitFilter = (idx, entry) => {
    for (const m of eng.maps ?? []) if (entry >= m.at && entry < m.at + m.len) {
      if (m.path.includes('pango')) return want.has(pn++);
      return true;
    }
    return true;
  };
}
else if (process.env.PANGO_MAX !== undefined && !process.env.NOJIT) {
  // compile everything except pango-region units beyond ordinal PANGO_MAX;
  // log each pango unit's ordinal, global index and entry for the final pinning
  const cap = +process.env.PANGO_MAX;
  let pn = 0;
  eng.unitFilter = (idx, entry) => {
    for (const m of eng.maps ?? []) if (entry >= m.at && entry < m.at + m.len) {
      if (m.path.includes('pango')) {
        const take = pn < cap;
        console.error(`<pangounit ord=${pn} idx=${idx} entry=0x${entry.toString(16)} ${m.path.split('/').pop()}+0x${(entry - m.at + BigInt(m.fileOff)).toString(16)} ${take ? 'COMPILE' : 'skip'}>`);
        pn++;
        return take;
      }
      return true;
    }
    return true;
  };
}
else if (process.env.EXCLUDE_LIBS && !process.env.NOJIT) {
  // skip compiling units whose entry lies in the named modules (comma list of substrings)
  const pats = process.env.EXCLUDE_LIBS.split(',');
  eng.unitFilter = (idx, entry) => {
    for (const m of eng.maps ?? []) if (entry >= m.at && entry < m.at + m.len)
      return !pats.some(pat => m.path.includes(pat));
    return true;
  };
}
if (process.env.UNIT_RANGES && !process.env.NOJIT) {
  const rs = process.env.UNIT_RANGES.split(',').map(r => r.split('-').map(Number));
  let n = 0;
  eng.unitFilter = (idx, entry) => {
    const take = rs.some(([lo, hi]) => idx >= lo && idx < hi);
    if (process.env.UNIT_LOG) console.error(`unit#${idx} entry=0x${entry.toString(16)} ${take ? '' : 'SKIP'}`);
    return take;
  };
}
// trap the first GLib-ERROR stderr write and dump a symbolized stack walk
{
  const osys = eng.syscall.bind(eng);
  let dumped = false;
  const sym = (v) => { for (const m of eng.maps ?? []) if (v >= m.at && v < m.at + m.len)
    return `${m.path.split('/').pop()}+0x${(v - m.at + BigInt(m.fileOff)).toString(16)}`; return null; };
  eng.syscall = (cpu) => {
    const nr0 = Number(cpu.regs[0]);
    if ((nr0 === 231 || nr0 === 60) && Number(cpu.regs[7]) === 127 && !dumped) {
      dumped = true;
      console.error('=== EXIT-TRAP: exit(127) at rip=0x' + cpu.rip.toString(16), '(' + (sym(cpu.rip) ?? '?') + ')');
      const rsp = cpu.regs[4];
      let found = 0;
      for (let i = 0n; i < 8192n && found < 50; i += 8n) {
        try { const v = eng.mem.read(rsp + i, 8n); const w = sym(v);
          if (w) { console.error(`  [rsp+0x${i.toString(16)}] ${w}`); found++; } } catch { break; }
      }
    }
    if (!dumped && (nr0 === 1 || nr0 === 20)) {
      try {
        let txt = '';
        if (nr0 === 1) {
          const ptr = cpu.regs[6], len = Number(cpu.regs[2]);
          for (let i = 0n; i < BigInt(Math.min(len, 200)); i++) txt += String.fromCharCode(Number(eng.mem.read(ptr + i, 1n)));
        } else {
          const iov = cpu.regs[6], cnt = Math.min(Number(cpu.regs[2]), 8);
          for (let v = 0; v < cnt && txt.length < 300; v++) {
            const base = eng.mem.read(iov + BigInt(v*16), 8n), len = Number(eng.mem.read(iov + BigInt(v*16+8), 8n));
            for (let i = 0n; i < BigInt(Math.min(len, 200)); i++) txt += String.fromCharCode(Number(eng.mem.read(base + i, 1n)));
          }
        }
        if (txt.includes('GLib-ERROR') || txt.includes('g_thread') || txt.includes('failed to allocate')) {
          dumped = true;
          console.error('=== ABORT-TRAP: stderr write:', JSON.stringify(txt.slice(0, 180)));
          console.error('rip=0x' + cpu.rip.toString(16), '(' + (sym(cpu.rip) ?? '?') + ')');
          const rsp = cpu.regs[4];
          let found = 0;
          for (let i = 0n; i < 4096n && found < 40; i += 8n) {
            try { const v = eng.mem.read(rsp + i, 8n); const w = sym(v);
              if (w && !w.startsWith('ld-')) { console.error(`  [rsp+0x${i.toString(16)}] ${w}`); found++; } } catch { break; }
          }
        }
      } catch {}
    }
    const rip0 = cpu.rip, nrx = Number(cpu.regs[0]);
    osys(cpu);
    (globalThis.__sysring ||= []).push([nrx, rip0, BigInt.asIntN(64, cpu.regs[0])]);
    if (globalThis.__sysring.length > 200) globalThis.__sysring.shift();
  };
}
const failCount = new Map();
eng.onAotFail = (entry, msg) => {
  let where = '?';
  for (const m of eng.maps ?? []) if (entry >= m.at && entry < m.at + m.len) where = `${m.path.split('/').pop()}+0x${(entry-m.at+BigInt(m.fileOff)).toString(16)}`;
  const key = msg.slice(0, 90);
  failCount.set(key, (failCount.get(key) || 0) + 1);
  if ((failCount.get(key) || 0) <= 3) console.error(`<aotfail ${where}> ${key}`);
};
setInterval(() => {}, 1 << 30).unref();
const hbT0 = Date.now(); let hbLast = 0;
eng.onProgress = (src) => {
  if (Date.now() - hbLast < 10000) return; hbLast = Date.now();
  const rip = eng.cpu.rip; let where = '?';
  for (const m of eng.maps ?? []) if (rip >= m.at && rip < m.at + m.len) where = `${m.path.split('/').pop()}+0x${(rip-m.at+BigInt(m.fileOff)).toString(16)}`;
  console.error(`<hb ${src} ${((Date.now()-hbT0)/1000)|0}s> interp=${eng.stats.interpreted} aot=${eng.stats.tiers?.aot||0} aotRuns=${eng.stats.aotRuns||0} failed=${eng.aotFailed?.size||0} @${where}`);
};
if (process.env.POLLWD) eng.debugPollAfter = +process.env.POLLWD;
if (process.env.XSDBG) xs.dbgInput = +process.env.XSDBG;
if (process.env.XSNOGRAB) xs.disableGrabs = true;
if (process.env.CHAINSLOW) eng.chainSlow = true;
if (process.env.SHADOW) eng.shadowLib = process.env.SHADOW;
import { snapshotEngine, restoreEngine } from '../../engine/snapshot.mjs';
import { CPU as CPUctor } from '../../engine/interp.mjs';
if (process.env.SNAPLOAD) {
  const t0r = Date.now();
  restoreEngine(eng, xs, process.env.SNAPLOAD, CPUctor);
  console.error(`<snapshot restored from ${process.env.SNAPLOAD} in ${Date.now()-t0r}ms>`);
}
const shadowPoll = () => {
  if (!process.env.SHADOW || eng.shadowRange) return;
  if (!globalThis._spDbg) { globalThis._spDbg = 1;
    console.error(`<shadowPoll maps=${(eng.maps??[]).length} sample=${(eng.maps??[]).slice(0,3).map(m=>m.path.split('/').pop()).join(',')}>`); }
  for (const m of eng.maps ?? []) if (m.path.includes(process.env.SHADOW)) {
    eng.shadowRange = [m.at, m.at + m.len];
    console.error(`<shadow armed ${m.path} 0x${m.at.toString(16)}+0x${m.len.toString(16)}>`);
    return;
  }
};
if (process.env.DUMPWAT_ALL) {
  eng.onUnitWat = (un, entry, unit) => {
    for (const m of eng.maps ?? []) if (entry >= m.at && entry < m.at + m.len) {
      if (!m.path.includes('pango')) return;
      const fn = `watdump/unit_${entry.toString(16)}.wat`;
      try { writeFileSync(fn, unit.wat); } catch {}
      console.error(`<unitfuncs entry=0x${entry.toString(16)} n=${unit.funcs.length} funcs=${unit.funcs.map(a=>a.toString(16)).join(',')}>`);
      return;
    }
  };
}
else if (process.env.DUMPWAT_ENTRY) {
  const want = BigInt(process.env.DUMPWAT_ENTRY);
  eng.onUnitWat = (un, entry, unit) => {
    if (entry === want) {
      const fn = `unit_${entry.toString(16)}.wat`;
      writeFileSync(fn, unit.wat);
      console.error(`<dumpwat wrote ${fn} funcs=${unit.funcs?.length}>`);
    }
  };
}
// persist whitelisted guest writes back into the sysroot so caches (babl fishes,
// fontconfig, gimprc state) survive across runs and startup gets fast
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const writeUnits = (snapPath) => {
  const entries = [];
  for (const h of usedHashes) {
    try { entries.push([h, readFileSync(WATCACHE + h + '.wasm').toString('base64')]); } catch {}
  }
  writeFileSync(snapPath + '.units', JSON.stringify(entries));
  console.error(`<units manifest: ${entries.length} compiled units>`);
};
const persistDirty = () => {
  let n = 0;
  for (const gp of eng.dirtyFiles ?? []) {
    if (!gp.startsWith('/root/') && !gp.startsWith('/var/cache/')) continue;
    const f = eng.files[gp]; if (!f) continue;
    try { const hp = join(sysroot, gp); mkdirSync(dirname(hp), { recursive: true });
      writeFileSync(hp, f); n++; } catch {}
  }
  if (n) console.error(`<persisted ${n} guest files into ${sysroot}>`);
};
process.on('SIGTERM', async () => {
  if (process.env.SNAPSAVE) { try { await snapshotEngine(eng, xs, process.env.SNAPSAVE);
    writeUnits(process.env.SNAPSAVE);
    console.error(`<snapshot saved to ${process.env.SNAPSAVE} (SIGTERM)>`); } catch (e) { console.error('snap fail', e.message); } }
  if (process.env.UNITSOUT) { try { writeUnits(process.env.UNITSOUT); } catch {} }
  try { persistDirty(); } catch {}
  try { console.error('stderr:', (eng.stderr??[]).join('').slice(-4000)); } catch {}
  try { xs.flush();
    const p = Buffer.alloc(W*H*3);
    for (let i=0;i<W*H;i++){ const v = xs.fb[i]; p[i*3]=(v>>16)&255; p[i*3+1]=(v>>8)&255; p[i*3+2]=v&255; }
    writeFileSync(outPpm, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), p]));
    console.error('shot written (SIGTERM):', outPpm);
  } catch {}
  process.exit(143); });
let state = 'ran-out';
const t0 = Date.now();
let lastLog = Date.now();
// wedge watchdog: if interp barely advances for 2 min, dump thread states
let wdMark = [Date.now(), 0], wdLastDump = 0;
const symb = (v) => { for (const m of eng.maps ?? []) if (v >= m.at && v < m.at + m.len)
  return `${m.path.split('/').pop()}+0x${(v - m.at + BigInt(m.fileOff)).toString(16)}`; return null; };
const wedgeDump = () => {
  console.error(`<WEDGE dump at ${((Date.now()-t0)/1000)|0}s interp=${eng.stats.interpreted}>`);
  for (const t of eng.threads ?? []) {
    const rip = t.cpu?.rip ?? 0n;
    let frames = [];
    try { const rsp = t.cpu.regs[4];
      for (let i = 0n; i < 400n && frames.length < 8; i += 8n) {
        const vv = eng.mem.read(rsp + i, 8n); const sy = symb(vv);
        if (sy) frames.push(sy);
      } } catch {}
    console.error(`  thr id=${t.id} st=${t.state} dl=${t.dl} futex=${t.futex ? '0x'+t.futex.toString(16)+(symb(t.futex)?'('+symb(t.futex)+')':'') : null} rip=${symb(rip) ?? '0x'+rip.toString(16)}`);
    console.error(`    stack: ${frames.join(' <- ')}`);
  }
  try { for (const d of xs.diag()) console.error('  ' + d); } catch {}
  // rbp-chain backtrace for each thread (works when frame pointers are kept)
  for (const t of eng.threads ?? []) {
    try {
      let rbp = t.cpu.regs[5]; const fr = [];
      for (let i = 0; i < 16 && rbp > 0x1000n; i++) {
        const ret = eng.mem.read(rbp + 8n, 8n); const sy = symb(ret);
        if (!sy) break;
        fr.push(sy);
        const nb = eng.mem.read(rbp, 8n);
        if (nb <= rbp || nb - rbp > 0x100000n) break;
        rbp = nb;
      }
      if (fr.length) console.error(`  rbpwalk thr=${t.id}: ${fr.join(' <- ')}`);
    } catch {}
  }
  // dump current screen so we can see the splash/progress state
  try {
    xs.flush();
    const p = Buffer.alloc(W*H*3);
    for (let i=0;i<W*H;i++){ const v = xs.fb[i]; p[i*3]=(v>>16)&255; p[i*3+1]=(v>>8)&255; p[i*3+2]=v&255; }
    writeFileSync(outPpm + '.wedge.ppm', Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), p]));
    console.error('  wedge screen written: ' + outPpm + '.wedge.ppm');
  } catch (e) { console.error('  wedge screen failed: ' + e.message); }
  try { persistDirty(); } catch {}
};
try {
  // with hot AOT one 1e6-step chunk can take ~30 wall-seconds (a step can be
  // a whole compiled-function run), which would quantize CLICK/drag injection
  // to that granularity — run fine chunks while scripted input is pending
  const inputPending = () => process.env.CLICK &&
    (globalThis._drag || (globalThis._clickDone?.size ?? 0) < process.env.CLICK.split(';').length);
  for (let i=0;i<+maxChunks;i++){ eng.run(inputPending() ? 5e4 : 1e6); if (eng.exitCode!==null){state='exit '+eng.exitCode;break;}
    if (Date.now() - lastLog > 15000) { lastLog = Date.now();
      const rip = eng.cpu.rip; let where = '?';
      for (const m of eng.maps ?? []) if (rip >= m.at && rip < m.at + m.len) where = `${m.path.split('/').pop()}+0x${(rip-m.at+BigInt(m.fileOff)).toString(16)}`;
      console.error(`[${((Date.now()-t0)/1000)|0}s] chunk=${i} interp=${eng.stats.interpreted} aot=${eng.stats.tiers?.aot||0} aotRuns=${eng.stats.aotRuns||0} failed=${eng.aotFailed?.size||0} rip@${where} blocked=${!!eng.blocked} sys=${JSON.stringify(eng.stats.syscalls||{})}`); }
    if (Date.now() - wdMark[0] > 120000) {
      const di = eng.stats.interpreted - wdMark[1];
      if (di < 500000 && Date.now() - wdLastDump > 600000) { wdLastDump = Date.now(); wedgeDump(); }
      wdMark = [Date.now(), eng.stats.interpreted];
    }
    shadowPoll();
    // CLICK: ';'-separated script — "x,y@ms" injects a left click, "esc@ms"
    // an Escape press; each item fires once when its time arrives. Used to
    // exercise a restored app (menus etc.) so UNITSOUT captures the units a
    // real interactive session actually requests.
    if (process.env.CLICK) {
      globalThis._clickDone ??= new Set();
      const items = process.env.CLICK.split(';');
      for (let ci = 0; ci < items.length; ci++) {
        if (globalThis._clickDone.has(ci)) continue;
        const dm = items[ci].match(/^drag:(\d+),(\d+),(\d+),(\d+)@(\d+)$/);
        if (dm) {                                   // press, 20 motion steps, release
          if (Date.now() - t0 <= +dm[5]) continue;
          globalThis._clickDone.add(ci);
          const [x1, y1, x2, y2] = [+dm[1], +dm[2], +dm[3], +dm[4]];
          { let ww = xs.windowAt(x1, y1).w; const chain = [];
            while (ww) { chain.push(`0x${ww.id.toString(16)}/m0x${(ww.eventMask ?? 0).toString(16)}/${ww.cls === 2 ? 'io' : 'iw'}${ww.mapped ? '' : '/unmapped'}`);
              ww = ww.parent ? xs.win(ww.parent) : null; }
            console.error('<drag chain: ' + chain.join(' < ') + '>'); }
          xs.countOps = true; xs.opCount = {};       // request histogram from here
          xs.injectMotion(x1, y1); xs.injectButton(1, true);
          globalThis._drag = { x1, y1, x2, y2, step: 0 };
          console.error(`<drag start ${x1},${y1} -> ${x2},${y2}>`);
          eng.wakeAllBlk?.(); continue;
        }
        const m = items[ci].match(/^(?:(\d+),(\d+)|(esc))@(\d+)$/);
        if (!m || Date.now() - t0 <= +m[4]) continue;
        globalThis._clickDone.add(ci);
        if (m[3]) { xs.injectKey(9, true); xs.injectKey(9, false); console.error('<esc injected>'); }
        else { xs.injectMotion(+m[1], +m[2]); xs.injectButton(1, true); xs.injectButton(1, false);
               console.error(`<click injected at ${m[1]},${m[2]}>`); }
        eng.wakeAllBlk?.();
      }
    }
    if (globalThis._drag) {                          // one motion step per chunk
      const d = globalThis._drag;
      d.step++;
      const t = d.step / 20;
      xs.injectMotion(Math.round(d.x1 + (d.x2 - d.x1) * t), Math.round(d.y1 + (d.y2 - d.y1) * t));
      if (d.step >= 20) { xs.injectButton(1, false); globalThis._drag = null; console.error('<drag end>'); }
      eng.wakeAllBlk?.();
    }
    {
      const seqNow = (() => { try { return xs.conns?.[0]?.seq ?? 0 } catch { return 0 } })();
      if (seqNow !== (globalThis._setSeq ?? -1)) { globalThis._setSeq = seqNow; globalThis._setT = Date.now(); }
      else if (seqNow > 50 && Date.now() - (globalThis._setT ?? 0) > 120000) { state = 'settled';
        if (process.env.SNAPSAVE) {
          const t0s = Date.now();
          await snapshotEngine(eng, xs, process.env.SNAPSAVE);
          writeUnits(process.env.SNAPSAVE);
          console.error(`<snapshot saved to ${process.env.SNAPSAVE} in ${Date.now()-t0s}ms>`);
        }
        break; }
    }
    if (eng.blocked){ if(eng.blocked.deadline==null){state='IDLE';
      if (process.env.SNAPSAVE) { const t0s=Date.now(); await snapshotEngine(eng, xs, process.env.SNAPSAVE);
        writeUnits(process.env.SNAPSAVE);
        console.error(`<snapshot saved to ${process.env.SNAPSAVE} in ${Date.now()-t0s}ms>`); }
      else wedgeDump();
      break;}
      const w = eng.blocked.deadline - eng.nowMs();
      if (w > 2) await new Promise(r => setTimeout(r, Math.min(w, 50)));
      eng.wake(); } }
} catch (e) { state = 'FAULT ' + e.message + ' rip=0x' + (e.rip??0n).toString(16);
  let where='?'; for (const m of eng.maps ?? []) if ((e.rip??0n) >= m.at && (e.rip??0n) < m.at+m.len) where=`${m.path}+0x${((e.rip??0n)-m.at+BigInt(m.fileOff)).toString(16)}`;
  console.error('  in', where);
  const b=[]; for(let i=-4n;i<10n;i++){try{b.push(Number(eng.mem.read((e.rip??0n)+i,1n)).toString(16).padStart(2,'0'))}catch{b.push('??')}}
  console.error('  bytes:', b.join(' '));
  const symf = (v) => { for (const m of eng.maps ?? []) if (v >= m.at && v < m.at + m.len)
    return `${m.path.split('/').pop()}+0x${(v - m.at + BigInt(m.fileOff)).toString(16)}`; return null; };
  try {
    const rsp = eng.cpu.regs[4];
    console.error('  fault stack walk (rsp=0x' + rsp.toString(16) + '):');
    let found = 0;
    for (let i = 0n; i < 8192n && found < 40; i += 8n) {
      try { const v = eng.mem.read(rsp + i, 8n); const w = symf(v);
        if (w) { console.error(`  [rsp+0x${i.toString(16)}] ${w}`); found++; } } catch { break; }
    }
    try {
    console.error('  last syscalls (nr, rip, ret):');
    for (const [nr, rp, rv] of (globalThis.__sysring ?? []).slice(-40))
      console.error(`    ${nr} @0x${rp.toString(16)} -> ${rv}`);
  } catch {}
  console.error('  regs:', [...Array(16)].map((_, i) => 'r' + i + '=0x' + BigInt.asUintN(64, eng.cpu.regs[i]).toString(16)).join(' '));
  } catch (e2) { console.error('  walk failed:', e2.message); }
}
if (xs.opCount) console.error('<ops since drag: ' + JSON.stringify(xs.opCount) + '>');
console.error('state:', state, 'steps:', eng.stats.interpreted, 'wall:', ((Date.now()-t0)/1000).toFixed(0)+'s');
console.error('stderr:', (eng.stderr??[]).join('').slice(-3000));
console.error('stdout:', (eng.stdout??[]).join('').slice(-500));
if (eng.unknown?.size) console.error('unknown syscalls:', [...eng.unknown]);
xs.flush();
const p = Buffer.alloc(W*H*3);
for (let i=0;i<W*H;i++){ const v = xs.fb[i]; p[i*3]=(v>>16)&255; p[i*3+1]=(v>>8)&255; p[i*3+2]=v&255; }
writeFileSync(outPpm, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), p]));
console.error('shot written:', outPpm);
console.error('aotfail summary (reason -> units):');
for (const [k, n] of [...failCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20))
  console.error(`  ${n}\t${k}`);
persistDirty();
// UNITSOUT=path: write the units THIS run requested (path.units). With
// SNAPLOAD + a CLICK script this captures the post-restore working set —
// a much smaller manifest for xpack --units than the full boot's.
if (process.env.UNITSOUT) writeUnits(process.env.UNITSOUT);
