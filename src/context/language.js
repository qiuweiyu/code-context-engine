import path from "node:path";

const MAP = new Map([
  [".go", "go"], [".ts", "typescript"], [".tsx", "typescript"], [".js", "javascript"], [".jsx", "javascript"],
  [".mjs", "javascript"], [".cjs", "javascript"], [".vue", "vue"], [".sql", "sql"], [".proto", "proto"],
  [".py", "python"], [".java", "java"], [".rs", "rust"], [".cs", "csharp"], [".kt", "kotlin"]
]);

export function detectLanguage(relPath) {
  return MAP.get(path.extname(relPath).toLowerCase()) ?? "text";
}

export function isTestPath(relPath) {
  const p = relPath.toLowerCase().replaceAll("\\", "/");
  return /(^|\/)(test|tests|__tests__|acceptance)(\/|$)/.test(p) || /(?:^|[._-])(test|spec)(?:[._-]|$)/.test(p) || /_test\.go$/.test(p);
}
