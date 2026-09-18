# Proof assets for openclaw/openclaw#120414

Real-process behavior proof recorded on PR head `4dc8d2969e3dcac70d50b420014f2b88dc2c45c2`.

- `proof.cast`: asciinema 3.2.1 recording of `proof-driver.sh` run inside the PR checkout.
- `proof.gif`: the same recording rendered with agg 1.9.0 (JetBrains Mono, OFL).
- `proof-final-frame.png`: the last frame of that GIF.
- `proof-driver.sh`: prints each command, then runs it.
- `proof.mts`: copied to `scripts/__proof.mts` in the checkout; imports `createExecTool`, `createProcessTool`, and `waitForExecScope` from `src/` unmodified, spawns a real child with `background: true`, reads its log at once, then polls its terminal outcome. No exec or process mocks.

The child waits 500 ms, prints `WORK_STARTED`, and exits with code 7. Session and pid are redacted in the printed exec line.
