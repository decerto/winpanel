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
    testTimeout: 60_000,
    hookTimeout: 60_000,

    /*
     * Pays PowerShell's cold-start cost once, before any test runs, instead of
     * charging it to whichever vault test happens to go first. Measured on a
     * cold runner that first start can exceed thirty seconds, while later ones
     * take well under a second.
     */
    globalSetup: ['./test/global-setup.ts'],

    /*
     * File-level parallelism stays on. Serialising was tried and pushed the
     * suite past twenty minutes on CI, which is its own kind of failure: a
     * suite slow enough to skip is a suite nobody runs.
     *
     * Concurrency is capped instead. The runners have two cores, and letting a
     * dozen files spawn PowerShell at once produces timeouts that look like
     * real faults. The tests already avoid colliding by using unique temporary
     * directories and probing ports before binding them.
     */
    maxWorkers: 2,
    minWorkers: 1,
  },
});
