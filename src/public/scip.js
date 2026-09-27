import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Text } from "../context/hash.js";
import { readPublicIndexV1 } from "./v1.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const helperDir = path.resolve(here, "../../internal/scipexporter");
const helperFiles = ["main.go", "go.mod", "go.sum"].map((name) =>
  path.join(helperDir, name)
);
let cachedBinaryPromise = null;

function runProcess(command, args, { input = "", timeout = 120000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(cwd ? { cwd } : {})
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(command + " timed out"));
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(
        command + " exited " + code + ": " + stderr.slice(0, 4000)
      ));
    });
    child.stdin.end(input);
  });
}

async function buildHelperBinary() {
  const parts = [];
  for (const file of helperFiles) {
    parts.push(await fs.readFile(file, "utf8").catch(() => ""));
  }
  const digest = sha256Text(parts.join("\n--cce-scip-helper--\n")).slice(0, 16);
  const ext = process.platform === "win32" ? ".exe" : "";
  const dir = path.join(os.tmpdir(), "code-context-engine");
  await fs.mkdir(dir, { recursive: true });
  const binary = path.join(dir, `scipexporter-${digest}${ext}`);
  try {
    await fs.access(binary);
    return binary;
  } catch {}

  const buildOutput = path.join(
    dir,
    `scipexporter-${digest}-${process.pid}.build${ext}`
  );
  await fs.rm(buildOutput, { force: true });
  try {
    await runProcess("go", ["build", "-o", buildOutput, "."], {
      timeout: 120000,
      cwd: helperDir
    });
    try {
      await fs.rename(buildOutput, binary);
    } catch (error) {
      try {
        await fs.access(binary);
        await fs.rm(buildOutput, { force: true });
      } catch {
        throw error;
      }
    }
    return binary;
  } finally {
    await fs.rm(buildOutput, { force: true }).catch(() => {});
  }
}

async function helperBinary() {
  if (!cachedBinaryPromise) {
    cachedBinaryPromise = buildHelperBinary().catch((error) => {
      cachedBinaryPromise = null;
      throw error;
    });
  }
  return cachedBinaryPromise;
}

export async function prepareScipExporter() {
  await helperBinary();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueNameRange(text, lineNumber, name) {
  if (!Number.isInteger(lineNumber) || lineNumber < 1 || !name) return null;
  const line = text.split(/\r?\n/)[lineNumber - 1];
  if (line === undefined) return null;
  const regex = new RegExp(escapeRegExp(name), "g");
  const hits = [];
  for (const match of line.matchAll(regex)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const before = index > 0 ? line[index - 1] : "";
    const afterIndex = index + name.length;
    const after = afterIndex < line.length ? line[afterIndex] : "";
    if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) continue;
    hits.push(index);
  }
  if (hits.length !== 1) return null;
  const start = Buffer.byteLength(line.slice(0, hits[0]), "utf8");
  const end = start + Buffer.byteLength(name, "utf8");
  return { start, end };
}

async function buildScipRequest({ repoRoot, indexDir, repository, toolVersion }) {
  const publicIndex = await readPublicIndexV1(indexDir);
  const documents = new Map();
  for (const node of publicIndex.nodes) {
    if (node.kind !== "document" || !node.path) continue;
    documents.set(node.path, {
      relative_path: node.path,
      language: node.language ?? "",
      symbols: []
    });
  }

  const sourceCache = new Map();
  for (const node of publicIndex.nodes) {
    if (node.kind !== "symbol" || !node.document || !documents.has(node.document)) {
      continue;
    }
    let source = sourceCache.get(node.document);
    if (source === undefined) {
      const full = path.resolve(repoRoot, node.document);
      const rel = path.relative(repoRoot, full);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        source = null;
      } else {
        source = await fs.readFile(full, "utf8").catch(() => null);
      }
      sourceCache.set(node.document, source);
    }
    const range = source === null
      ? null
      : uniqueNameRange(source, node.line_start, node.name);
    documents.get(node.document).symbols.push({
      symbol_id: node.symbol_id,
      name: node.name,
      kind: node.symbol_kind,
      receiver: node.receiver ?? "",
      line: node.line_start,
      start_byte: range?.start ?? 0,
      end_byte: range?.end ?? 0,
      has_range: Boolean(range),
      signature: node.signature ?? "",
      documentation: node.description ?? ""
    });
  }

  for (const doc of documents.values()) {
    doc.symbols.sort((a, b) =>
      a.line - b.line || a.symbol_id.localeCompare(b.symbol_id)
    );
  }

  return {
    project_root_uri: pathToFileURL(path.resolve(repoRoot)).href,
    tool_version: toolVersion,
    repository: repository || path.basename(path.resolve(repoRoot)) || ".",
    documents: [...documents.values()].sort((a, b) =>
      a.relative_path.localeCompare(b.relative_path)
    )
  };
}

export async function exportScipIndex({
  repoRoot,
  indexDir,
  outFile,
  repository,
  toolVersion = "0.1.7"
}) {
  if (!repoRoot || !indexDir || !outFile) {
    throw new Error("repoRoot, indexDir and outFile are required");
  }
  const request = await buildScipRequest({
    repoRoot,
    indexDir,
    repository,
    toolVersion
  });
  const binary = await helperBinary();
  await runProcess(binary, ["encode", path.resolve(outFile)], {
    input: JSON.stringify(request),
    timeout: 120000
  });
  return {
    ok: true,
    path: path.resolve(outFile),
    documents: request.documents.length,
    symbols: request.documents.reduce((sum, doc) => sum + doc.symbols.length, 0),
    definitions: request.documents.reduce(
      (sum, doc) => sum + doc.symbols.filter((symbol) => symbol.has_range).length,
      0
    )
  };
}

export async function inspectScipIndex(filePath) {
  const binary = await helperBinary();
  const { stdout } = await runProcess(binary, ["inspect", path.resolve(filePath)], {
    timeout: 120000
  });
  return JSON.parse(stdout);
}
