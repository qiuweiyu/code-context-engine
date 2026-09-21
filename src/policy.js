export const SOURCE_EXTENSIONS = new Set([
  ".go", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue",
  ".py", ".java", ".kt", ".kts", ".rs", ".cs", ".cpp", ".cc", ".c", ".h", ".hpp",
  ".sql", ".proto", ".graphql", ".gql", ".html", ".css", ".scss", ".sass", ".less",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".conf", ".properties",
  ".md", ".mdx", ".txt", ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd",
  ".xml", ".gradle", ".mod", ".sum"
]);

export const BLOCKED_BASENAMES = new Set([
  ".env", ".env.local", ".env.production", ".env.development", ".npmrc", ".pypirc",
  "id_rsa", "id_ed25519", "credentials", "credentials.json", "secrets.json"
]);

export const BLOCKED_SUFFIXES = [
  ".pem", ".key", ".p12", ".pfx", ".crt", ".cer", ".jks", ".keystore",
  ".lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "uv.lock"
];
