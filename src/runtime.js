import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const runtimeRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

export const packageVersion = JSON.parse(
  fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8")
).version;

const RUNTIME_FINGERPRINT_FILES = [
  "src/runtime.js",
  "src/git.js",
  "src/context/indexer.js",
  "src/context/status.js",
  "src/context/analyzers.js",
  "src/context/retriever.js",
  "src/server.js"
];

function bestEffortGitHead(root) {
  try {
    return execFileSync(
      "git",
      ["-C", root, "rev-parse", "HEAD"],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000
      }
    ).trim() || null;
  } catch {
    return null;
  }
}

export function runtimeFingerprint() {
  const hash = crypto.createHash("sha256");
  hash.update("cce-runtime-fingerprint-v1\0");
  for (const relPath of RUNTIME_FINGERPRINT_FILES) {
    const full = path.join(runtimeRoot, ...relPath.split("/"));
    hash.update(relPath);
    hash.update("\0");
    try {
      hash.update(fs.readFileSync(full));
    } catch {
      hash.update("<missing>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function runtimeIdentity() {
  return {
    package_version: packageVersion,
    runtime_root: runtimeRoot,
    runtime_git_head: bestEffortGitHead(runtimeRoot),
    runtime_fingerprint: runtimeFingerprint()
  };
}
