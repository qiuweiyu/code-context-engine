import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { SOURCE_EXTENSIONS } from "./policy.js";
import { isBlockedFile, redactSecrets } from "./security.js";

const execFileAsync = promisify(execFile);

async function git(repoRoot, args, options = {}) {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    timeout: options.timeout ?? 12000,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

export async function resolveGitRoot(repoRoot) {
  return (await git(repoRoot, ["rev-parse", "--show-toplevel"])).trim();
}

export async function readGitHead(repoRoot) {
  try {
    return (await git(repoRoot, ["rev-parse", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

function isLikelySource(relPath) {
  if (isBlockedFile(relPath)) return false;
  const normalized = relPath.replaceAll("\\", "/");
  const base = path.posix.basename(normalized);
  if (/^(dist|build|coverage|target)\//.test(normalized)) return false;
  if (/\.(min\.js|map)$/i.test(base)) return false;
  const ext = path.extname(base).toLowerCase();
  if (SOURCE_EXTENSIONS.has(ext)) return true;
  return ["Dockerfile", "Makefile", "Procfile", "go.mod", "go.work"].includes(base);
}

export async function listTrackedSourceFiles(repoRoot) {
  const raw = await git(
    repoRoot,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { maxBuffer: 32 * 1024 * 1024 }
  );
  return [...new Set(
    raw
      .split("\0")
      .filter(Boolean)
      .map((relPath) => relPath.replaceAll("\\", "/"))
      .filter(isLikelySource)
  )].sort((a, b) => a.localeCompare(b));
}

export async function listChangedFiles(repoRoot) {
  const raw = await git(repoRoot, ["status", "--porcelain=v1", "-z"], { maxBuffer: 4 * 1024 * 1024 });
  const parts = raw.split("\0").filter(Boolean);
  const out = new Set();
  for (const item of parts) {
    const rel = item.length > 3 ? item.slice(3) : "";
    if (rel) out.add(rel.replaceAll("\\", "/"));
  }
  return out;
}


export async function readSafeText(repoRoot, relPath, maxReadBytes) {
  const full = path.resolve(repoRoot, relPath);
  const root = path.resolve(repoRoot) + path.sep;
  if (!full.startsWith(root)) throw new Error("path traversal rejected");
  const stat = await fs.lstat(full);
  if (stat.isSymbolicLink() || !stat.isFile()) return "";
  const handle = await fs.open(full, "r");
  try {
    const buffer = Buffer.alloc(Math.min(maxReadBytes, 512000));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return "";
    return redactSecrets(bytes.toString("utf8"));
  } finally {
    await handle.close();
  }
}

export async function readPreview(repoRoot, relPath, maxReadBytes, maxPreviewChars, terms = []) {
  const full = path.resolve(repoRoot, relPath);
  const root = path.resolve(repoRoot) + path.sep;
  if (!full.startsWith(root)) throw new Error("path traversal rejected");

  // Git can track symlinks. Never follow one here: otherwise a repository could
  // point this read-only selector at content outside the allowed repository.
  const stat = await fs.lstat(full);
  if (stat.isSymbolicLink() || !stat.isFile()) return "";

  const handle = await fs.open(full, "r");
  try {
    const buffer = Buffer.alloc(Math.min(maxReadBytes, 256000));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return "";
    const text = bytes.toString("utf8");
    const lower = text.toLowerCase();
    const windows = [];
    const perWindow = Math.max(240, Math.floor(maxPreviewChars / Math.max(1, Math.min(4, terms.length || 1))));

    for (const rawTerm of terms.slice(0, 12)) {
      const term = String(rawTerm).toLowerCase();
      if (term.length < 2) continue;
      const at = lower.indexOf(term);
      if (at < 0) continue;
      const start = Math.max(0, at - Math.floor(perWindow * 0.35));
      const end = Math.min(text.length, start + perWindow);
      windows.push(text.slice(start, end));
      if (windows.join("\n...\n").length >= maxPreviewChars) break;
    }

    const selected = windows.length
      ? windows.join("\n...\n").slice(0, maxPreviewChars)
      : text.slice(0, maxPreviewChars);
    return redactSecrets(selected);
  } finally {
    await handle.close();
  }
}
