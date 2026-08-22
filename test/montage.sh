#!/bin/sh
# montage.sh RAW.webm INTRO_END FAST_END OUT.webm
# realtime intro, 8x through the boot, realtime once GIMP is up.
set -e
FF=/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux
RAW=$1; T1=$2; T2=$3; OUT=$4
$FF -y -i "$RAW" -filter_complex "
[0:v]trim=0:$T1,setpts=PTS-STARTPTS[a];
[0:v]trim=$T1:$T2,setpts=(PTS-STARTPTS)/8[b];
[0:v]trim=$T2,setpts=PTS-STARTPTS[c];
[a][b][c]concat=n=3:v=1:a=0[v]" -map "[v]" -c:v libvpx -b:v 1.5M -an "$OUT"
