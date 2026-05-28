import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
import { findChildren, getStringValue, traverse } from "./base-extractor.js";

const BLOCKED_CALLERS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
]);

function findFirstDescendant(
  node: TreeSitterNode,
  type: string,
): TreeSitterNode | null {
  if (node.type === type) return node;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const found = findFirstDescendant(child, type);
    if (found) return found;
  }
  return null;
}

function collectDescendants(
  node: TreeSitterNode,
  type: string,
  out: TreeSitterNode[] = [],
): TreeSitterNode[] {
  if (node.type === type) out.push(node);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) collectDescendants(child, type, out);
  }
  return out;
}

function extractDirectiveSources(node: TreeSitterNode): string[] {
  const sources: string[] = [];
  for (const uri of collectDescendants(node, "uri")) {
    const stringLiteral = findFirstDescendant(uri, "string_literal");
    if (stringLiteral) {
      sources.push(getStringValue(stringLiteral));
    }
  }
  return sources;
}

function directIdentifierChildren(node: TreeSitterNode): TreeSitterNode[] {
  const out: TreeSitterNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === "identifier") out.push(child);
  }
  return out;
}

function isPublic(name: string): boolean {
  return name.length > 0 && !name.startsWith("_");
}

function functionName(signature: TreeSitterNode): string | null {
  const operator = findFirstDescendant(signature, "operator_signature");
  if (operator) {
    const symbol = findFirstDescendant(operator, "binary_operator") ??
      findFirstDescendant(operator, "unary_operator") ??
      findFirstDescendant(operator, "assignable_operator");
    return symbol ? `operator ${symbol.text}` : "operator";
  }

  if (
    signature.type === "constructor_signature" ||
    signature.type === "constant_constructor_signature" ||
    signature.type === "factory_constructor_signature"
  ) {
    const params = findFirstDescendant(signature, "formal_parameter_list");
    const ids = collectDescendants(signature, "identifier")
      .filter((n) => !params || n.endIndex <= params.startIndex)
      .map((n) => n.text);
    if (ids.length >= 2) return `${ids[0]}.${ids[1]}`;
    return ids[0] ?? null;
  }

  const getter = findFirstDescendant(signature, "getter_signature");
  if (getter) {
    return directIdentifierChildren(getter).at(-1)?.text ?? null;
  }

  const setter = findFirstDescendant(signature, "setter_signature");
  if (setter) {
    return directIdentifierChildren(setter).at(-1)?.text ?? null;
  }

  const factory = findFirstDescendant(signature, "factory_constructor_signature");
  if (factory) {
    return functionName(factory);
  }

  const functionSig =
    signature.type === "function_signature"
      ? signature
      : findFirstDescendant(signature, "function_signature");
  if (functionSig) {
    return directIdentifierChildren(functionSig).at(-1)?.text ?? null;
  }

  return directIdentifierChildren(signature).at(-1)?.text ?? null;
}

function functionFingerprintName(signature: TreeSitterNode): string | null {
  const name = functionName(signature);
  if (!name) return null;
  if (findFirstDescendant(signature, "getter_signature")) return `get ${name}`;
  if (findFirstDescendant(signature, "setter_signature")) return `set ${name}`;
  return name;
}

function publicName(name: string): string {
  return name.replace(/^(?:get|set)\s+/, "");
}

function returnType(signature: TreeSitterNode): string | undefined {
  const name = functionName(signature);
  if (!name || name.includes(".")) return undefined;

  const nameNode = directIdentifierChildren(signature).at(-1);
  if (!nameNode) return undefined;

  const prefix = signature.text
    .slice(0, Math.max(0, nameNode.startIndex - signature.startIndex))
    .replace(/\b(static|external|abstract|covariant)\b/g, "")
    .replace(/\b(get|set)\s*$/g, "")
    .trim();

  return prefix.length > 0 ? prefix : undefined;
}

function parameterName(param: TreeSitterNode): string | null {
  const ids = collectDescendants(param, "identifier");
  return ids.at(-1)?.text ?? null;
}

