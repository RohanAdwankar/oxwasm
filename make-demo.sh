#!/bin/sh
# Build the M1 demo guest — an UNMODIFIED Ubuntu 18.04 i386 kernel and
# busybox userspace — and package it as a single offline linux.html.
set -e
cd "$(dirname "$0")"
mkdir -p .cache/guest && cd .cache/guest

M=http://archive.ubuntu.com/ubuntu
curl -sO $M/pool/main/l/linux/linux-image-4.15.0-20-generic_4.15.0-20.21_i386.deb
curl -sO $M/pool/main/b/busybox/busybox-static_1.27.2-2ubuntu3_i386.deb
for d in *.deb; do dpkg-deb -x "$d" x/; done

python3 - <<'PY'
import sys; sys.path.insert(0, '../..')
from mkcpio import build_initramfs
init = open('../../demo-init.sh').read()
extra = {"etc/oxwasm-release":
         (b"oxwasm demo guest: Ubuntu bionic kernel 4.15 (i386) + busybox 1.27, unmodified binaries\n", 0o100644)}
open('initrd.gz', 'wb').write(build_initramfs('x/bin/busybox', init, extra))
PY

cd ../.. && python3 oxwasm.py build \
  --kernel .cache/guest/x/boot/vmlinuz-4.15.0-20-generic \
  --initrd .cache/guest/initrd.gz \
  --title "oxwasm — Linux in a file" -o linux.html
echo "open linux.html — no server needed"
