import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /*
     * Many tests here spawn real processes — PowerShell for DPAPI, git,
     * netsh, sc.exe — and process start-up on a cold CI runner is far slower
     * than on a warm developer machine. Vitest's 5 second default is fine
     * locally and marginal on CI, which is exactly the kind of flakiness that
     * erodes trust in a test suite.
     *
     * Raised globally rather than annotating individual tests, so a new test
     * that happens to spawn something does not fail mysteriously the first
     * time it runs on CI.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,

    /*
     * Several suites create real directory junctions, bind real ports and
     * write to temporary folders. Running files in parallel risks them
     * colliding over the same port range or leaving each other's junctions
     * behind, so they run one file at a time.
     */
    fileParallelism: false,
  },
});
