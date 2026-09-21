import path from "node:path";
import { BLOCKED_BASENAMES, BLOCKED_SUFFIXES } from "./policy.js";

export function configuredAllowedRoots() {
  const raw = process.env.CCE_ALLOWED_ROOTS?.trim();
  const roots = raw ? raw.split(path.delimiter).filter(Boolean) : [process.cwd()];
  return roots.map((p) => path.resolve(p));
}

export function assertAllowedPath(target, roots = configuredAllowedRoots()) {
  const resolved = path.resolve(target);
  const ok = roots.some((root) => {
    const rel = path.relative(root, resolved);
    return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
  });
  if (!ok) throw new Error("repo_root is outside CCE_ALLOWED_ROOTS");
  return resolved;
}

export function isBlockedFile(relPath) {
  const normalized = relPath.replaceAll("\\", "/");
  const base = path.posix.basename(normalized).toLowerCase();
  if (BLOCKED_BASENAMES.has(base)) return true;
  if (normalized.split("/").some((segment) => segment === ".git" || segment === "node_modules" || segment === "vendor")) return true;
  return BLOCKED_SUFFIXES.some((suffix) => base === suffix || base.endsWith(suffix));
}

export function redactSecrets(text) {
  let out = text;
  const patterns = [
    /(authorization\s*:\s*bearer\s+)[^\s"']+/gi,
    /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
    /\b(ts_[A-Za-z0-9_-]{12,})\b/g,
    /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
    /((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*["']?)[^\s"',;]+/gi
  ];
  for (const pattern of patterns) out = out.replace(pattern, "$1[redacted]");
  return out;
}
