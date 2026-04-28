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
    // Static prototype workspace served from public/. Uses Babel-in-browser JSX
    // and isn't part of the Next.js build, so we ignore it for linting.
    "public/poet-workspace/src/**",
  ]),
]);

export default eslintConfig;
