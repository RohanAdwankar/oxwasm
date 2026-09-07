#!/bin/sh
# Fetch the oxwasm engine + BIOS into runtime/ (reproducible, ~2.6 MB).
#   engine: v86 (BSD-2-Clause, https://github.com/copy/v86) from npm
#   bios:   SeaBIOS + Bochs VGABios from the Ubuntu archive
#   wabt:   wabt.js (Apache-2.0) from npm - the packers inline it so a packed
#           page can assemble translated units in the browser
set -e
cd "$(dirname "$0")"
mkdir -p runtime .cache && cd .cache

V=$(curl -s https://registry.npmjs.org/v86/latest | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")
curl -sL -o v86.tgz "https://registry.npmjs.org/v86/-/v86-$V.tgz"
tar xzf v86.tgz package/build/libv86.js package/build/v86.wasm
cp package/build/libv86.js package/build/v86.wasm ../runtime/

# wabt.js: the packers inline it so a packed page assembles the WAT the
# translator emits, in the browser, with no server. It used to be read from a
# tarball someone had unpacked in /tmp, which existed on exactly one machine.
W=$(curl -s https://registry.npmjs.org/wabt/latest | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")
curl -sL -o wabt.tgz "https://registry.npmjs.org/wabt/-/wabt-$W.tgz"
mkdir -p wabtx && tar xzf wabt.tgz -C wabtx package/index.js
cp wabtx/package/index.js ../runtime/wabt.js

apt-get download seabios vgabios >/dev/null 2>&1 || {
  curl -sO http://archive.ubuntu.com/ubuntu/pool/main/s/seabios/$(curl -s http://archive.ubuntu.com/ubuntu/dists/noble/main/binary-amd64/Packages.gz | zcat | grep -A20 '^Package: seabios$' | awk '/^Filename:/{print $2}' | xargs basename); }
for d in *.deb; do dpkg-deb -x "$d" x/; done
cp x/usr/share/seabios/bios.bin ../runtime/bios.bin
cp x/usr/share/vgabios/vgabios.bin ../runtime/vgabios.bin 2>/dev/null || cp x/usr/share/seabios/vgabios.bin ../runtime/vgabios.bin
echo "runtime/ ready (v86 $V, wabt $W)"
