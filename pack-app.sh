#!/bin/sh
# pack-app.sh — turn ANY graphical Linux application into a single static
# HTML file. Knows nothing about GIMP or any specific program; it reads an
# app spec and assembles a guest around whatever it names.
#
#   ./pack-app.sh examples/gimp.app -o gimp.html
#   ./pack-app.sh examples/xcalc.app -o xcalc.html
#
# An app spec is a sourced shell fragment defining:
#   PACKAGES  space-separated Ubuntu package names to install (deps auto-resolved)
#   RUN       command to exec once X is up            (e.g. "gimp")
#   WM        optional window-manager command         (e.g. "matchbox-window-manager")
#   TITLE     optional HTML page title
#   MEMORY    optional guest RAM in MB (default 512)
#
# The app is delivered exactly as Ubuntu ships it — nothing patched. Swap
# the spec, get a different app; the pipeline is identical.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)

# --- host portability -------------------------------------------------------
# The build assembles a Debian/Ubuntu i386 guest, so it needs Linux packaging
# tools (dpkg-deb, mke2fs, chroot). On macOS/Windows — or any host missing
# them — transparently re-run the whole build inside a Linux container, so the
# same command works everywhere. Set OXWASM_NO_DOCKER=1 to force the native path.
if [ -z "$OXWASM_IN_DOCKER" ] && [ -z "$OXWASM_NO_DOCKER" ] && \
   { ! command -v dpkg-deb >/dev/null 2>&1 || ! command -v mke2fs >/dev/null 2>&1; }; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "error: this build needs Linux tools (dpkg-deb, mke2fs) not found on $(uname -s)." >&2
    echo "       install Docker Desktop (recommended) and re-run, or run on Linux." >&2
    exit 1
  fi
  echo "==> $(uname -s): Linux build tools not found — running the build inside Docker"
  IMAGE=oxwasm-builder
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "==> building one-time builder image '$IMAGE' (first run only)"
    docker build -t "$IMAGE" - <<'DOCKER'
