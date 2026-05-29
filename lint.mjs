// @ts-check
// ESLint flat config (referenced explicitly via `eslint --config lint.mjs`).
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "public/**", "coverage/**", "*.config.*", "lint.mjs"] },

  // TypeScript recommended + security SAST rules.
  ...tseslint.configs.recommended,
  security.configs.recommended,

  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.worker },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },

  // Tests: relax rules that are noise in test code.
  {
    files: ["test/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "security/detect-object-injection": "off",
    },
  },
);
