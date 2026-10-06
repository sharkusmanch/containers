// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "web-static/**",
      "coverage/**",
      "node_modules/**",
      "eslint.config.js",
      "scripts/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // This code deliberately uses await-less async functions to satisfy async interfaces.
      "@typescript-eslint/require-await": "off",
      // The only place that logs is the entry point.
      "no-console": "error",
    },
  },
  {
    files: ["test/**/*.ts", "eslint.config.js", "src/server/index.ts"],
    rules: { "no-console": "off" },
  },
);
