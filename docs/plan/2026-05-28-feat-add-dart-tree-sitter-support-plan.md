# feat: add first-class Dart tree-sitter support

## Summary

Add Dart to the existing `@understand-anything/core` tree-sitter pipeline so Dart import edges and structure are parsed from a real syntax tree instead of regex-only fallback code. Keep deterministic Dart package import resolution, because tree-sitter extracts import syntax while `pubspec.yaml` package roots provide project-local resolution semantics.

The plan is intentionally split. A config-only change would be misleading: without a Dart extractor, `TreeSitterPlugin.analyzeFile()` can load a Dart grammar and still return empty arrays. The first PR must therefore prove a complete thin path:

```text
.dart source -> tree-sitter-dart parse -> DartExtractor imports -> Dart package resolver -> importMap edge
```

## Current Evidence

- The core parser pipeline already loads WASM grammars from language configs in `understand-anything-plugin/packages/core/src/plugins/tree-sitter-plugin.ts`.
- Built-in languages are registered through `understand-anything-plugin/packages/core/src/languages/configs/index.ts`.
- Language-specific AST mapping lives under `understand-anything-plugin/packages/core/src/plugins/extractors/`.
- Dart currently bypasses tree-sitter:
  - `understand-anything-plugin/skills/understand/extract-import-map.mjs` parses Dart directives with text patterns.
  - `understand-anything-plugin/skills/understand/extract-structure.mjs` falls back to `analyzeDartFile`.
- `tree-sitter-dart@1.0.0` exists on npm and its tarball includes `tree-sitter-dart.wasm`.
- Review agents found a serious compatibility risk: the shipped `tree-sitter-dart.wasm` may not load with the repo's current `web-tree-sitter` version. A compatible WASM may need to be rebuilt with a pinned `tree-sitter-cli`.
- The Dart graph architecture diagnostics depend on accurate `imports` edges, so parser quality directly affects whether the dashboard can distinguish real spaghetti from graph noise.

## Goals

- Parse `.dart` files through `web-tree-sitter` using a compatible `tree-sitter-dart` grammar.
- Make the first implementation slice end-to-end for Dart import edges.
- Preserve project-local Dart import resolution through the existing `pubspec.yaml` package index.
- Move Dart structure extraction to tree-sitter after the import-edge slice is proven.
- Make degraded parsing visible when Dart tree-sitter cannot load.
- Keep dashboard architecture diagnostics consuming graph edges rather than parser internals.

## Non-Goals

- Do not replace Dart package resolution with tree-sitter. AST parsing and package resolution are separate responsibilities.
- Do not add Dart analyzer or `scip_dart` in the tree-sitter implementation PRs.
- Do not regenerate the Mythic graph as part of this plan.
- Do not broaden architecture policy beyond the current VGV/Dart diagnostics in the dashboard.

## Design Principles

### Parser Ownership

The core package owns syntax extraction:

- Add `dartConfig` in `packages/core/src/languages/configs/dart.ts`.
- Add `DartExtractor` in `packages/core/src/plugins/extractors/dart-extractor.ts`.
- Register both in the existing config/extractor indexes.

The skill scripts own orchestration and resolution:

- `extract-import-map.mjs` should consume `registry.analyzeFile(...).imports` for Dart.
- `resolveDartImport(...)` should stay, because it maps `package:<name>/...` to scanned local package paths using `pubspec.yaml`.
- `extract-structure.mjs` should stop using `analyzeDartFile` as the normal path only after tree-sitter structure extraction is implemented.

### Degraded Mode

If `tree-sitter-dart` cannot load:

- Emit a warning that names `tree-sitter-dart`.
- Include the affected phase: import map or structure extraction.
- Include the consequence: degraded Dart graph.
- Continue the scanner without crashing.

Do not silently fall back. If persisted degraded metadata requires schema churn, warning-only is acceptable for the first PR, but it must be explicit in tests or manual verification.

### Authoritative Graph Source

Use tree-sitter as the TypeScript pipeline's syntactic source of truth for Dart. Do not pretend it is semantic Dart analysis. Tree-sitter will not resolve types, conditional imports, SDK availability, or package APIs.

Future semantic work should evaluate Dart Analyzer or `scip_dart`, but that is a follow-up after the current graph has honest syntax-level edges.

## PR Split

### PR 1: Dart Grammar + Import Edge Thin Slice

This is the first buildable slice. It must prove a `.dart` file can produce parsed import edges.