FROM ubuntu:18.04
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 curl ca-certificates e2fsprogs dpkg util-linux busybox-static \
    && rm -rf /var/lib/apt/lists/*
DOCKER
  fi
  # mount the repo and the working dir so relative SPEC paths and -o output
  # resolve exactly as on the host; keep the same cwd inside the container.
  # Prefer a single mount of the common ancestor to avoid overlapping binds.
  case "$HERE/" in
    "$PWD/"*) MNT="-v $PWD:$PWD";;                       # repo is inside cwd
    *) case "$PWD/" in
         "$HERE/"*) MNT="-v $HERE:$HERE";;               # cwd is inside repo
         *)         MNT="-v $HERE:$HERE -v $PWD:$PWD";;   # disjoint trees
       esac;;
  esac
  # shellcheck disable=SC2086
  exec docker run --rm -i $MNT -w "$PWD" -e OXWASM_IN_DOCKER=1 \
       "$IMAGE" "$HERE/pack-app.sh" "$@"
fi
# ---------------------------------------------------------------------------

SPEC=$1; shift
OUT=out.html
SNAPSHOT=0
while [ $# -gt 0 ]; do case "$1" in -o) OUT=$2; shift 2;; --snapshot) SNAPSHOT=1; shift;; *) echo "unknown arg $1"; exit 1;; esac; done
[ -r "$SPEC" ] || { echo "usage: pack-app.sh SPEC.app -o out.html"; exit 1; }

# defaults, then the spec overrides them
PACKAGES=""; RUN=""; WM=""; WARM=""; TITLE="oxwasm"; MEMORY=512
. "$SPEC"
[ -n "$RUN" ] || { echo "spec must set RUN"; exit 1; }
# every graphical guest needs these regardless of the app
PACKAGES="$PACKAGES xserver-xorg-core xserver-xorg-video-vesa xserver-xorg-input-evdev xkb-data x11-xkb-utils fonts-dejavu-core busybox-static libc-bin"
[ -n "$WM" ] && PACKAGES="$PACKAGES $(echo "$WM" | awk '{print $1}')"

W="$HERE/.cache/app-$(basename "$SPEC" .app)"; mkdir -p "$W"; cd "$W"
M=http://archive.ubuntu.com/ubuntu

echo "==> resolving dependency closure"
[ -f main.gz ]     || curl -s "$M/dists/bionic/main/binary-i386/Packages.gz" -o main.gz
[ -f universe.gz ] || curl -s "$M/dists/bionic/universe/binary-i386/Packages.gz" -o universe.gz
python3 "$HERE/resolve-debs.py" $PACKAGES

echo "==> fetching + extracting packages (offline install)"
mkdir -p debs rootfs
python3 - <<PY
import json, subprocess, os, time
cl = json.load(open('closure.json'))
procs = []
for c in cl:
    out = 'debs/' + os.path.basename(c['file'])
    if os.path.exists(out) and os.path.getsize(out) == c['size']: continue
    procs.append(subprocess.Popen(['curl','-s','-o',out,'http://archive.ubuntu.com/ubuntu/'+c['file']]))
    while len([p for p in procs if p.poll() is None]) >= 12: time.sleep(0.05)
for p in procs: p.wait()
PY
for d in debs/*.deb; do dpkg-deb -x "$d" rootfs/; done

echo "==> base system + app config"
ln -sf busybox rootfs/bin/sh
mkdir -p rootfs/proc rootfs/sys rootfs/dev rootfs/tmp rootfs/run rootfs/root \
         rootfs/var/log rootfs/var/lib/xkb rootfs/etc/X11 rootfs/lib/modules
printf 'root:x:0:0:root:/root:/bin/sh\n' > rootfs/etc/passwd
printf 'root:x:0:\n' > rootfs/etc/group
printf '127.0.0.1 localhost oxwasm\n' > rootfs/etc/hosts
cp "$HERE/guest/xorg.conf" rootfs/etc/X11/xorg.conf
cp "$HERE/guest/oxinit" rootfs/sbin/oxinit && chmod +x rootfs/sbin/oxinit
printf '%s\n' "$RUN" > rootfs/etc/oxwasm-run          # <-- the ONLY app-specific bytes
[ -n "$WM" ] && printf '%s\n' "$WM" > rootfs/etc/oxwasm-wm

echo "==> mouse module + i386-chroot cache warming"
[ -f linux-modules.deb ] || curl -s -o linux-modules.deb "$M/pool/main/l/linux/linux-modules-4.15.0-20-generic_4.15.0-20.21_i386.deb"
dpkg-deb -x linux-modules.deb mods/
cp mods/lib/modules/4.15.0-20-generic/kernel/drivers/input/mouse/psmouse.ko rootfs/lib/modules/ 2>/dev/null || true
chroot rootfs /sbin/ldconfig 2>/dev/null || true
chroot rootfs /usr/bin/fc-cache -f 2>/dev/null || true
[ -x rootfs/usr/lib/i386-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders ] && \
  chroot rootfs /usr/lib/i386-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders --update-cache 2>/dev/null || true
[ -x rootfs/usr/bin/gtk-update-icon-cache ] && for t in hicolor Adwaita; do
  [ -d rootfs/usr/share/icons/$t ] && chroot rootfs /usr/bin/gtk-update-icon-cache -f /usr/share/icons/$t 2>/dev/null || true
done

# WARM: run the app once, headless, in the chroot so its expensive first-run
# work (plugin registration, config generation) is frozen into the image
# instead of paid on every browser boot. Process spawns are the priciest
# thing under emulation, so precomputing them here is the single biggest win.
if [ -n "$WARM" ]; then
  echo "==> warming app first-run state: $WARM"
  chroot rootfs /bin/sh -c "export HOME=/root; $WARM" >/dev/null 2>&1 || true
fi

echo "==> pruning docs/locale to shrink the image"
rm -rf rootfs/usr/share/locale rootfs/usr/share/doc rootfs/usr/share/man \
       rootfs/usr/share/info rootfs/usr/share/icons/Humanity* rootfs/usr/share/icons/ubuntu-mono-* \
       rootfs/usr/lib/python2.7 rootfs/usr/bin/python* 2>/dev/null || true
chroot rootfs /sbin/ldconfig 2>/dev/null || true

echo "==> kernel + disk image + single-file HTML"
[ -f linux-image.deb ] || curl -s -o linux-image.deb "$M/pool/main/l/linux/linux-image-4.15.0-20-generic_4.15.0-20.21_i386.deb"
dpkg-deb -x linux-image.deb kern/
SZ=$(du -sm rootfs | cut -f1)
mke2fs -q -t ext2 -d rootfs -b 4096 -m 0 -F disk.img $((SZ + SZ/8 + 20))M
python3 "$HERE/oxwasm.py" build --kernel kern/boot/vmlinuz-4.15.0-20-generic disk.img \
  --cmdline "root=/dev/sda rw rootwait init=/sbin/oxinit console=ttyS0" \
  --memory "$MEMORY" --title "$TITLE" -o "$OUT"

if [ "$SNAPSHOT" = "1" ] && ! command -v node >/dev/null 2>&1; then
  echo "==> note: --snapshot needs Node + headless Chromium, which the lean Docker" >&2
  echo "    builder image doesn't carry. Wrote the un-snapshotted $OUT; run the" >&2
  echo "    snapshot step (tools/snapshot.js) on a host with Node + Chromium." >&2
  SNAPSHOT=0
fi
if [ "$SNAPSHOT" = "1" ]; then
  # Boot once, freeze the machine at "app ready", repackage as restore-to-ready.
  # Skips emulated Linux+X+app boot on every open; needs a headless chromium.
  echo "==> capturing snapshot (boots the app once; a few minutes)"
  node "$HERE/tools/snapshot.js" "$OUT" "$W/app.state"
  python3 "$HERE/oxwasm.py" build --state "$W/app.state" --memory "$MEMORY" \
    --title "$TITLE" -o "$OUT"
  echo "==> done: $OUT  (restore-to-ready — no boot on open)"
else
  echo "==> done: $OUT  (open it — no server needed)"
fi
