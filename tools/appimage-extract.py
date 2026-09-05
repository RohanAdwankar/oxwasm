#!/usr/bin/env python3
"""Extract a type-2 AppImage (runtime ELF + appended squashfs) without FUSE
or root: the squashfs starts where the ELF's section table ends. Pure python
(PySquashfsImage + zstandard). Prints the resolved inner entry ELF path.

    python3 appimage-extract.py app.AppImage outdir/
"""
import os
import re
import stat
import struct
import sys

def elf_end(path):
    with open(path, 'rb') as f:
        d = f.read(64)
        if d[:4] != b'\x7fELF':
            sys.exit('not an ELF')
        shoff, = struct.unpack_from('<Q', d, 0x28)
        shentsize, shnum = struct.unpack_from('<HH', d, 0x3A)
        return shoff + shnum * shentsize

def main():
    src, outdir = sys.argv[1], sys.argv[2]
    with open(src, 'rb') as f:
        magic = f.read(12)
    if magic[8:11] != b'AI\x02':
        sys.exit('not a type-2 AppImage (no AI\\x02 magic)')
    off = elf_end(src)
    from PySquashfsImage import SquashFsImage
    img = SquashFsImage.from_file(src, offset=off)
    entries = {}
    for e in img:
        p = e.path.lstrip('/')
        if not p:
            continue
        dst = os.path.join(outdir, p)
        if e.is_dir:
            os.makedirs(dst, exist_ok=True)
        elif e.is_symlink:
            entries[p] = ('link', e.readlink())
        elif e.is_file:
            os.makedirs(os.path.dirname(dst) or outdir, exist_ok=True)
            with open(dst, 'wb') as g:
                g.write(e.read_bytes())
            os.chmod(dst, 0o755)
            entries[p] = ('file', dst)
    img.close()
    # place symlinks after files so their targets exist
    for p, (kind, tgt) in entries.items():
        if kind == 'link':
            dst = os.path.join(outdir, p)
            os.makedirs(os.path.dirname(dst) or outdir, exist_ok=True)
            if not os.path.lexists(dst):
                os.symlink(tgt, dst)

    # resolve the app entry: AppRun script's exec target, or AppRun-as-ELF
    entry = None
    apprun = os.path.join(outdir, 'AppRun')
    if os.path.exists(apprun):
        with open(apprun, 'rb') as f:
            head = f.read(4096)
        if head[:4] == b'\x7fELF':
            entry = apprun
        else:
            m = re.search(rb'exec\s+"?\$?\{?this_dir\}?"?/([^\s"]+)', head) or \
                re.search(rb'exec\s+"\$\{?HERE\}?"?/([^\s"]+)', head) or \
                re.search(rb'exec\s+"\$\(dirname[^)]*\)"?/([^\s"]+)', head)
            if m:
                entry = os.path.join(outdir, m.group(1).decode())
    if not entry or not os.path.exists(entry):
        # fallback: largest ELF under usr/bin
        best = (0, None)
        for root, _, names in os.walk(outdir):
            for n in names:
                p = os.path.join(root, n)
                try:
                    if os.path.getsize(p) > best[0] and open(p, 'rb').read(4) == b'\x7fELF':
                        best = (os.path.getsize(p), p)
                except OSError:
                    pass
        entry = best[1]
    if not entry:
        sys.exit('no ELF entry found in AppImage payload')
    print(entry)

if __name__ == '__main__':
    main()
