#!/bin/bash
set -e
export GIT_PAGER=cat PAGER=cat
run() { printf '\033[1;32m$ %s\033[0m\n' "$*"; "$@"; echo; }
section() { printf '\n\033[1;33m### %s\033[0m\n' "$*"; }
section "BEFORE: upstream main at the PR base commit"
cd "<base-checkout>"
run git --no-pager log -1 --format='%H %s'
run git --no-pager status --short --untracked-files=no
run node --import ./scripts/tsx.mjs scripts/__proof.mts
section "AFTER: PR head (same harness, same child)"
cd "<pr-checkout>"
run git --no-pager log -1 --format='%H %s'
run git --no-pager status --short --untracked-files=no
run node --import ./scripts/tsx.mjs scripts/__proof.mts
