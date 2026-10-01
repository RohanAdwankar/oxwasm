#!/bin/sh
# Assemble the GitHub Pages site into ./_site:
#   /        landing page (site/index.html)
#   /shell/  the interactive shell (built by tools/shellpage.mjs; needs busybox-static)
#   /gimp/   the GIMP demo (demo/gimp, served as is)
set -eu
cd "$(dirname "$0")/.."
rm -rf _site && mkdir -p _site/shell _site/gimp
cp site/index.html _site/index.html
node tools/shellpage.mjs -o _site/shell/index.html
cp demo/gimp/* _site/gimp/
touch _site/.nojekyll
du -sh _site
