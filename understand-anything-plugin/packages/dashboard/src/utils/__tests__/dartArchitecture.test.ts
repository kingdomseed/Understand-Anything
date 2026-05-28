import { describe, expect, it } from "vitest";
import type {
  GraphEdge,
  GraphNode,
  KnowledgeGraph,
} from "@understand-anything/core/types";
import {
  analyzeDartArchitecture,
  classifyDartArchitectureFilePath,
  deriveDartArchitectureContainers,
  deriveDartLayerDetailContainers,
  isDartArchitectureGraph,
  isDartProductionArchitectureEdge,
  isDartProductionFilePath,
} from "../dartArchitecture";

function file(id: string, filePath: string): GraphNode {
  return {
    id,
    type: "file",
    name: filePath.split("/").pop() ?? id,
    filePath,
    summary: "",
    complexity: "simple",
    tags: [],
  } as GraphNode;
}

describe("Dart architecture helpers", () => {
  it("detects Dart and Flutter graphs", () => {
    const graph = {
      version: "1.0.0",
      project: {
        name: "app",
        description: "",
        languages: ["dart"],
        frameworks: ["Flutter"],
        analyzedAt: "2026-05-28T00:00:00.000Z",
        gitCommitHash: "test",
      },
      nodes: [],
      edges: [],
      layers: [],
      tour: [],
    } as KnowledgeGraph;

    expect(isDartArchitectureGraph(graph)).toBe(true);
  });

  it("keeps production Dart files and excludes tests/generated files", () => {
    expect(isDartProductionFilePath("apps/mythic_cli/lib/src/command_runner.dart"))
      .toBe(true);
    expect(isDartProductionFilePath("packages/mythic_vault_repository/lib/src/vault.dart"))
      .toBe(true);
    expect(isDartProductionFilePath("apps/mythic_cli/test/src/command_runner_test.dart"))
      .toBe(false);
    expect(isDartProductionFilePath("packages/foo/lib/src/model.freezed.dart"))
      .toBe(false);
    expect(isDartProductionFilePath("apps/mythic_cli/analysis_options.yaml"))
      .toBe(false);
  });

  it("groups Dart production files by VGV-aware buckets", () => {
    const nodes = [
      file("commands-a", "apps/mythic_cli/lib/src/commands/vault_command.dart"),
      file("commands-b", "apps/mythic_cli/lib/src/commands/vault_json.dart"),
      file("tui-a", "apps/mythic_cli/lib/src/tui/vault_tui_controller.dart"),
      file("tui-b", "apps/mythic_cli/lib/src/tui/vault_tui_renderer.dart"),
      file("repo-a", "packages/mythic_vault_repository/lib/src/vault_repository.dart"),
      file("repo-b", "packages/mythic_vault_repository/lib/src/vault_models.dart"),
      file("data-a", "packages/mythic_vault_file_store/lib/src/file_store.dart"),
      file("single", "apps/mythic_cli/bin/mythic.dart"),
    ];

    const { containers, ungrouped } = deriveDartArchitectureContainers(nodes);
    expect(containers.map((c) => c.name).sort()).toEqual([
      "CLI Commands",
      "CLI TUI",
      "Repository: mythic_vault_repository",
    ]);
    expect(containers.every((c) => c.strategy === "folder")).toBe(true);
    expect(ungrouped.sort()).toEqual(["data-a", "single"]);
  });

  it("groups files inside an architecture layer by package-internal folders", () => {
    const nodes = [
      file("barrel", "packages/mythic_vault_index/lib/mythic_vault_index.dart"),
      file("root", "packages/mythic_vault_index/lib/src/default_vault_reconciler.dart"),
      file("dao-a", "packages/mythic_vault_index/lib/src/drift/daos/list_item_dao.dart"),
      file("dao-b", "packages/mythic_vault_index/lib/src/drift/daos/scene_dao.dart"),
      file("table-a", "packages/mythic_vault_index/lib/src/drift/tables/list_items_table.dart"),
      file("table-b", "packages/mythic_vault_index/lib/src/drift/tables/scenes_table.dart"),
      file("indexer-a", "packages/mythic_vault_index/lib/src/indexers/list_indexer.dart"),
      file("indexer-b", "packages/mythic_vault_index/lib/src/indexers/scene_indexer.dart"),
    ];

    const { containers, ungrouped } = deriveDartLayerDetailContainers(nodes);

    expect(containers.map((c) => c.name).sort()).toEqual([
      "drift/daos",
      "drift/tables",
      "indexers",
      "root",
    ]);
    expect(containers.find((c) => c.name === "drift/daos")?.nodeIds.sort()).toEqual([
      "dao-a",
      "dao-b",
    ]);
    expect(containers.some((c) => c.name === "Data: mythic_vault_index")).toBe(false);
    expect(ungrouped).toEqual([]);
  });

  it("does not create a redundant detail container when all files share one internal group", () => {
    const nodes = [
      file("a", "packages/mythic_vault_api/lib/src/vault_failure.dart"),
      file("b", "packages/mythic_vault_api/lib/src/vault_metadata.dart"),
    ];

    const { containers, ungrouped } = deriveDartLayerDetailContainers(nodes);

    expect(containers).toEqual([]);
    expect(ungrouped.sort()).toEqual(["a", "b"]);
  });

  it("classifies files into deterministic architecture roles", () => {
    expect(
      classifyDartArchitectureFilePath(
        "packages/mythic_vault_file_store/lib/src/file_store.dart",
      ),
    ).toMatchObject({
      bucket: "Data: mythic_vault_file_store",
      role: "data",
      layerRank: 0,
    });
    expect(
      classifyDartArchitectureFilePath(
        "packages/mythic_vault_repository/lib/src/vault_repository.dart",
      ),
    ).toMatchObject({
      bucket: "Repository: mythic_vault_repository",
      role: "repository",
      layerRank: 1,
    });
    expect(
      classifyDartArchitectureFilePath(
        "apps/mythic_gme_app/lib/vault/bloc/vault_bloc.dart",
      ),
    ).toMatchObject({
      bucket: "Business Logic: vault",
      role: "businessLogic",
      layerRank: 2,
    });
    expect(
      classifyDartArchitectureFilePath(
        "apps/mythic_gme_app/lib/vault/view/vault_page.dart",
      ),
    ).toMatchObject({
      bucket: "Presentation: vault",
      role: "presentation",
      layerRank: 3,
    });
  });

  it("keeps only production Dart architecture edges", () => {
    const nodes = new Map<string, GraphNode>([
      ["a", file("a", "apps/mythic_cli/lib/src/a.dart")],
      ["b", file("b", "apps/mythic_cli/lib/src/b.dart")],
      ["test", file("test", "apps/mythic_cli/test/src/a_test.dart")],
    ]);

    expect(
      isDartProductionArchitectureEdge(
        { source: "a", target: "b", type: "imports" } as GraphEdge,
        nodes,
      ),
    ).toBe(true);
    expect(
      isDartProductionArchitectureEdge(
        { source: "test", target: "a", type: "imports" } as GraphEdge,
        nodes,
      ),
    ).toBe(false);
    expect(
      isDartProductionArchitectureEdge(
        { source: "a", target: "b", type: "documents" } as GraphEdge,
        nodes,
      ),
    ).toBe(false);
  });

  it("detects deterministic VGV dependency violations", () => {
    const nodes = new Map<string, GraphNode>([
      ["data", file("data", "packages/mythic_vault_file_store/lib/src/file_store.dart")],
      ["repo", file("repo", "packages/mythic_vault_repository/lib/src/vault_repository.dart")],
      ["other-repo", file("other-repo", "packages/mythic_oracle_repository/lib/src/oracle_repository.dart")],
      ["bloc", file("bloc", "apps/mythic_gme_app/lib/vault/bloc/vault_bloc.dart")],
      ["view", file("view", "apps/mythic_gme_app/lib/vault/view/vault_page.dart")],
      ["cli", file("cli", "apps/mythic_cli/lib/src/commands/vault_command.dart")],
    ]);
    const edges = [
      { source: "view", target: "bloc", type: "imports", direction: "forward", weight: 1 },
      { source: "data", target: "repo", type: "imports", direction: "forward", weight: 1 },
      { source: "repo", target: "other-repo", type: "imports", direction: "forward", weight: 1 },
      { source: "view", target: "repo", type: "imports", direction: "forward", weight: 1 },
      { source: "cli", target: "view", type: "imports", direction: "forward", weight: 1 },
    ] as GraphEdge[];

    const diagnostics = analyzeDartArchitecture(edges, nodes);

    expect(diagnostics.violations.map((v) => v.ruleId)).toEqual([
      "inner-layer-imports-outer-layer",
      "repository-imports-repository",
      "layer-skip",
      "cli-imports-flutter-app-layer",
    ]);
    expect(diagnostics.issueCountByNodeId.get("view")).toBe(2);
    expect(diagnostics.violationEdgeKeys.size).toBe(4);
  });
});
