# Proof assets for openclaw/openclaw#120414

Before/after real-process behavior proof: the same harness run first on upstream `main` at the PR base commit `8adb6ebf5f631cbbd59a6edede8fb8df56d8514f`, then on PR head `d85e6cac256bc945032ef5357789e2908ca58949`, in one recording.

- `proof-before-after-v3.cast`: asciinema 3.2.1 recording of `proof-driver.sh`: the harness on the base commit first, then on the PR head.
- `proof-before-after-v3.gif`: the same recording rendered with agg 1.9.0 (JetBrains Mono, OFL).
- `proof-before-after-v3-final-frame.png`: the last frame of that GIF.
- `proof-driver.sh`: prints each command, then runs it, first in a checkout of the base commit, then in the PR checkout. Checkout paths are redacted as `<base-checkout>` and `<pr-checkout>`.
- `proof.mts`: copied to `scripts/__proof.mts` in the checkout; imports `createExecTool`, `createProcessTool`, and `waitForExecScope` from `src/` unmodified, spawns a real child with `background: true`, reads its log at once, then polls its terminal outcome. No exec or process mocks.

The child waits 500 ms, prints `WORK_STARTED`, and exits with code 7. Session and pid are redacted in the printed exec line.

On the base commit the running result reads `Command still running (...). Use process (...) for follow-up.` while the immediate log is already empty and the child later exits 7. On the PR head the same result carries the new text (what running means, what it does not, and that a completion turn may not be allowed to message the user) before the follow-up sentence. Everything else in both runs is identical.
