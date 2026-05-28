import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
import { getStringValue, traverse } from "./base-extractor.js";

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

/**
 * Dart extractor for tree-sitter structural analysis.
 *
 * Slice 1 intentionally limits this to import-like directives. Later slices
 * add declarations and call graph extraction once the grammar path is proven
 * end-to-end.
 */
export class DartExtractor implements LanguageExtractor {
  readonly languageIds = ["dart"];

  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis {
    const imports: StructuralAnalysis["imports"] = [];

    traverse(rootNode, (node) => {
      if (
        node.type !== "library_import" &&
        node.type !== "library_export" &&
        node.type !== "part_directive"
      ) {
        return;
      }

      for (const source of extractDirectiveSources(node)) {
        imports.push({
          source,
          specifiers: [],
          lineNumber: node.startPosition.row + 1,
        });
      }
    });

    return {
      functions: [],
      classes: [],
      imports,
      exports: [],
    };
  }

  extractCallGraph(_rootNode: TreeSitterNode): CallGraphEntry[] {
    return [];
  }
}
