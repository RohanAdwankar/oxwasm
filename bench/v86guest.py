"""Build a v86 bench guest: the same GNU coreutils program, i386, in a browser.

The point is an incumbent comparison that is measured rather than cited. v86 is
the open incumbent for running unmodified Linux in a browser, and it is already
this project's M1 engine, so it can be driven on the same host, in the same
browser, over the same input as the M3 page.

It cannot run the same BINARY: v86 is 32-bit, so the amd64 sha256sum the M3
page runs has no v86 equivalent. The nearest honest thing is the same program
from the same source - GNU coreutils sha256sum - built for i386, which is what
this packs. The ABI differs and that is stated wherever the number is.

The guest prints a marker line the harness times against, then halts, so the
measurement is host wall-clock from navigation to marker. Boot dominates that,
which is why the harness runs two input sizes and subtracts.

    python3 bench/v86guest.py --in /tmp/vs_small.txt -o /tmp/v86_small.html
"""
import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
from mkcpio import build_initramfs   # noqa: E402

CACHE = os.path.join(ROOT, ".cache", "bench")

INIT = """#!/bin/busybox sh
/bin/busybox mkdir -p /proc /sys /dev /tmp
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
/bin/busybox mount -t devtmpfs devtmpfs /dev 2>/dev/null
/bin/busybox --install -s /bin
echo OXBENCH-START
/usr/bin/sha256sum /in
echo OXBENCH-DONE
/bin/busybox poweroff -f
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True, help="file the guest hashes, mounted at /in")
    ap.add_argument("-o", dest="out", required=True)
    a = ap.parse_args()

    kernel = os.path.join(CACHE, "x", "boot", "vmlinuz-4.15.0-20-generic")
    busybox = os.path.join(CACHE, "x", "bin", "busybox")
    sha256 = os.path.join(CACHE, "x", "usr", "bin", "sha256sum")
    for p in (kernel, busybox, sha256):
        if not os.path.exists(p):
            sys.exit("missing %s - fetch the i386 kernel, busybox-static and coreutils debs into %s" % (p, CACHE))

    # sha256sum is DYNAMICALLY linked, exactly as the amd64 one the M3 page
    # runs is, so the guest needs the i386 loader and libc at the paths the
    # binary asks for. Shipping busybox's built-in sha256sum instead would be
    # simpler and would compare two different programs.
    libs = {
        "lib/ld-linux.so.2": os.path.join(CACHE, "x", "lib", "ld-linux.so.2"),
        "lib/i386-linux-gnu/libc.so.6": os.path.join(CACHE, "x", "lib", "i386-linux-gnu", "libc.so.6"),
    }
    for guest, host in libs.items():
        if not os.path.exists(host):
            sys.exit("missing %s - fetch libc6 i386 into %s" % (host, CACHE))
    with open(a.inp, "rb") as f:
        payload = f.read()
    extra = {"in": (payload, 0o100644)}
    with open(sha256, "rb") as f:
        extra["usr/bin/sha256sum"] = (f.read(), 0o100755)
    for guest, host in libs.items():
        with open(host, "rb") as f:
            extra[guest] = (f.read(), 0o100755)
    initrd = os.path.join(CACHE, "initrd-bench.gz")
    with open(initrd, "wb") as f:
        f.write(build_initramfs(busybox, INIT, extra))

    subprocess.run([sys.executable, os.path.join(ROOT, "oxwasm.py"), "build",
                    "--kernel", kernel, "--initrd", initrd,
                    "--title", "v86 bench", "-o", a.out], check=True)
    print("wrote %s (%d MB) for a %d MB input" %
          (a.out, os.path.getsize(a.out) // 10**6, len(payload) // 10**6))


if __name__ == "__main__":
    main()
