import path from "node:path";
import { loadSemanticProviderSpecV1 } from "./provider-v1.js";

function resolveInsideRepo(repoRoot, specPath) {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, specPath);
  const relative = path.relative(root, resolved);
  if (relative === ".."
      || relative.startsWith(".." + path.sep)
      || path.isAbsolute(relative)) {
    throw new Error("semantic provider spec must be inside repo_root");
  }
  return resolved;
}

export function loadCliSemanticProviderSpecV1(specPath) {
  return loadSemanticProviderSpecV1(path.resolve(specPath));
}

export function loadMcpSemanticProviderSpecV1({ repoRoot, specPath }) {
  return loadSemanticProviderSpecV1(resolveInsideRepo(repoRoot, specPath));
}
