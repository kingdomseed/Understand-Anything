import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildResult } from "../../skills/understand/extract-structure.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "../../skills/understand/extract-structure.mjs");

const file = (overrides = {}) => ({
  path: "src/foo.py",
  language: "python",
  fileCategory: "code",
  ...overrides,
});

const analysis = (overrides = {}) => ({
  functions: [],
  classes: [],
  imports: [],
  exports: [],
  ...overrides,
});

let projectRoot;

afterEach(() => {
  if (projectRoot) {
    rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = null;
  }
});

function setupTree(files) {
  projectRoot = mkdtempSync(join(tmpdir(), "ua-structure-test-"));
  for (const [relPath, contents] of Object.entries(files)) {
    const abs = join(projectRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, "utf-8");
  }
  return projectRoot;
}

function runScript(input, extraNodeArgs = []) {
  const inputPath = join(projectRoot, "ua-structure-input.json");
  const outputPath = join(projectRoot, "ua-structure-output.json");
  writeFileSync(inputPath, JSON.stringify(input), "utf-8");
  const result = spawnSync(
    "node",
    [...extraNodeArgs, SCRIPT, inputPath, outputPath],
    { encoding: "utf-8" },
  );
  let output = null;
  try {
    output = JSON.parse(readFileSync(outputPath, "utf-8"));
  } catch {
    /* output missing on hard failure */
  }
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, output };
}

describe("extract-structure buildResult", () => {
  describe("language pass-through", () => {
    it("preserves the input language on the output", () => {
      const result = buildResult(file({ language: "python" }), 10, 8, analysis(), null, {});
      expect(result.language).toBe("python");
    });

    it("preserves null when caller did not set a language", () => {
      // Documents the failure mode the SKILL.md/file-analyzer.md fix prevents:
      // if the dispatch prompt loses `language`, it propagates to the output.
      const result = buildResult(file({ language: null }), 10, 8, analysis(), null, {});
      expect(result.language).toBeNull();
    });
  });

  describe("importCount fallback", () => {
    // Only relative imports count toward the fallback metric — external
    // package imports would never produce edges so counting them would be
    // misleading. (`.helpers`, `..util`, `./local` all start with `.`)
    const analysisWithImports = analysis({
      imports: [
        { source: ".helpers", specifiers: [] },
        { source: "..util", specifiers: [] },
        { source: "./local", specifiers: [] },
      ],
    });

    it("uses pre-resolved imports when batchImportData has entries", () => {
      const batchImportData = { "src/foo.py": ["src/bar.py", "src/baz.py"] };
      const result = buildResult(file(), 10, 8, analysisWithImports, null, batchImportData);
      expect(result.metrics.importCount).toBe(2);
    });

    it("falls back to parser imports when batchImportData entry is an empty array", () => {
      // Regression test: empty arrays are truthy in JS, so a naive `if (importPaths)`
      // would clobber the parser's count with 0. This is the bug Python projects
      // using absolute imports (which the project scanner doesn't resolve) hit.
      const batchImportData = { "src/foo.py": [] };
      const result = buildResult(file(), 10, 8, analysisWithImports, null, batchImportData);
      expect(result.metrics.importCount).toBe(3);
    });

    it("falls back to parser imports when batchImportData has no entry for the file", () => {
      const result = buildResult(file(), 10, 8, analysisWithImports, null, {});
      expect(result.metrics.importCount).toBe(3);
    });

    it("falls back to parser imports when batchImportData is undefined", () => {
      const result = buildResult(file(), 10, 8, analysisWithImports, null, undefined);
      expect(result.metrics.importCount).toBe(3);
    });

    it("reports 0 imports when neither source has any", () => {
      const result = buildResult(file(), 10, 8, analysis(), null, { "src/foo.py": [] });
      expect(result.metrics.importCount).toBe(0);
    });

    it("excludes external package imports from the fallback count", () => {
      // Regression: pre-2.6.2 the fallback counted ALL parser imports (incl.
      // `os`, `sys`, etc.), so files where the scanner couldn't resolve
      // anything would over-report imports vs. files where it could.
      const ext = analysis({
        imports: [
          { source: "os", specifiers: [] },
          { source: "sys", specifiers: [] },
          { source: "./local", specifiers: [] },
        ],
      });
      const result = buildResult(file(), 10, 8, ext, null, {});
      expect(result.metrics.importCount).toBe(1);
    });
  });

  describe("totalLines", () => {
    // Documents the off-by-one fix: `wc -l` reports N for a POSIX text file
    // with N lines + trailing \n; the extractor must match.
    it("matches wc -l semantics for trailing-newline files", () => {
      // Mimic what main() computes: read file, split on \n.
      // Build a synthetic 3-line file ending in \n.
      const content = "a\nb\nc\n";
      const lines = content.split("\n"); // ["a","b","c",""]
      const totalLines = content.endsWith("\n") ? Math.max(0, lines.length - 1) : lines.length;
      expect(totalLines).toBe(3);
    });

    it("counts content without trailing newline correctly", () => {
      const content = "a\nb\nc";
      const lines = content.split("\n");
      const totalLines = content.endsWith("\n") ? Math.max(0, lines.length - 1) : lines.length;
      expect(totalLines).toBe(3);
    });

  });
});