Tasks:

- Prove a compatible Dart grammar WASM can load with the repo's current `web-tree-sitter`.
  - Check whether `tree-sitter-dart/tree-sitter-dart.wasm` loads as shipped.
  - If it does not, add a pinned grammar-build step using `tree-sitter-cli` and document why.
  - Do not wire `dartConfig` until a loadable grammar path is known.
- Add `tree-sitter-dart` to `understand-anything-plugin/packages/core/package.json`.
- Update `pnpm-lock.yaml` from `understand-anything-plugin/`.
- If pnpm requires build approval, update the relevant `pnpm.onlyBuiltDependencies` / approved-builds config in the package context used by the plugin.
- Add `packages/core/src/languages/configs/dart.ts` with:
  - `id: "dart"`
  - `displayName: "Dart"`
  - `extensions: [".dart"]`
  - compatible `treeSitter.wasmPackage`
  - compatible `treeSitter.wasmFile`
  - entrypoint patterns such as `lib/main.dart`, `bin/*.dart`, and Flutter `main_*.dart`
  - test patterns such as `*_test.dart` and `test/**/*.dart`
  - config patterns such as `pubspec.yaml`, `analysis_options.yaml`
- Register `dartConfig` in `packages/core/src/languages/configs/index.ts`.
- Add minimal `DartExtractor` support for import-like directives:
  - `library_import`
  - `library_export`
  - `part_directive`
  - Preserve enough source text/specifiers for `resolveDartImport(...)` to work.
- Register `DartExtractor` in `packages/core/src/plugins/extractors/index.ts`.
- Update `skills/understand/extract-import-map.mjs` so Dart uses `registry.analyzeFile(...).imports`.
- Keep `loadDartPackages(...)` and `resolveDartImport(...)`.
- Demote `extractDartSources(...)` to degraded-only fallback, or leave it unused with a clear TODO if removal is safer in PR 1.
- Make `.dart` explicit in `skills/understand/scan-project.mjs` if it currently falls through implicitly.

Tests:

- `packages/core/src/plugins/extractors/__tests__/dart-extractor.test.ts`
  - parses `import 'package:foo/src/foo.dart';`
  - parses relative import `import '../src/foo.dart';`
  - parses `export 'src/foo.dart';`
  - parses `part 'foo.g.dart';`
  - ignores or clearly classifies `dart:async`
- `packages/core/src/plugins/tree-sitter-plugin.test.ts`
  - proves `.dart` dispatches through `TreeSitterPlugin` and returns Dart imports.
- Skill import-map test, using existing skill test harness if available:
  - local package import resolves through scanned `pubspec.yaml`
  - relative import resolves
  - `dart:` import is skipped
  - `part` behavior is either resolved or intentionally skipped and documented

Verification:

```bash
pnpm --filter @understand-anything/core test
pnpm --filter @understand-anything/core build
pnpm test
pnpm build
git diff --check
```

Acceptance criteria:

- Dart grammar loads under the repo's `web-tree-sitter` version.
- A Dart file's import directives come from tree-sitter, not regex.
- `package:<local_package>/...` imports still resolve through scanned `pubspec.yaml` roots.
- Relative imports still resolve.
- `dart:` imports are not converted into fake project edges.
- If Dart grammar loading fails, the failure is visible and does not masquerade as a successful high-trust graph.

### PR 2: Dart Structure + Call Extraction

Expand `DartExtractor` beyond import edges.

Tasks:

- Extract declarations:
  - `class`
  - `abstract class`
  - `mixin`
  - `enum`
  - `extension`
- Extract top-level functions.
- Extract constructors, methods, getters, setters, and class fields where AST node shapes are stable.
- Extract exports for public top-level declarations and export directives.
- Extract basic call expressions without over-claiming semantic resolution.
- Move `skills/understand/extract-structure.mjs` off `analyzeDartFile(...)` as the normal Dart path.
- Keep regex structure fallback only as degraded mode with a visible warning.

Tests:

- Add focused `dart-extractor.test.ts` cases matching the existing extractor test style.
- Add a Flutter widget class sample.
- Add a malformed-but-recoverable Dart source sample.
- Add `extract-structure` end-to-end coverage if the skill test harness supports it.
- Add fingerprint or batching coverage if those paths consume `builtinLanguageConfigs.filter(c => c.treeSitter)`.

Verification:

```bash
pnpm --filter @understand-anything/core test
pnpm --filter @understand-anything/core build
pnpm test
pnpm build
git diff --check
```