function extractParams(signature: TreeSitterNode): string[] {
  const list = findFirstDescendant(signature, "formal_parameter_list");
  if (!list) return [];

  const params: string[] = [];
  for (const param of collectDescendants(list, "formal_parameter")) {
    const name = parameterName(param);
    if (name) params.push(name);
  }
  return params;
}

function functionLineRange(
  signature: TreeSitterNode,
  body: TreeSitterNode | null,
): [number, number] {
  return [
    signature.startPosition.row + 1,
    (body ?? signature).endPosition.row + 1,
  ];
}

function declarationName(node: TreeSitterNode): string | null {
  return directIdentifierChildren(node)[0]?.text ?? null;
}

function bodyForDeclaration(node: TreeSitterNode): TreeSitterNode | null {
  return (
    findChildren(node, "class_body")[0] ??
    findChildren(node, "enum_body")[0] ??
    findChildren(node, "extension_body")[0] ??
    null
  );
}

function fieldNames(declaration: TreeSitterNode): string[] {
  const names: string[] = [];
  const initialized = [
    ...collectDescendants(declaration, "initialized_identifier"),
    ...collectDescendants(declaration, "static_final_declaration"),
  ];

  for (const node of initialized) {
    const id = directIdentifierChildren(node)[0];
    if (id) names.push(id.text);
  }

  return [...new Set(names)];
}

function memberSignatureName(node: TreeSitterNode): string | null {
  const constructor =
    findFirstDescendant(node, "constant_constructor_signature") ??
    findFirstDescendant(node, "constructor_signature");
  if (constructor) return functionName(constructor);

  if (node.type === "method_signature") return functionFingerprintName(node);
  return null;
}

function hasArgumentPart(node: TreeSitterNode): boolean {
  return findFirstDescendant(node, "argument_part") !== null;
}

function previousSibling(parent: TreeSitterNode, index: number): TreeSitterNode | null {
  for (let i = index - 1; i >= 0; i--) {
    const child = parent.child(i);
    if (child && child.type !== "," && child.type !== ";") return child;
  }
  return null;
}

function callCallee(parent: TreeSitterNode, selectorIndex: number): string | null {
  const argSelector = parent.child(selectorIndex);
  if (!argSelector || argSelector.type !== "selector" || !hasArgumentPart(argSelector)) {
    return null;
  }

  const previous = previousSibling(parent, selectorIndex);
  if (!previous) return null;

  if (previous.type === "selector" && previous.text.startsWith(".")) {
    const base = previousSibling(parent, selectorIndex - 1);
    if (base) return `${base.text}${previous.text}`;
  }

  if (previous.type === "identifier" || previous.type === "type_identifier") {
    return previous.text;
  }

  return null;
}

/**
 * Dart extractor for tree-sitter structural analysis.
 */
export class DartExtractor implements LanguageExtractor {
  readonly languageIds = ["dart"];

  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis {
    const functions: StructuralAnalysis["functions"] = [];
    const classes: StructuralAnalysis["classes"] = [];
    const imports: StructuralAnalysis["imports"] = [];
    const exports: StructuralAnalysis["exports"] = [];

    traverse(rootNode, (node) => {
      if (node.type === "library_export") {
        for (const source of extractDirectiveSources(node)) {
          imports.push({
            source,
            specifiers: [],
            lineNumber: node.startPosition.row + 1,
          });
          exports.push({
            name: source,
            lineNumber: node.startPosition.row + 1,
          });
        }
        return;
      }

      if (node.type === "library_import" || node.type === "part_directive") {
        for (const source of extractDirectiveSources(node)) {
          imports.push({
            source,
            specifiers: [],
            lineNumber: node.startPosition.row + 1,
          });
        }
      }
    });

    for (let i = 0; i < rootNode.childCount; i++) {
      const node = rootNode.child(i);
      if (!node) continue;

      if (node.type === "function_signature") {
        this.extractTopLevelFunction(node, rootNode.child(i + 1), functions, exports);
      } else if (node.type === "getter_signature" || node.type === "setter_signature") {
        this.extractTopLevelFunction(node, rootNode.child(i + 1), functions, exports);
      } else if (
        node.type === "class_definition" ||
        node.type === "mixin_declaration" ||
        node.type === "enum_declaration" ||
        node.type === "extension_declaration"
      ) {
        this.extractTypeDeclaration(node, classes, exports);
      }
    }

    return {
      functions,
      classes,
      imports,
      exports,
    };
  }

  extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[] {
    const entries: CallGraphEntry[] = [];

    for (let i = 0; i < rootNode.childCount; i++) {
      const node = rootNode.child(i);
      if (!node) continue;

      if (node.type === "function_signature") {
        const name = functionFingerprintName(node);
        const body = rootNode.child(i + 1);
        if (name && body?.type === "function_body") {
          this.extractCallsFromBody(body, name, entries);
        }
      } else if (node.type === "getter_signature" || node.type === "setter_signature") {
        const name = functionFingerprintName(node);
        const body = rootNode.child(i + 1);
        if (name && body?.type === "function_body") {
          this.extractCallsFromBody(body, name, entries);
        }
      } else if (
        node.type === "class_definition" ||
        node.type === "mixin_declaration" ||
        node.type === "enum_declaration" ||
        node.type === "extension_declaration"
      ) {
        const body = bodyForDeclaration(node);
        if (body) this.extractMemberCalls(body, entries);
      }
    }

    return entries;
  }

  private extractTopLevelFunction(
    signature: TreeSitterNode,
    possibleBody: TreeSitterNode | null,
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const name = functionFingerprintName(signature);
    if (!name || BLOCKED_CALLERS.has(name)) return;

    const body = possibleBody?.type === "function_body" ? possibleBody : null;
    functions.push({
      name,
      lineRange: functionLineRange(signature, body),
      params: extractParams(signature),
      returnType: returnType(signature),
    });

    if (isPublic(publicName(name))) {
      exports.push({
        name,
        lineNumber: signature.startPosition.row + 1,
      });
    }
  }

  private extractTypeDeclaration(
    node: TreeSitterNode,
    classes: StructuralAnalysis["classes"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const name = declarationName(node);
    if (!name) return;

    const body = bodyForDeclaration(node);
    const methods: string[] = [];
    const properties: string[] = [];

    if (body) {
      if (node.type === "enum_declaration") {
        for (const constant of findChildren(body, "enum_constant")) {
          const constantName = directIdentifierChildren(constant)[0];
          if (constantName) properties.push(constantName.text);
        }
      }
      this.extractMembers(body, methods, properties);
    }

    classes.push({
      name,
      lineRange: [
        node.startPosition.row + 1,
        node.endPosition.row + 1,
      ],
      methods: [...new Set(methods)],
      properties: [...new Set(properties)],
    });

    if (isPublic(name)) {
      exports.push({
        name,
        lineNumber: node.startPosition.row + 1,
      });
    }
  }

  private extractMembers(
    body: TreeSitterNode,
    methods: string[],
    properties: string[],
  ): void {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (!child) continue;

      if (child.type === "declaration") {
        const memberName = memberSignatureName(child);
        if (memberName) {
          methods.push(memberName);
        } else {
          properties.push(...fieldNames(child));
        }
      } else if (child.type === "method_signature") {
        const memberName = memberSignatureName(child);
        if (memberName) methods.push(memberName);
      }
    }
  }

  private extractMemberCalls(
    body: TreeSitterNode,
    entries: CallGraphEntry[],
  ): void {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (child?.type !== "method_signature") continue;

      const name = memberSignatureName(child);
      const next = body.child(i + 1);
      if (name && next?.type === "function_body") {
        this.extractCallsFromBody(next, name, entries);
      }
    }
  }

  private extractCallsFromBody(
    body: TreeSitterNode,
    caller: string,
    entries: CallGraphEntry[],
  ): void {
    traverse(body, (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const callee = callCallee(node, i);
        if (callee) {
          entries.push({
            caller,
            callee,
            lineNumber: node.child(i)!.startPosition.row + 1,
          });
        }
      }
    });
  }
}
