import type { LanguageConfig } from "../types.js";

export const dartConfig = {
  id: "dart",
  displayName: "Dart",
  extensions: [".dart"],
  treeSitter: {
    wasmPackage: "tree-sitter-dart",
    wasmFile: "tree-sitter-dart.wasm",
    // tree-sitter-dart@1.0.0 ships a WASM artifact that does not load with
    // web-tree-sitter@0.26.x. This vendored file is rebuilt with the pinned
    // tree-sitter-cli version in package.json and smoke-tested in CI.
    wasmPath: "vendor/tree-sitter-dart.wasm",
  },
  concepts: [
    "Flutter widgets",
    "Bloc state management",
    "Dart libraries",
    "package imports",
    "part files",
    "mixins",
    "extensions",
    "async streams",
  ],
  filePatterns: {
    entryPoints: ["lib/main.dart", "lib/main_*.dart", "bin/*.dart"],
    barrels: ["lib/*.dart"],
    tests: ["*_test.dart", "test/**/*.dart"],
    config: ["pubspec.yaml", "analysis_options.yaml"],
  },
} satisfies LanguageConfig;
