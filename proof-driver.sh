#!/bin/bash
set -e
export GIT_PAGER=cat PAGER=cat
run() { printf '\033[1;32m$ %s\033[0m\n' "$*"; "$@"; echo; }
run git --no-pager log -1 --format='%H %s'
run git --no-pager status --short --untracked-files=no
run node --import ./scripts/tsx.mjs scripts/__proof.mts
