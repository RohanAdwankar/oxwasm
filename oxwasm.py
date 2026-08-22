#!/usr/bin/env python3
"""oxwasm — package unmodified Linux software as a single static HTML file.

    oxwasm build --kernel vmlinuz --initrd initrd.gz -o linux.html
    oxwasm build boot.iso -o out.html
    oxwasm build gimp.AppImage          # roadmap: see the error it prints

The output is one self-contained .html: open it from disk, from a static
host, or email it to someone. No server, no network, no install. Inside is
a WASM x86 machine (v86) booting the exact bytes you gave it.
"""
import argparse
import base64
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RUNTIME = os.environ.get("OXWASM_RUNTIME", os.path.join(HERE, "runtime"))

APPIMAGE_MSG = """\
error: {name} is an x86-64 binary (AppImages are 64-bit ELF).

oxwasm's current engine (v86) executes 32-bit x86. Running 64-bit desktop
apps at usable speed needs the M3 engine — an x86-64 -> WASM JIT. Today you
can package any 32-bit guest (kernel+initrd or bootable ISO/disk image).

  M1 (now)   kernel/initrd or ISO -> single-file HTML, boots offline
  M2 (next)  32-bit graphical guest: X11 + GIMP via emulation (slow but real)
  M3         fast engine: x86-64 -> WASM JIT, AppImage in, usable GIMP out
"""


def b64(path_or_bytes):
    data = path_or_bytes
    if isinstance(data, str):
        with open(data, "rb") as f:
            data = f.read()
    return base64.b64encode(data).decode()


def runtime_file(name):
    p = os.path.join(RUNTIME, name)
    if not os.path.exists(p):
        sys.exit(f"error: runtime file missing: {p}\nrun ./fetch-runtime.sh first")
    return p


def build_html(*, title, memory_mb, cmdline, images, out):
    payload = {k: b64(v) for k, v in images.items()}
    cfg = {"memory_mb": memory_mb, "cmdline": cmdline,
           "boot": sorted(images.keys() - {"bios", "vga_bios"})}
    html = TEMPLATE
    html = html.replace("__TITLE__", title)
    html = html.replace("__CONFIG__", json.dumps(cfg))
    html = html.replace("__LIBV86__", open(runtime_file("libv86.js")).read())
    html = html.replace("__WASM_B64__", b64(runtime_file("v86.wasm")))
    html = html.replace("__BIOS_B64__", payload.get("bios", ""))
    html = html.replace("__VGABIOS_B64__", payload.get("vga_bios", ""))
    html = html.replace("__BZIMAGE_B64__", payload.get("bzimage", ""))
    html = html.replace("__INITRD_B64__", payload.get("initrd", ""))
    html = html.replace("__CDROM_B64__", payload.get("cdrom", ""))
    html = html.replace("__HDA_B64__", payload.get("hda", ""))
    with open(out, "w") as f:
        f.write(html)
    print(f"oxwasm: wrote {out} ({os.path.getsize(out)/1e6:.1f} MB, fully self-contained)")


def cmd_build(args):
    images = {"bios": runtime_file("bios.bin"), "vga_bios": runtime_file("vgabios.bin")}
    if args.target:
        t = args.target
        low = t.lower()
        if low.endswith(".appimage"):
            sys.exit(APPIMAGE_MSG.format(name=os.path.basename(t)))
        if not os.path.exists(t):
            sys.exit(f"error: no such file: {t}")
        if low.endswith(".iso"):
            images["cdrom"] = t
        else:
            images["hda"] = t
    if args.kernel:
        images["bzimage"] = args.kernel
        if args.initrd:
            images["initrd"] = args.initrd
    if not (images.keys() - {"bios", "vga_bios"}):
        sys.exit("error: nothing to boot; give a TARGET or --kernel/--initrd")
    build_html(title=args.title, memory_mb=args.memory, cmdline=args.cmdline,
               images=images, out=args.out)


