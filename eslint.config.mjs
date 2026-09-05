import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/",
      "**/.wrangler/",
      "**/dist/",
      "**/coverage/",
    ],
  },
  {
    files: ["src/**/*.js", "test/**/*.js", "outage-gate/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.worker,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "preserve-caught-error": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "preserve-caught-error": "error",
    },
  },
];
