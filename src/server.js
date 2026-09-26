#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assertAllowedPath } from "./security.js";
import { indexRepository } from "./context/indexer.js";
import { queryContext } from "./context/retriever.js";
import { readIndexStatus } from "./context/status.js";
import { buildRepositoryFlowManifest } from "./context/flow-manifest.js";
import { serializeQueryOutput } from "./context/query-output.js";

const server = new McpServer({ name: "code-context-engine", version: "0.1.7" });
const textResult = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const queryTextResult = (value, compact = false) => ({
  content: [{ type: "text", text: serializeQueryOutput(value, { compact }) }]
});

server.registerTool(
  "context_index_repo",
  {
    title: "Build or refresh a local code knowledge index",
    description:
      "Indexes a local Git repository into .context-index. Extracts files, symbols, signatures, descriptions, call/import edges, routes, database objects, tests, and feature references. No LLM or cloud service is used.",
    inputSchema: {
      repo_root: z.string().min(1).describe("Local Git repository path. Must be within CCE_ALLOWED_ROOTS."),
      force: z.boolean().optional().describe("Re-index all tracked source even when hashes are unchanged.")
    }
  },
  async ({ repo_root, force }) => {
    try {
      const allowed = assertAllowedPath(repo_root);
      return textResult(await indexRepository({ repoRoot: allowed, force: force ?? false }));
    } catch (error) {
      return textResult({ ok: false, error: error instanceof Error ? error.message : "unknown error" });
    }
  }
);

server.registerTool(
  "context_query",
  {
    title: "Query local code context",
    description:
      "Queries the local code knowledge index. Set compact=true for an LLM-oriented projection with selected files, symbol hints, tests, and coverage while preserving the full debug view by default. No source is uploaded and no model is called.",
    inputSchema: {
      repo_root: z.string().min(1),
      task: z.string().min(3),
      max_files: z.number().int().min(1).max(50).optional(),
      compact: z.boolean().optional().describe("Return the compact LLM-oriented query projection.")
    }
  },
  async ({ repo_root, task, max_files, compact }) => {
    try {
      const allowed = assertAllowedPath(repo_root);
      return queryTextResult(
        queryContext({ repoRoot: allowed, task, maxFiles: max_files ?? 12 }),
        compact ?? false
      );
    } catch (error) {
      return queryTextResult(
        { ok: false, error: error instanceof Error ? error.message : "unknown error" },
        compact ?? false
      );
    }
  }
);

server.registerTool(
  "context_flow",
  {
    title: "Build a compact deterministic flow manifest",
    description:
      "Traverses the local typed code graph from one or more explicit entry nodes and returns compact cross-layer flows with bounded depth/width, evidence, frontier, unresolved links, and involved files. No source is uploaded and no model is called.",
    inputSchema: {
      repo_root: z.string().min(1),
      start_nodes: z.array(z.string().min(1)).min(1).max(32),
      direction: z.enum(["forward", "reverse"]).optional(),
      max_hops: z.number().int().min(1).max(6).optional(),
      branch_limit: z.number().int().min(1).max(100).optional(),
      node_limit: z.number().int().min(1).max(1000).optional(),
      min_confidence: z.enum(["exact", "static", "inferred"]).optional(),
      edge_types: z.array(z.enum([
        "call",
        "import",
        "route_handler",
        "api_request",
        "db_read",
        "db_write",
        "test_of",
        "page_api"
      ])).min(1).optional()
    }
  },
  async ({
    repo_root,
    start_nodes,
    direction,
    max_hops,
    branch_limit,
    node_limit,
    min_confidence,
    edge_types
  }) => {
    try {
      const allowed = assertAllowedPath(repo_root);
      return textResult(buildRepositoryFlowManifest({
        repoRoot: allowed,
        startNodeIds: start_nodes,
        direction: direction ?? "forward",
        maxHops: max_hops ?? 3,
        branchLimit: branch_limit ?? 8,
        nodeLimit: node_limit ?? 128,
        minConfidence: min_confidence ?? "static",
        edgeTypes: edge_types ?? null
      }));
    } catch (error) {
      return textResult({ ok: false, error: error instanceof Error ? error.message : "unknown error" });
    }
  }
);

server.registerTool(
  "context_index_status",
  {
    title: "Inspect code context freshness",
    description: "Shows index counts plus each feature flow's valid / needs_review / stale status.",
    inputSchema: { repo_root: z.string().min(1) }
  },
  async ({ repo_root }) => {
    try {
      const allowed = assertAllowedPath(repo_root);
      return textResult(readIndexStatus({ repoRoot: allowed }));
    } catch (error) {
      return textResult({ ok: false, error: error instanceof Error ? error.message : "unknown error" });
    }
  }
);

await server.connect(new StdioServerTransport());
