// Where wabt.js lives.
//
// The packers inline wabt.js so a packed page can assemble the WAT the
// translator emits without a server. Both of them used to read it from
// /tmp/package/index.js - a tarball somebody had unpacked in /tmp once, on one
// machine. On any other machine m3pack died with ENOENT on that path, which is
// the README's headline command, and xpack quietly packed a page with no
// in-browser assembler at all. fetch-runtime.sh puts it in runtime/wabt.js
// alongside the v86 engine and the BIOS; OXWASM_WABT_JS overrides, and the old
// /tmp path still works so an existing checkout does not break.
import { existsSync, readFileSync } from 'node:fs';

export function wabtJsPath() {
  for (const p of [process.env.OXWASM_WABT_JS,
                   new URL('../runtime/wabt.js', import.meta.url).pathname,
                   '/tmp/package/index.js'])
    if (p && existsSync(p)) return p;
  return null;
}

// required: throw with the fix rather than an ENOENT on a path the reader has
// never heard of. Optional callers get null and degrade.
export function readWabtJs({ required = false } = {}) {
  const p = wabtJsPath();
  if (p) return readFileSync(p, 'utf8');
  if (required) throw new Error('wabt.js not found: run ./fetch-runtime.sh (or set OXWASM_WABT_JS to a wabt npm package index.js). The packed page needs it to assemble translated units in the browser.');
  return null;
}
