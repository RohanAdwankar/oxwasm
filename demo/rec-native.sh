#!/bin/bash
# Record native GIMP launch on Xvfb :99. A white->black root flash marks the
# launch instant for frame-accurate trimming.
S=$1; R=$2; OUT=$3
DISPLAY=:99 xsetroot -solid black
ffmpeg -y -f x11grab -framerate 30 -video_size 1024x768 -i :99 -c:v libx264 \
  -pix_fmt yuv420p -preset ultrafast "$OUT" >/dev/null 2>&1 &
FF=$!
sleep 1.5
DISPLAY=:99 xsetroot -solid white          # marker frame
sleep 0.15
DISPLAY=:99 xsetroot -solid black
t_launch=$(date +%s.%N)
chroot $R /bin/sh -c 'DISPLAY=:99 HOME=/root exec /usr/bin/gimp' >/dev/null 2>&1 &
DISPLAY=:99 xdotool search --sync --onlyvisible --name "GNU Image" >/dev/null 2>&1
t_map=$(date +%s.%N)
sleep 3.5
kill -INT $FF; wait $FF 2>/dev/null
pkill -x gimp; pkill -x gimp-2.8
echo "MAP_SECONDS=$(echo "scale=2; $t_map - $t_launch" | bc)"
