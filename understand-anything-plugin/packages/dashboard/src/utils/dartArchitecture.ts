import type {
  GraphEdge,
  GraphNode,
  KnowledgeGraph,
} from "@understand-anything/core/types";
import type { DerivedContainer, DeriveResult } from "./containers";

const GENERATED_DART_RE = /\.(?:g|freezed|config|mocks?|gen|gr)\.dart$/;
const DART_ARCHITECTURE_EDGE_TYPES = new Set(["imports", "depends_on"]);

export type DartArchitectureRole =
  | "data"
  | "repository"
  | "businessLogic"
  | "presentation"
  | "sharedUi"
  | "domainEngine"
  | "cli"
  | "appBootstrap"
  | "entrypoint"
  | "package"
  | "other";

export interface DartArchitectureClassification {
  filePath: string;
  bucket: string;
  role: DartArchitectureRole;
  appName?: string;
  packageName?: string;
  feature?: string;
  layerRank?: number;
}

export interface DartArchitectureViolation {
  edge: GraphEdge;
  source: GraphNode;
  target: GraphNode;
  sourceClassification: DartArchitectureClassification;
  targetClassification: DartArchitectureClassification;
  ruleId: string;
  severity: "error" | "warning";
  message: string;
}

export interface DartArchitectureDiagnostics {
  violations: DartArchitectureViolation[];
  violationEdgeKeys: Set<string>;
  issueCountByNodeId: Map<string, number>;
}

const CORE_LAYER_RANK: Partial<Record<DartArchitectureRole, number>> = {
  data: 0,
  repository: 1,
  businessLogic: 2,
  presentation: 3,
};

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function dartArchitectureEdgeKey(edge: GraphEdge): string {
  return `${edge.source.length}:${edge.source}->${edge.target.length}:${edge.target}:${edge.type}`;
}

export function isDartArchitectureGraph(graph: KnowledgeGraph): boolean {
  const languages = graph.project.languages.map((lang) => lang.toLowerCase());
  const frameworks = graph.project.frameworks.map((framework) =>
    framework.toLowerCase(),
  );
  return (
    languages.includes("dart") ||
    frameworks.includes("dart") ||
    frameworks.includes("flutter") ||
    graph.nodes.some((node) => node.filePath?.endsWith(".dart"))
  );
}

export function isGeneratedDartFilePath(filePath: string): boolean {
  return GENERATED_DART_RE.test(normalizePath(filePath));
}

