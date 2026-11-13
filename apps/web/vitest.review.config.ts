import { configDefaults, defineConfig } from 'vitest/config'
import base from './vite.config'

/**
 * A reviewer's probe tests in the gitignored `test/.review/`, with the app's plugins:
 * `pnpm exec vitest run --config vitest.review.config.ts`. The default suite skips them.
 */
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['test/.review/**/*.test.{ts,tsx}'], exclude: configDefaults.exclude },
})
