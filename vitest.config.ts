import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      // The worker/node entrypoints are I/O bootstrap wiring exercised via integration
      // and manual runs; the testable logic lives in the modules below.
      exclude: ["src/node/index.ts", "src/worker/index.ts"],
      thresholds: {
        // Headline metrics gated at 95%+; branches at 85% (much of the remainder is defensive
        // optional-chaining / null-coalescing that can't be meaningfully exercised).
        lines: 95,
        functions: 95,
        branches: 85,
        statements: 95,
      },
    },
  },
});