export function isDartProductionFilePath(filePath: string): boolean {
  const path = normalizePath(filePath);
  if (!path.endsWith(".dart")) return false;
  if (isGeneratedDartFilePath(path)) return false;
  if (path.includes("/test/") || path.endsWith("_test.dart")) return false;

  if (/^packages\/[^/]+\/lib\//.test(path)) return true;
  if (/^apps\/[^/]+\/(?:lib|bin)\//.test(path)) return true;

  // Single-package Dart/Flutter projects commonly live at repo root.
  return /^(?:lib|bin)\//.test(path);
}

export function isDartProductionNode(node: GraphNode): boolean {
  return (
    node.type === "file" &&
    typeof node.filePath === "string" &&
    isDartProductionFilePath(node.filePath)
  );
}

export function isDartArchitectureEdge(edge: GraphEdge): boolean {
  return DART_ARCHITECTURE_EDGE_TYPES.has(edge.type);
}

export function isDartProductionArchitectureEdge(
  edge: GraphEdge,
  nodesById: Map<string, GraphNode>,
): boolean {
  if (!isDartArchitectureEdge(edge)) return false;
  const source = nodesById.get(edge.source);
  const target = nodesById.get(edge.target);
  return !!source && !!target && isDartProductionNode(source) && isDartProductionNode(target);
}

function isDataPackageName(packageName: string): boolean {
  return (
    packageName.endsWith("_api") ||
    packageName.endsWith("_api_client") ||
    packageName.endsWith("_client") ||
    packageName.endsWith("_store") ||
    packageName.endsWith("_file_store") ||
    packageName.endsWith("_storage") ||
    packageName.endsWith("_data") ||
    packageName.endsWith("_data_source") ||
    packageName.endsWith("_index") ||
    packageName.endsWith("_runtime") ||
    packageName.endsWith("_migration")
  );
}

function classifyPackagePath(
  packageName: string,
  filePath: string,
): DartArchitectureClassification {
  if (packageName === "mythic_app_ui" || packageName.endsWith("_ui")) {
    return {
      filePath,
      bucket: `Shared UI: ${packageName}`,
      role: "sharedUi",
      packageName,
    };
  }
  if (packageName.endsWith("_repository")) {
    return {
      filePath,
      bucket: `Repository: ${packageName}`,
      role: "repository",
      packageName,
      layerRank: CORE_LAYER_RANK.repository,
    };
  }
  if (isDataPackageName(packageName)) {
    return {
      filePath,
      bucket: `Data: ${packageName}`,
      role: "data",
      packageName,
      layerRank: CORE_LAYER_RANK.data,
    };
  }
  if (packageName.includes("dice_parser")) {
    return {
      filePath,
      bucket: `Domain Engine: ${packageName}`,
      role: "domainEngine",
      packageName,
    };
  }
  return {
    filePath,
    bucket: `Package: ${packageName}`,
    role: "package",
    packageName,
  };
}

function classifyFlutterFeature(
  filePath: string,
  appName: string | undefined,
  feature: string,
  segment: string,
): DartArchitectureClassification {
  if (segment === "view") {
    return {
      filePath,
      bucket: `Presentation: ${feature}`,
      role: "presentation",
      appName,
      feature,
      layerRank: CORE_LAYER_RANK.presentation,
    };
  }
  if (segment === "bloc" || segment === "cubit") {
    return {
      filePath,
      bucket: `Business Logic: ${feature}`,
      role: "businessLogic",
      appName,
      feature,
      layerRank: CORE_LAYER_RANK.businessLogic,
    };
  }
  return {
    filePath,
    bucket: `App Feature: ${feature}`,
    role: "other",
    appName,
    feature,
  };
}

function classifyAppPath(
  appName: string,
  rest: string,
  filePath: string,
): DartArchitectureClassification {
  if (rest.startsWith("bin/")) {
    return {
      filePath,
      bucket: "Entrypoints",
      role: "entrypoint",
      appName,
    };
  }
  if (appName.includes("cli")) {
    let bucket = "CLI Entrypoints";
    if (rest.startsWith("lib/src/commands/")) bucket = "CLI Commands";
    else if (rest.startsWith("lib/src/tui/interactive/")) bucket = "CLI Interactive Shell";
    else if (rest.startsWith("lib/src/tui/")) bucket = "CLI TUI";
    else if (rest.startsWith("lib/src/")) bucket = "CLI Support";
    return {
      filePath,
      bucket,
      role: "cli",
      appName,
    };
  }

  const parts = rest.split("/");
  if (parts[0] !== "lib") {
    return {
      filePath,
      bucket: `App: ${appName}`,
      role: "other",
      appName,
    };
  }
  if (parts[1] === "app") {
    if (parts[2] === "view") {
      return {
        filePath,
        bucket: "Presentation: app",
        role: "presentation",
        appName,
        feature: "app",
        layerRank: CORE_LAYER_RANK.presentation,
      };
    }
    return {
      filePath,
      bucket: "App Bootstrap",
      role: "appBootstrap",
      appName,
    };
  }
  if (parts.length >= 3) {
    return classifyFlutterFeature(filePath, appName, parts[1], parts[2]);
  }
  return {
    filePath,
    bucket: `App: ${appName}`,
    role: "other",
    appName,
  };
}

export function classifyDartArchitectureFilePath(
  filePath: string,
): DartArchitectureClassification {
  const path = normalizePath(filePath);
  const appMatch = path.match(/^apps\/([^/]+)\/(.+)$/);
  if (appMatch) {
    return classifyAppPath(appMatch[1], appMatch[2], path);
  }

  const packageMatch = path.match(/^packages\/([^/]+)\/lib\//);
  if (packageMatch) {
    return classifyPackagePath(packageMatch[1], path);
  }

  if (path.startsWith("bin/")) {
    return {
      filePath: path,
      bucket: "Entrypoints",
      role: "entrypoint",
    };
  }
  if (path.startsWith("lib/app/view/")) {
    return {
      filePath: path,
      bucket: "Presentation: app",
      role: "presentation",
      feature: "app",
      layerRank: CORE_LAYER_RANK.presentation,
    };
  }
  if (path.startsWith("lib/app/")) {
    return {
      filePath: path,
      bucket: "App Bootstrap",
      role: "appBootstrap",
    };
  }

  const rootMatch = path.match(/^lib\/([^/]+)\/([^/]+)\//);
  if (rootMatch) {
    return classifyFlutterFeature(path, undefined, rootMatch[1], rootMatch[2]);
  }

  return {
    filePath: path,
    bucket: "Dart Production",
    role: "other",
  };
}

function buildViolation(
  edge: GraphEdge,
  source: GraphNode,
  target: GraphNode,
  sourceClassification: DartArchitectureClassification,
  targetClassification: DartArchitectureClassification,
  ruleId: string,
  severity: DartArchitectureViolation["severity"],
  reason: string,
): DartArchitectureViolation {
  return {
    edge,
    source,
    target,
    sourceClassification,
    targetClassification,
    ruleId,
    severity,
    message: `${sourceClassification.bucket} imports ${targetClassification.bucket}: ${reason}`,
  };
}

function diagnoseArchitectureEdge(
  edge: GraphEdge,
  source: GraphNode,
  target: GraphNode,
): DartArchitectureViolation | null {
  if (!source.filePath || !target.filePath) return null;
  const sourceClassification = classifyDartArchitectureFilePath(source.filePath);
  const targetClassification = classifyDartArchitectureFilePath(target.filePath);

  if (
    sourceClassification.role === "repository" &&
    targetClassification.role === "repository" &&
    sourceClassification.packageName !== targetClassification.packageName
  ) {
    return buildViolation(
      edge,
      source,
      target,
      sourceClassification,
      targetClassification,
      "repository-imports-repository",
      "error",
      "repositories should not import other repositories",
    );
  }

  if (
    sourceClassification.role === "sharedUi" &&
    targetClassification.role !== "sharedUi"
  ) {
    return buildViolation(
      edge,
      source,
      target,
      sourceClassification,
      targetClassification,
      "shared-ui-imports-product-layer",
      "error",
      "shared UI should not depend on app, repository, or data layers",
    );
  }

  if (
    sourceClassification.role === "cli" &&
    (targetClassification.role === "presentation" ||
      targetClassification.role === "businessLogic" ||
      targetClassification.role === "appBootstrap")
  ) {
    return buildViolation(
      edge,
      source,
      target,
      sourceClassification,
      targetClassification,
      "cli-imports-flutter-app-layer",
      "error",
      "the CLI can use repositories, data clients, and pure engines, but not Flutter app layers",
    );
  }

  const sourceRank = sourceClassification.layerRank;
  const targetRank = targetClassification.layerRank;
  if (sourceRank === undefined || targetRank === undefined) return null;

  if (sourceRank < targetRank) {
    return buildViolation(
      edge,
      source,
      target,
      sourceClassification,
      targetClassification,
      "inner-layer-imports-outer-layer",
      "error",
      "dependencies must point inward through the VGV layers",
    );
  }

  if (sourceRank - targetRank > 1) {
    return buildViolation(
      edge,
      source,
      target,
      sourceClassification,
      targetClassification,
      "layer-skip",
      "warning",
      "this skips an intermediate VGV layer",
    );
  }

  return null;
}

export function analyzeDartArchitecture(
  edges: GraphEdge[],
  nodesById: Map<string, GraphNode>,
): DartArchitectureDiagnostics {
  const violations: DartArchitectureViolation[] = [];
  const violationEdgeKeys = new Set<string>();
  const issueCountByNodeId = new Map<string, number>();

  for (const edge of edges) {
    if (!isDartProductionArchitectureEdge(edge, nodesById)) continue;
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) continue;
    const violation = diagnoseArchitectureEdge(edge, source, target);
    if (!violation) continue;

    violations.push(violation);
    violationEdgeKeys.add(dartArchitectureEdgeKey(edge));
    issueCountByNodeId.set(
      source.id,
      (issueCountByNodeId.get(source.id) ?? 0) + 1,
    );
    issueCountByNodeId.set(
      target.id,
      (issueCountByNodeId.get(target.id) ?? 0) + 1,
    );
  }

  return { violations, violationEdgeKeys, issueCountByNodeId };
}

export function deriveDartArchitectureContainers(nodes: GraphNode[]): DeriveResult {
  const buckets = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.filePath) continue;
    const name = classifyDartArchitectureFilePath(node.filePath).bucket;
    const ids = buckets.get(name) ?? [];
    ids.push(node.id);
    buckets.set(name, ids);
  }

  const containers: DerivedContainer[] = [];
  const ungrouped: string[] = [];
  for (const [name, nodeIds] of [...buckets.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (nodeIds.length === 1) {
      ungrouped.push(nodeIds[0]);
      continue;
    }
    containers.push({
      id: `container:dart-architecture:${name}`,
      name,
      nodeIds,
      strategy: "folder",
    });
  }

  return { containers, ungrouped };
}

function sanitizeContainerId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function packageInternalGroupName(filePath: string): string {
  const path = normalizePath(filePath);
  let relative: string | null = null;

  const packageMatch = path.match(/^packages\/[^/]+\/lib\/(.+)$/);
  if (packageMatch) {
    relative = packageMatch[1];
  }

  const appLibMatch = path.match(/^apps\/[^/]+\/lib\/(.+)$/);
  if (!relative && appLibMatch) {
    relative = appLibMatch[1];
  }

  const appBinMatch = path.match(/^apps\/[^/]+\/bin\/(.+)$/);
  if (!relative && appBinMatch) {
    return "bin";
  }

  const rootLibMatch = path.match(/^lib\/(.+)$/);
  if (!relative && rootLibMatch) {
    relative = rootLibMatch[1];
  }

  if (!relative) {
    return classifyDartArchitectureFilePath(path).bucket;
  }

  if (!relative.includes("/")) {
    return "root";
  }

  if (relative.startsWith("src/")) {
    const parts = relative.slice("src/".length).split("/").filter(Boolean);
    if (parts.length <= 1) return "root";
    return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0];
  }

  const parts = relative.split("/").filter(Boolean);
  if (parts.length <= 1) return "root";
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * Groups nodes inside an already-selected Dart architecture layer.
 *
 * The overview layer is already the VGV bucket. Re-applying architecture
 * classification inside that layer collapses every file into one same-name
 * container, producing a large empty box. Detail view instead uses stable
 * package/app-internal path groups such as `drift/daos`, `drift/tables`,
 * `indexers`, `commands`, or `tui/interactive`.
 */
export function deriveDartLayerDetailContainers(nodes: GraphNode[]): DeriveResult {
  const buckets = new Map<string, string[]>();
  const nodeIds = nodes.map((node) => node.id);

  for (const node of nodes) {
    if (!node.filePath) continue;
    const name = packageInternalGroupName(node.filePath);
    const ids = buckets.get(name) ?? [];
    ids.push(node.id);
    buckets.set(name, ids);
  }

  if (buckets.size <= 1) {
    return { containers: [], ungrouped: nodeIds };
  }

  const containers: DerivedContainer[] = [];
  const ungrouped: string[] = [];
  for (const [name, ids] of [...buckets.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (ids.length === 1) {
      ungrouped.push(ids[0]);
      continue;
    }
    containers.push({
      id: `container:dart-detail:${sanitizeContainerId(name)}`,
      name,
      nodeIds: ids,
      strategy: "folder",
    });
  }

  return { containers, ungrouped };
}
