import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "ua-dart-wasm-"));

try {
  const generatedPath = join(tmp, "tree-sitter-dart.wasm");
  const grammarPath = join(coreRoot, "node_modules/tree-sitter-dart");
  const bin = process.platform === "win32" ? "tree-sitter.cmd" : "tree-sitter";
  const result = spawnSync(
    bin,
    ["build", "--wasm", "--output", generatedPath, grammarPath],
    { cwd: coreRoot, encoding: "utf-8" },
  );

  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  const vendoredPath = join(coreRoot, "vendor/tree-sitter-dart.wasm");
  const generated = readFileSync(generatedPath);
  const vendored = readFileSync(vendoredPath);

  if (!generated.equals(vendored)) {
    process.stderr.write(
      "Vendored Dart tree-sitter WASM is stale. Run " +
      "`pnpm --filter @understand-anything/core build:dart-wasm` " +
      "and commit vendor/tree-sitter-dart.wasm.\n",
    );
    process.exit(1);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
