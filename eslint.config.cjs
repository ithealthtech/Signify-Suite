"use strict";

const shared = {
  ecmaVersion: 2023,
  sourceType: "script",
};

module.exports = [
  {
    ignores: ["node_modules/**", "dist/**", "data/**", "tmp/**", "backups/**"],
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      ...shared,
      globals: {
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortSignal: "readonly",
        AbortController: "readonly",
        DOMException: "readonly",
        console: "readonly",
        process: "readonly",
        require: "readonly",
        module: "readonly",
        __dirname: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        fetch: "readonly",
      },
    },
    rules: {
      "no-constant-condition": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-undef": "error",
    },
  },
  {
    files: ["admin.js", "signature.js"],
    languageOptions: {
      ...shared,
      globals: {
        Blob: "readonly",
        AbortController: "readonly",
        ClipboardItem: "readonly",
        FileReader: "readonly",
        FormData: "readonly",
        Image: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        btoa: "readonly",
        clearTimeout: "readonly",
        confirm: "readonly",
        document: "readonly",
        fetch: "readonly",
        history: "readonly",
        location: "readonly",
        navigator: "readonly",
        prompt: "readonly",
        setTimeout: "readonly",
        structuredClone: "readonly",
        window: "readonly",
      },
    },
    rules: {
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-undef": "error",
    },
  },
];