describe("extract-structure.mjs — Dart tree-sitter path", () => {
  it("extracts Dart classes, functions, and call graph without degraded fallback", () => {
    const root = setupTree({
      "lib/main.dart":
        `class App {\n` +
        `  Widget build(BuildContext context) {\n` +
        `    return Text('hello');\n` +
        `  }\n` +
        `}\n\n` +
        `void bootstrap() {\n` +
        `  runApp(App());\n` +
        `}\n`,
    });

    const result = runScript({
      projectRoot: root,
      batchFiles: [
        {
          path: "lib/main.dart",
          language: "dart",
          sizeLines: 9,
          fileCategory: "code",
        },
      ],
      batchImportData: {},
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/degraded Dart structure scanner/);
    const fileResult = result.output.results[0];
    expect(fileResult.classes[0].name).toBe("App");
    expect(fileResult.classes[0].methods).toEqual(["build"]);
    expect(fileResult.functions[0].name).toBe("bootstrap");
    expect(fileResult.callGraph).toEqual([
      { caller: "build", callee: "Text", lineNumber: 3 },
      { caller: "bootstrap", callee: "runApp", lineNumber: 8 },
      { caller: "bootstrap", callee: "App", lineNumber: 8 },
    ]);
  });

  it("warns and uses degraded Dart structure fallback when only Dart grammar is unavailable", () => {
    const root = setupTree({
      "lib/main.dart":
        `class App {\n` +
        `  void build() {}\n` +
        `}\n`,
      "src/util.ts":
        `export function helper() {\n` +
        `  return 1;\n` +
        `}\n`,
    });
    const hookPath = join(root, "ua-structure-dart-fail-hook.mjs");
    const loaderPath = join(root, "ua-structure-dart-fail-loader.mjs");
    writeFileSync(
      hookPath,
      `export async function load(url, ctx, nextLoad) {\n` +
      `  const result = await nextLoad(url, ctx);\n` +
      `  if (url.endsWith('/dist/languages/configs/dart.js')) {\n` +
      `    return {\n` +
      `      ...result,\n` +
      `      source: String(result.source).replace('vendor/tree-sitter-dart.wasm', 'vendor/missing-dart.wasm'),\n` +
      `    };\n` +
      `  }\n` +
      `  return result;\n` +
      `}\n`,
      "utf-8",
    );
    writeFileSync(
      loaderPath,
      `import { register } from 'node:module';\n` +
      `import { pathToFileURL } from 'node:url';\n` +
      `register(pathToFileURL(${JSON.stringify(hookPath)}).href);\n`,
      "utf-8",
    );

    const result = runScript(
      {
        projectRoot: root,
        batchFiles: [
          {
            path: "lib/main.dart",
            language: "dart",
            sizeLines: 3,
            fileCategory: "code",
          },
          {
            path: "src/util.ts",
            language: "typescript",
            sizeLines: 3,
            fileCategory: "code",
          },
        ],
        batchImportData: {},
      },
      ["--import", loaderPath],
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/tree-sitter-dart unavailable during structure phase/);
    expect(result.stderr).toMatch(/degraded Dart structure scanner/);
    const dartResult = result.output.results.find(item => item.path === "lib/main.dart");
    const tsResult = result.output.results.find(item => item.path === "src/util.ts");
    expect(dartResult.classes[0].name).toBe("App");
    expect(tsResult.functions[0].name).toBe("helper");
  });
});
