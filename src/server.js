#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assertAllowedPath } from "./security.js";
import { indexRepository } from "./context/indexer.js";
import { queryContext } from "./context/retriever.js";
import { readIndexStatus } from "./context/status.js";

const server = new McpServer({ name: "code-context-engine", version: "0.1.3" });
const textResult = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

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
    title: "Build a compact code context manifest",
    description:
      "Queries the local code knowledge index and returns matching feature flows, symbols, files, one-hop dependencies, and tests. No source is uploaded and no model is called.",
    inputSchema: {
      repo_root: z.string().min(1),
      task: z.string().min(3),
      max_files: z.number().int().min(1).max(50).optional()
    }
  },
  async ({ repo_root, task, max_files }) => {
    try {
      const allowed = assertAllowedPath(repo_root);
      return textResult(queryContext({ repoRoot: allowed, task, maxFiles: max_files ?? 12 }));
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
