#!/bin/sh
# Build the M2 demo: an i386 GIMP 2.8 + Xorg guest, packaged by oxwasm
# into one offline gimp.html. Every guest byte is stock Ubuntu bionic
# i386 output — nothing recompiled, nothing patched.
#
# Requires: an x86-64 Linux host with ia32 exec support (for the chroot
# cache-warming), dpkg-deb, mke2fs, python3, ~2 GB scratch space.
set -e
cd "$(dirname "$0")"
W=.cache/m2; mkdir -p $W; cd $W
M=http://archive.ubuntu.com/ubuntu

# 1. dependency closure over bionic main+universe (i386)
[ -f main.gz ]     || curl -s "$M/dists/bionic/main/binary-i386/Packages.gz" -o main.gz
[ -f universe.gz ] || curl -s "$M/dists/bionic/universe/binary-i386/Packages.gz" -o universe.gz
python3 ../../resolve-debs.py gimp xserver-xorg-core xserver-xorg-video-vesa \
    xserver-xorg-input-evdev xkb-data x11-xkb-utils fonts-dejavu-core \
    matchbox-window-manager busybox-static libc-bin

# 2. fetch + extract (no maintainer scripts — this is an offline install)
mkdir -p debs rootfs
python3 - <<'PY'
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

# 3. base system + config
ln -sf busybox rootfs/bin/sh
mkdir -p rootfs/proc rootfs/sys rootfs/dev rootfs/tmp rootfs/run rootfs/root \
         rootfs/var/log rootfs/var/lib/xkb rootfs/etc/X11 rootfs/lib/modules
printf 'root:x:0:0:root:/root:/bin/sh\n' > rootfs/etc/passwd
printf 'root:x:0:\n' > rootfs/etc/group
printf '127.0.0.1 localhost oxwasm\n' > rootfs/etc/hosts
cp ../../guest/xorg.conf rootfs/etc/X11/xorg.conf
cp ../../guest/oxinit rootfs/sbin/oxinit && chmod +x rootfs/sbin/oxinit

# psmouse is the one module the kernel needs (everything else is built in)
[ -f linux-modules.deb ] || curl -s -o linux-modules.deb "$M/pool/main/l/linux/linux-modules-4.15.0-20-generic_4.15.0-20.21_i386.deb"
dpkg-deb -x linux-modules.deb mods/
cp mods/lib/modules/4.15.0-20-generic/kernel/drivers/input/mouse/psmouse.ko rootfs/lib/modules/

# 4. warm caches inside the i386 chroot (host runs i386 via ia32 emulation)
chroot rootfs /sbin/ldconfig
chroot rootfs /usr/bin/fc-cache -f
chroot rootfs /usr/lib/i386-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders --update-cache
chroot rootfs /usr/bin/gtk-update-icon-cache -f /usr/share/icons/hicolor
chroot rootfs /usr/bin/gtk-update-icon-cache -f /usr/share/icons/Adwaita

# 5. prune what a demo never touches
rm -rf rootfs/usr/share/locale rootfs/usr/share/doc rootfs/usr/share/man \
       rootfs/usr/share/info rootfs/usr/share/poppler rootfs/usr/share/ghostscript \
       rootfs/usr/share/icons/Humanity* rootfs/usr/share/icons/ubuntu-mono-* \
       rootfs/usr/lib/python2.7 rootfs/usr/bin/python*
chroot rootfs /sbin/ldconfig

# 6. kernel + ext2 image + single-file HTML
[ -f linux-image.deb ] || curl -s -o linux-image.deb "$M/pool/main/l/linux/linux-image-4.15.0-20-generic_4.15.0-20.21_i386.deb"
dpkg-deb -x linux-image.deb kern/
SZ=$(du -sm rootfs | cut -f1)
mke2fs -q -t ext2 -d rootfs -b 4096 -m 0 -F disk.img $((SZ + SZ/8 + 20))M
python3 ../../oxwasm.py build --kernel kern/boot/vmlinuz-4.15.0-20-generic disk.img \
  --cmdline "root=/dev/sda rw rootwait init=/sbin/oxinit console=ttyS0" \
  --memory 512 --title "oxwasm — GIMP in a file" -o ../../gimp.html
