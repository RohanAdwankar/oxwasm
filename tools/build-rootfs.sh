#!/bin/sh
# Build the root filesystem tarball an oxwasm sandbox boots from:
#   Ubuntu 24.04 base + python3 + ca-certificates + curl, with apt pointed at
#   Ubuntu's own (plain http) mirrors. Needs Linux, root, chroot and network.
#
#   sudo tools/build-rootfs.sh [out.tar.gz]
#
# Plain http is Ubuntu's default and loses nothing: apt verifies the signed
# InRelease files itself. It matters here because TLS decryption is
# CPU-bound and the guest is emulated; https cost minutes per update.
set -eu
OUT=${1:-oxwasm-ubuntu24-py312.tar.gz}
WORK=$(mktemp -d)
BASE_URL=https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release
BASE=$(curl -fsS "$BASE_URL/" | grep -o 'ubuntu-base-24\.04\.[0-9]*-base-amd64\.tar\.gz' | sort -V | tail -1)
echo "base image: $BASE"
curl -fsS -o "$WORK/base.tar.gz" "$BASE_URL/$BASE"
curl -fsS "$BASE_URL/SHA256SUMS" | grep " \*\?$BASE\$" | sed "s# \*\?$BASE#  $WORK/base.tar.gz#" | sha256sum -c -
ROOT=$WORK/root; mkdir "$ROOT"; tar -xzf "$WORK/base.tar.gz" -C "$ROOT"
cp /etc/resolv.conf "$ROOT/etc/resolv.conf"
mount -t proc proc "$ROOT/proc"
trap 'umount "$ROOT/proc" 2>/dev/null || true' EXIT
CH="chroot $ROOT /usr/bin/env PATH=/usr/sbin:/usr/bin:/sbin:/bin"
# apt drops to the _apt user for its download methods; do the build as root.
APT="apt-get -o APT::Sandbox::User=root"
# ubuntu-base ships without gpgv, which apt needs to verify anything. Take the
# builder's (same release) and its libraries; apt-get install gpgv replaces it.
if [ ! -x "$ROOT/usr/bin/gpgv" ]; then
  cp /usr/bin/gpgv "$ROOT/usr/bin/gpgv"
  for l in $(ldd /usr/bin/gpgv | grep -o '/[^ ]*'); do [ -e "$ROOT$l" ] || { mkdir -p "$ROOT$(dirname $l)"; cp -L "$l" "$ROOT$l"; }; done
fi
sed -i 's#https://#http://#g' "$ROOT/etc/apt/sources.list.d/ubuntu.sources"
$CH $APT update
$CH $APT install -y --no-install-recommends python3 ca-certificates curl less
$CH $APT clean
rm -rf "$ROOT"/var/lib/apt/lists/* "$ROOT"/etc/resolv.conf
# The emulated guest aborts while ldconfig writes its cache (open issue); a
# package trigger that runs ldconfig must not fail for it. Fall back to a run
# that leaves the cache alone - the loader searches the standard directories
# without it.
python3 - "$ROOT/sbin/ldconfig" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace('exec /sbin/ldconfig.real "$@"', '/sbin/ldconfig.real "$@" && exit 0\nexec /sbin/ldconfig.real -N -X "$@"')
open(p, 'w').write(s)
PY
umount "$ROOT/proc"; trap - EXIT
rm -rf "$ROOT"/proc/* "$ROOT"/tmp/*
tar --numeric-owner -C "$ROOT" -czf "$OUT" .
sha256sum "$OUT"
rm -rf "$WORK"
