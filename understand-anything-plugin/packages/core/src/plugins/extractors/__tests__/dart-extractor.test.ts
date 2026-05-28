import { describe, it, expect, beforeAll } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DartExtractor } from "../dart-extractor.js";

let Parser: any;
let dartLang: any;

beforeAll(async () => {
  const mod = await import("web-tree-sitter");
  Parser = mod.Parser;
  await Parser.init();
  const wasmPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../vendor/tree-sitter-dart.wasm",
  );
  dartLang = await mod.Language.load(wasmPath);
});

function parse(code: string) {
  const parser = new Parser();
  parser.setLanguage(dartLang);
  const tree = parser.parse(code);
  const root = tree.rootNode;
  return { tree, parser, root };
}

describe("DartExtractor", () => {
  const extractor = new DartExtractor();

  it("has correct languageIds", () => {
    expect(extractor.languageIds).toEqual(["dart"]);
  });

  it("extracts import-like directives", () => {
    const { tree, parser, root } = parse(`
import 'dart:async';
import 'package:foo/src/foo.dart' as foo show Foo, Bar;
import '../src/local.dart' hide HiddenThing;
import 'io.dart' if (dart.library.html) 'web.dart';
export 'src/public.dart';
part 'main.g.dart';
`);

    const result = extractor.extractStructure(root);

    expect(result.imports.map((imp) => imp.source)).toEqual([
      "dart:async",
      "package:foo/src/foo.dart",
      "../src/local.dart",
      "io.dart",
      "web.dart",
      "src/public.dart",
      "main.g.dart",
    ]);
    expect(result.imports.every((imp) => imp.specifiers.length === 0)).toBe(true);
    expect(result.imports[0].lineNumber).toBe(2);
    expect(result.functions).toEqual([]);
    expect(result.classes).toEqual([]);
    expect(result.exports).toEqual([]);

    tree.delete();
    parser.delete();
  });
});
