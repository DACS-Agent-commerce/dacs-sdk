// Bug-finding rules only. Style is left out on purpose: reformatting would
// touch most files and clash with open PRs.
// How to run it: tools/lint/README.md.
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const bugRules = {
  ...js.configs.recommended.rules,
  // Cleanup rather than bugs, and noisy on this code.
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-useless-escape": "off",
  "preserve-caught-error": "off",
  // These regexes strip control characters on purpose.
  "no-control-regex": "off",
  "array-callback-return": "error",
  "no-constructor-return": "error",
  "no-self-compare": "error",
  "no-unreachable-loop": "error",
};

export default [
  {
    // Existing comments disable rules this config doesn't load, so don't report those.
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  {
    // test/package-consumer is its own project and needs the packed packages.
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "test/package-consumer/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: bugRules,
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
  },
  {
    // These also send code to a test browser, so both sets of names are real.
    files: ["packages/dacs-client/test/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["packages/dacs-client/src/public/**/*.{js,mjs}"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      ...bugRules,
      // The TypeScript compiler already reports these, with fewer false alarms.
      "no-undef": "off",
      "no-redeclare": "off",
      "no-dupe-class-members": "off",
      "no-unused-vars": "off",
    },
  },
  {
    // Checks that need type information: a missed `await` on money or wallet
    // calls is the mistake we most want caught.
    files: ["src/**/*.ts", "test/**/*.ts", "packages/*/src/**/*.ts", "packages/*/test/**/*.ts"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: repoRoot,
      },
    },
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
];
