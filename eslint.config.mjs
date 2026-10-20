import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 根目录那些一次性探针（起 headless Edge、造数据、量包体）不是源码，
    // 让它们进 lint 报告只会把真正需要盯的问题稀释掉。
    "**/*.tmp.mjs",
  ]),
]);

export default eslintConfig;