def main():
    p = argparse.ArgumentParser(prog="oxwasm", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="package a guest into a single HTML file")
    b.add_argument("target", nargs="?", help=".iso / disk image / .AppImage")
    b.add_argument("--kernel", help="bzImage for direct Linux boot")
    b.add_argument("--initrd", help="initramfs to pair with --kernel")
    b.add_argument("--cmdline", default="console=ttyS0 console=tty0 rdinit=/init",
                   help="kernel command line")
    b.add_argument("--memory", type=int, default=256, help="guest RAM in MB")
    b.add_argument("--title", default="oxwasm", help="page title")
    b.add_argument("-o", "--out", default="out.html")
    b.set_defaults(func=cmd_build)
    args = p.parse_args()
    args.func(args)


TEMPLATE = r"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
  html,body{margin:0;height:100%;background:#0b0e14;color:#c8ccd4;
    font:14px/1.5 ui-monospace,Menlo,Consolas,monospace}
  #wrap{min-height:100%;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:14px;padding:16px;box-sizing:border-box}
  #status{color:#7d8590;font-size:12px}
  #screen_container{background:#000;padding:10px;border-radius:8px;
    box-shadow:0 0 0 1px #1d2330,0 12px 40px rgba(0,0,0,.6);cursor:text}
  #screen_container>div{white-space:pre;font:14px/14px ui-monospace,Menlo,Consolas,monospace}
  #screen_container>canvas{display:none}
  #foot{color:#4a5160;font-size:11px}
  #foot b{color:#7d8590}
</style>
</head>
<body>
<div id="wrap">
  <div id="status">unpacking machine&hellip;</div>
  <div id="screen_container" tabindex="0"><div></div><canvas></canvas></div>
  <div id="foot"><b>oxwasm</b> &middot; an unmodified operating system, executing in this tab &middot; no server, works offline &middot; click the screen and type</div>
</div>
<script>__LIBV86__</script>
<script>
"use strict";
var CONFIG = __CONFIG__;
function unb64(s){
  if(!s) return null;
  var bin = atob(s), n = bin.length, u = new Uint8Array(n);
  for(var i=0;i<n;i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
var PAYLOAD = {
  wasm:     unb64("__WASM_B64__"),
  bios:     unb64("__BIOS_B64__"),
  vga_bios: unb64("__VGABIOS_B64__"),
  bzimage:  unb64("__BZIMAGE_B64__"),
  initrd:   unb64("__INITRD_B64__"),
  cdrom:    unb64("__CDROM_B64__"),
  hda:      unb64("__HDA_B64__")
};
var statusEl = document.getElementById("status");
var opts = {
  wasm_fn: function(env){
    return WebAssembly.instantiate(PAYLOAD.wasm, env).then(function(r){return r.instance.exports;});
  },
  screen_container: document.getElementById("screen_container"),
  memory_size: CONFIG.memory_mb << 20,
  vga_memory_size: 8 << 20,
  bios: {buffer: PAYLOAD.bios},
  vga_bios: {buffer: PAYLOAD.vga_bios},
  cmdline: CONFIG.cmdline,
  autostart: true,
  disable_speaker: true
};
if(PAYLOAD.bzimage) opts.bzimage = {buffer: PAYLOAD.bzimage};
if(PAYLOAD.initrd)  opts.initrd  = {buffer: PAYLOAD.initrd};
if(PAYLOAD.cdrom)   opts.cdrom   = {buffer: PAYLOAD.cdrom};
if(PAYLOAD.hda)     opts.hda     = {buffer: PAYLOAD.hda};

var emulator = new V86(opts);
window.__serial = "";                       // observable from test harnesses
emulator.add_listener("serial0-output-byte", function(b){
  window.__serial += String.fromCharCode(b);
});
emulator.add_listener("emulator-started", function(){
  statusEl.textContent = "machine started — booting…";
});
setInterval(function(){
  var t = document.getElementById("screen_container").firstElementChild.textContent;
  if(/[$#] $/m.test(t)) statusEl.textContent = "ready — this is a real shell; click and type";
}, 500);
document.getElementById("screen_container").addEventListener("click", function(){ this.focus(); });
</script>
</body>
</html>
"""

if __name__ == "__main__":
    main()
