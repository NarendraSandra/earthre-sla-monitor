import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // PGlite boots a real Postgres WASM engine; cold Windows runners can take
    // several seconds before the first query is ready.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
