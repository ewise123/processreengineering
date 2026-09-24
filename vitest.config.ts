import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    // Mirror the `@/*` -> `src/*` path mapping from tsconfig.json. Until now
    // every test imported by relative path, so Vite never had to resolve it;
    // api-delete.test.ts is the first to pull in a module (api.ts) that uses
    // the alias internally.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