Acceptance criteria:

- Dart classes/functions are tree-sitter derived.
- Existing structure output shape remains compatible with the dashboard.
- Regex `analyzeDartFile(...)` is not the normal successful path.
- Ambiguous syntax is omitted rather than guessed.

### PR 3: Loud Fallback + Dashboard Revalidation

Make trust state and architecture diagnostics explicit.

Tasks:

- Distinguish full tree-sitter init failure from Dart-only grammar load failure.
- Consider exposing per-language grammar load status from `TreeSitterPlugin`, because today missing grammars are swallowed as `console.debug`.
- Emit Dart-specific warnings from both import-map and structure phases.
- Revalidate dashboard architecture diagnostics against parsed Dart import edges.
- Add or update dashboard fixture tests. Prefer a generated parser-pipeline fixture if practical; otherwise use a manually constructed graph and document the limitation.
- Keep `packages/dashboard/src/utils/dartArchitecture.ts` consuming graph edges, not parser internals.

Tests:

- Dart grammar-unavailable behavior.
- Dashboard architecture diagnostics still flag VGV violations from parsed import edges.

Verification:

```bash
pnpm --filter @understand-anything/core test
pnpm --filter @understand-anything/dashboard test
pnpm --filter @understand-anything/dashboard build
pnpm test
pnpm build
git diff --check
```

Acceptance criteria:

- Fallback is never silent.
- Dashboard diagnostics do not couple to parser implementation details.
- Architecture violations remain deterministic from graph edges.

## Risks And Mitigations

- **WASM compatibility risk:** reviewers found the shipped `tree-sitter-dart.wasm` may fail under current `web-tree-sitter`. Mitigate by proving loadability before wiring config and, if needed, building a compatible WASM with pinned `tree-sitter-cli`.
- **Third-party grammar risk:** `tree-sitter-dart` is third-party, not official Dart. Mitigate with fixture coverage for our Dart/Flutter patterns.
- **Config-only false success:** grammar load without extractor returns empty analysis. Mitigate by making PR 1 import-edge end-to-end.
- **Fallback regression:** `TreeSitterPlugin.init()` can skip failed grammars; scripts may think tree-sitter is ready. Mitigate by exposing or testing per-language availability before removing fallback behavior.
- **Semantic limit:** tree-sitter does not know Dart package semantics, conditional imports, type resolution, or API ownership. Keep Dart Analyzer / `scip_dart` as future semantic enrichment.
- **Workspace confusion:** there is repo root state and `understand-anything-plugin/` package state. Run install/build/test from the plugin workspace unless a command explicitly targets the outer fork.

## Future Follow-Ups

- Add external import facts for `package:flutter`, `package:bloc`, `dart:io`, and `dart:html` so architecture diagnostics can flag forbidden framework/platform imports.
- Evaluate Dart Analyzer or `scip_dart` as an authoritative semantic sidecar that emits JSON/SCIP into the TypeScript graph builder.
- Add an architecture diagnostics panel that lists violations in text, not only red graph edges.

## Review Notes Incorporated

- Plan-splitting review recommended three PRs rather than one broad parser/dashboard change.
- Codebase review confirmed the integration points and warned that missing Dart grammar load status can suppress useful fallback behavior.
- External parser research confirmed `tree-sitter-dart` is viable only if WASM compatibility is proven or rebuilt for the repo's `web-tree-sitter` version.

## Build Handoff Prompt

Use this prompt for PR 1:

```text
Implement PR 1 from /Users/jholt/development/jhd-business/understand-anything-dart-vgv/docs/plan/2026-05-28-feat-add-dart-tree-sitter-support-plan.md.

Scope: Dart Grammar + Import Edge Thin Slice only.

Success means .dart source is parsed by tree-sitter-dart, Dart imports are extracted by DartExtractor, existing pubspec-based package resolution still resolves local package imports, and regex Dart import extraction is no longer the normal successful path.

Before wiring dartConfig, prove the Dart WASM loads with the repo's current web-tree-sitter. If the shipped WASM fails, add a pinned compatible build path and document it.

Do not implement PR 2 structure/call extraction or PR 3 dashboard/fallback revalidation except for the minimum loud warning needed to avoid silent degraded output in PR 1.

Run:
pnpm --filter @understand-anything/core test
pnpm --filter @understand-anything/core build
pnpm test
pnpm build
git diff --check
```
