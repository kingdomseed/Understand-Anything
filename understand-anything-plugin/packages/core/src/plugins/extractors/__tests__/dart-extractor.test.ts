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
    expect(result.exports).toEqual([
      { name: "src/public.dart", lineNumber: 6 },
    ]);

    tree.delete();
    parser.delete();
  });

  it("extracts Dart declarations, members, and public exports", () => {
    const { tree, parser, root } = parse(`
abstract class CounterWidget extends StatelessWidget {
  const CounterWidget({super.key, required this.count});
  final int count;
  String get label => 'Count: $count';
  set debugLabel(String value) {}
  Widget build(BuildContext context) {
    return Text(label);
  }
}

mixin Logger {
  void log(String message) { print(message); }
}

enum Mode { easy, hard }

extension ModeX on Mode {
  bool get isHard => this == Mode.hard;
}

Future<int> loadCount(String id, {bool cached = true}) async {
  final count = await fetchCount(id);
  return normalize(count);
}

int _privateTopLevel() => 1;
`);

    const result = extractor.extractStructure(root);

    expect(result.classes.map((cls) => cls.name)).toEqual([
      "CounterWidget",
      "Logger",
      "Mode",
      "ModeX",
    ]);
    expect(result.classes[0].methods).toEqual([
      "CounterWidget",
      "get label",
      "set debugLabel",
      "build",
    ]);
    expect(result.classes[0].properties).toEqual(["count"]);
    expect(result.classes[1].methods).toEqual(["log"]);
    expect(result.classes[2].properties).toEqual(["easy", "hard"]);
    expect(result.classes[3].methods).toEqual(["get isHard"]);

    expect(result.functions).toEqual([
      {
        name: "loadCount",
        lineRange: [22, 25],
        params: ["id", "cached"],
        returnType: "Future<int>",
      },
      {
        name: "_privateTopLevel",
        lineRange: [27, 27],
        params: [],
        returnType: "int",
      },
    ]);

    expect(result.exports.map((exp) => exp.name)).toEqual([
      "CounterWidget",
      "Logger",
      "Mode",
      "ModeX",
      "loadCount",
    ]);

    tree.delete();
    parser.delete();
  });

  it("extracts basic Dart call relationships", () => {
    const { tree, parser, root } = parse(`
class CounterWidget {
  Widget build(BuildContext context) {
    return Text(formatLabel());
  }
}

Future<int> loadCount(String id) async {
  final count = await repository.fetchCount(id);
  return normalize(count);
}
`);

    const calls = extractor.extractCallGraph(root);

    expect(calls).toEqual([
      { caller: "build", callee: "Text", lineNumber: 4 },
      { caller: "build", callee: "formatLabel", lineNumber: 4 },
      { caller: "loadCount", callee: "repository.fetchCount", lineNumber: 9 },
      { caller: "loadCount", callee: "normalize", lineNumber: 10 },
    ]);

    tree.delete();
    parser.delete();
  });

  it("extracts top-level accessors, operators, and enhanced enum members", () => {
    const { tree, parser, root } = parse(`
String get title => formatTitle();
set title(String value) { saveTitle(value); }

class Value {
  bool operator ==(Object other) => other is Value;
  Value operator +(Value other) => combine(other);
}

enum Status {
  ready(1), failed(2);
  const Status(this.code);
  final int code;
  bool get isReady => this == Status.ready;
}
`);

    const result = extractor.extractStructure(root);

    expect(result.functions).toEqual([
      {
        name: "get title",
        lineRange: [2, 2],
        params: [],
        returnType: "String",
      },
      {
        name: "set title",
        lineRange: [3, 3],
        params: ["value"],
        returnType: undefined,
      },
    ]);
    expect(result.classes.find((cls) => cls.name === "Value")?.methods).toEqual([
      "operator ==",
      "operator +",
    ]);
    expect(result.classes.find((cls) => cls.name === "Status")).toMatchObject({
      methods: ["Status", "get isReady"],
      properties: ["ready", "failed", "code"],
    });
    expect(result.exports.map((exp) => exp.name)).toEqual([
      "get title",
      "set title",
      "Value",
      "Status",
    ]);

    const calls = extractor.extractCallGraph(root);

    expect(calls).toEqual([
      { caller: "get title", callee: "formatTitle", lineNumber: 2 },
      { caller: "set title", callee: "saveTitle", lineNumber: 3 },
      { caller: "operator +", callee: "combine", lineNumber: 7 },
    ]);

    tree.delete();
    parser.delete();
  });

  it("keeps extracting recoverable declarations from malformed Dart", () => {
    const { tree, parser, root } = parse(`
class ValidBefore {}

class Broken { int x = ; }
class ValidAfter {
  int value = 1;
}
`);

    const result = extractor.extractStructure(root);

    expect(result.classes.map((cls) => cls.name)).toContain("ValidBefore");
    expect(result.classes.map((cls) => cls.name)).toContain("ValidAfter");

    tree.delete();
    parser.delete();
  });
});
