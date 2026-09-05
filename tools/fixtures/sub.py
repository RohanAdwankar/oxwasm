# subprocess: posix_spawn/vfork + exec, stdout captured through a pipe, wait
import subprocess
r = subprocess.run(['/usr/bin/echo', 'hi'], capture_output=True)
print(r.returncode, r.stdout)
r = subprocess.run(['/bin/sh', '-c', 'exit 7'])
print(r.returncode)
