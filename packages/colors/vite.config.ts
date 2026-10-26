import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    rolldownOptions: {
      external: ["picocolors"],
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
