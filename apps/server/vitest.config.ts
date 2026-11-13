import { configDefaults, defineConfig } from 'vitest/config'

/**
 * `setupFiles`, and review probes left out: they run only through
 * vitest.review.config.ts. The 20 s test timeout is for the pre-commit hook and for
 * machines shared with other Sessions: file-listing and git tests that finish in
 * under a second idle hit vitest's 5 s default at load 50.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    setupFiles: ['./test/setup.ts'],
    exclude: [...configDefaults.exclude, '**/.review/**'],
  },
})
