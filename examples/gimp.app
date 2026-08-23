# GIMP — the flagship test case. Nothing here is special-cased in the tool;
# it's just a package name and a command.
PACKAGES="gimp"
RUN="gimp"
WM="matchbox-window-manager -use_titlebar yes"
TITLE="oxwasm — GIMP in a file"
MEMORY=512
# freeze GIMP's 184-plugin query into the image (native ~4s here vs minutes
# of emulated process spawns on every browser boot)
WARM="gimp -i -d -f -s --batch '(gimp-quit 0)'"
