import path from "node:path";
import { pathToFileURL } from "node:url";
import { readPublicIndexV1 } from "./v1.js";

function positiveLine(value) {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function sourceRowsForNode(node) {
  if (!node || typeof node !== "object") return [];
  if (node.kind === "document" && node.path) {
    return [{ document: node.path, line: 1 }];
  }
  if (node.kind === "symbol" && node.document) {
    return [{ document: node.document, line: positiveLine(node.line_start) }];
  }
  if (node.kind === "entry" && node.document) {
    return [{ document: node.document, line: positiveLine(node.line) }];
  }
  if ((node.kind === "route" || node.kind === "data_object")
      && Array.isArray(node.observations)) {
    return node.observations
      .filter((item) => item?.document)
      .map((item) => ({
        document: item.document,
        line: positiveLine(item.line)
      }));
  }
  return [];
}

function resolveInside(repoRoot, relativePath) {
  const root = path.resolve(repoRoot);
  const full = path.resolve(root, relativePath);
  const rel = path.relative(root, full);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    return null;
  }
  return full;
}

function vscodeUri(absolutePath, line, column) {
  const pathname = pathToFileURL(absolutePath).pathname;
  return "vscode://file" + pathname + ":" + line + ":" + column;
}

export function locateNodeInPublicIndex(publicIndex, {
  repoRoot,
  nodeId,
  editor = "vscode"
}) {
  if (!["vscode", "file"].includes(editor)) {
    throw new Error("editor must be vscode or file");
  }
  const node = publicIndex.nodes.find((item) => item.id === nodeId) ?? null;
  if (!node) {
    return {
      ok: true,
      found: false,
      node_id: nodeId,
      node_kind: null,
      locations: []
    };
  }

  const seen = new Set();
  const locations = [];
  for (const row of sourceRowsForNode(node)) {
    const full = resolveInside(repoRoot, row.document);
    if (!full) continue;
    const line = positiveLine(row.line);
    const column = 1;
    const key = row.document + ":" + line;
    if (seen.has(key)) continue;
    seen.add(key);
    const fileUri = pathToFileURL(full).href;
    const codeUri = vscodeUri(full, line, column);
    locations.push({
      document: row.document,
      line,
      column,
      absolute_path: full,
      file_uri: fileUri,
      vscode_uri: codeUri,
      open_uri: editor === "vscode" ? codeUri : fileUri
    });
  }
  locations.sort((a, b) =>
    a.document.localeCompare(b.document) || a.line - b.line
  );

  return {
    ok: true,
    found: true,
    node_id: nodeId,
    node_kind: node.kind,
    locations
  };
}

export async function locatePublicNode({
  repoRoot,
  indexDir,
  nodeId,
  editor = "vscode"
}) {
  if (!repoRoot || !indexDir || !nodeId) {
    throw new Error("repoRoot, indexDir and nodeId are required");
  }
  const publicIndex = await readPublicIndexV1(indexDir);
  return locateNodeInPublicIndex(publicIndex, {
    repoRoot,
    nodeId,
    editor
  });
}
