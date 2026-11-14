// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // Metro bundles the whole barrel, about 6,000 icons. `apps/web/test/phoneIconImports.test.ts` enforces it.
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: '@hugeicons/core-free-icons', message: "Import one icon file: '@hugeicons/core-free-icons/<IconName>'." }],
      }],
    },
  },
  {
    ignores: ["dist/*"],
  }
]);
