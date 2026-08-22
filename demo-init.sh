#!/bin/busybox sh
/bin/busybox mkdir -p /proc /sys /dev /tmp
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
/bin/busybox mount -t devtmpfs devtmpfs /dev 2>/dev/null
/bin/busybox --install -s /bin
/bin/busybox clear
echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │  oxwasm                                         │"
echo "  │  an unmodified Linux kernel + userspace,        │"
echo "  │  executing entirely inside this browser tab     │"
echo "  └─────────────────────────────────────────────────┘"
echo ""
/bin/busybox uname -a
echo ""
exec /bin/busybox setsid /bin/busybox cttyhack /bin/busybox sh
