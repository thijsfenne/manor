import { configDefaults, defineConfig } from 'vitest/config'
import base from './vitest.config'

/**
 * A reviewer's probe tests in the gitignored `test/.review/`:
 * `pnpm exec vitest run --config vitest.review.config.ts`. The default suite skips them.
 */
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['test/.review/**/*.test.ts'], exclude: configDefaults.exclude },
})
