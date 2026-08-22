"""Minimal newc-format cpio archive writer.

oxwasm builds guest initramfs images in pure Python so the host needs no
cpio/mkisofs tooling. Deterministic: all timestamps are 0.
"""
import gzip
import io
import os


class CpioWriter:
    def __init__(self):
        self._buf = io.BytesIO()
        self._ino = 721

    def _entry(self, name, mode, data=b"", nlink=1):
        self._ino += 1
        name_b = name.encode() + b"\0"
        hdr = (
            b"070701"
            + b"%08X" % self._ino          # ino
            + b"%08X" % mode               # mode
            + b"%08X" % 0                  # uid
            + b"%08X" % 0                  # gid
            + b"%08X" % nlink              # nlink
            + b"%08X" % 0                  # mtime
            + b"%08X" % len(data)          # filesize
            + b"%08X" % 0 + b"%08X" % 0    # devmajor/minor
            + b"%08X" % 0 + b"%08X" % 0    # rdevmajor/minor
            + b"%08X" % len(name_b)        # namesize
            + b"%08X" % 0                  # check
        )
        b = self._buf
        b.write(hdr)
        b.write(name_b)
        b.write(b"\0" * (-(len(hdr) + len(name_b)) % 4))
        b.write(data)
        b.write(b"\0" * (-len(data) % 4))

    def dir(self, name):
        self._entry(name, 0o040755, nlink=2)

    def file(self, name, data, mode=0o100644):
        self._entry(name, mode, data)

    def symlink(self, name, target):
        self._entry(name, 0o120777, target.encode())

    def bytes(self, compress=True):
        self._entry("TRAILER!!!", 0)
        raw = self._buf.getvalue()
        raw += b"\0" * (-len(raw) % 512)
        return gzip.compress(raw, 9) if compress else raw


def build_initramfs(busybox_path, init_script, extra_files=None, compress=True):
    """Assemble a bootable initramfs: busybox + /init + optional extras."""
    w = CpioWriter()
    for d in ("bin", "sbin", "dev", "proc", "sys", "tmp", "root", "etc"):
        w.dir(d)
    with open(busybox_path, "rb") as f:
        w.file("bin/busybox", f.read(), mode=0o100755)
    w.file("init", init_script.encode(), mode=0o100755)
    for path, (data, mode) in (extra_files or {}).items():
        w.file(path, data, mode)
    return w.bytes(compress=compress)
