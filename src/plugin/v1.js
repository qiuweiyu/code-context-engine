export const PLUGIN_PROTOCOL = "cce-analyzer";
export const PLUGIN_PROTOCOL_VERSION = 1;
export const PLUGIN_FACT_VERSION = "1.0.0";

const CAPABILITY_VALUES = new Set([
  "unsupported", "heuristic", "static", "exact"
]);
const FILE_STATUS = new Set(["complete", "partial", "failed"]);
const DIAGNOSTIC_SEVERITY = new Set(["info", "warning", "error"]);
const DEPENDENCY_RELATIONS = new Set(["calls", "imports"]);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(label + " must be a non-empty string");
  }
  return value;
}

function validateProtocol(value) {
  requireObject(value, "plugin message");
  if (value.protocol !== PLUGIN_PROTOCOL) {
    throw new Error("unsupported plugin protocol");
  }
  if (value.protocol_version !== PLUGIN_PROTOCOL_VERSION) {
    throw new Error("unsupported plugin protocol version");
  }
  return value;
}

function validateRepoPath(value, label) {
  const raw = requireString(value, label).replaceAll("\\", "/");
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(label + " must be repository-relative");
  }
  const parts = raw.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(label + " contains invalid path components");
  }
  return raw;
}

export function validatePluginDescriptorV1(value) {
  validateProtocol(value);
  requireString(value.id, "plugin id");
  requireString(value.version, "plugin version");
  if (!Array.isArray(value.languages) || value.languages.length === 0) {
    throw new Error("plugin languages must be a non-empty array");
  }
  for (const language of value.languages) {
    requireString(language, "plugin language");
  }
  const capabilities = requireObject(
    value.capabilities ?? {},
    "plugin capabilities"
  );
  for (const [name, capability] of Object.entries(capabilities)) {
    requireString(name, "capability name");
    if (!CAPABILITY_VALUES.has(capability)) {
      throw new Error("invalid plugin capability: " + name);
    }
  }
  return value;
}

export function createPluginAnalyzeRequestV1({
  requestId,
  files,
  trackedFiles
}) {
  requireString(requestId, "request id");
  if (!Array.isArray(files)) throw new Error("files must be an array");
  const normalizedFiles = files.map((file) => {
    requireObject(file, "file");
    if (typeof file.content !== "string") {
      throw new Error("file content must be a string");
    }
    return {
      path: validateRepoPath(file.path, "file path"),
      language: requireString(file.language, "file language"),
      content: file.content
    };
  });
  const normalizedTracked = [...new Set(
    (trackedFiles ?? normalizedFiles.map((file) => file.path))
      .map((filePath) => validateRepoPath(filePath, "tracked file path"))
  )].sort();
  return {
    protocol: PLUGIN_PROTOCOL,
    protocol_version: PLUGIN_PROTOCOL_VERSION,
    fact_version: PLUGIN_FACT_VERSION,
    request_id: requestId,
    action: "analyze",
    files: normalizedFiles,
    tracked_files: normalizedTracked
  };
}

export function validatePluginAnalyzeRequestV1(value) {
  validateProtocol(value);
  if (value.fact_version !== PLUGIN_FACT_VERSION) {
    throw new Error("unsupported plugin fact version");
  }
  requireString(value.request_id, "request id");
  if (value.action !== "analyze") {
    throw new Error("unsupported plugin action");
  }
  if (!Array.isArray(value.files)) throw new Error("files must be an array");
  for (const file of value.files) {
    requireObject(file, "file");
    validateRepoPath(file.path, "file path");
    requireString(file.language, "file language");
    if (typeof file.content !== "string") {
      throw new Error("file content must be a string");
    }
  }
  if (!Array.isArray(value.tracked_files)) {
    throw new Error("tracked_files must be an array");
  }
  for (const filePath of value.tracked_files) {
    validateRepoPath(filePath, "tracked file path");
  }
  return value;
}

function validatePluginSymbol(symbol, filePath, ids) {
  requireObject(symbol, "plugin symbol");
  const symbolId = requireString(symbol.symbol_id, "symbol id");
  if (ids.has(symbolId)) throw new Error("duplicate plugin symbol id");
  ids.add(symbolId);
  requireString(symbol.name, "symbol name");
  requireString(symbol.qualified_name, "qualified name");
  requireString(symbol.kind, "symbol kind");
  if (!Number.isInteger(symbol.line_start) || symbol.line_start < 1
      || !Number.isInteger(symbol.line_end)
      || symbol.line_end < symbol.line_start) {
    throw new Error("invalid symbol line range");
  }
  if (symbol.file_path !== undefined
      && validateRepoPath(symbol.file_path, "symbol file path") !== filePath) {
    throw new Error("plugin symbol must belong to its file result");
  }
}

function validatePluginDependency(dep, filePath) {
  requireObject(dep, "plugin dependency");
  if (!DEPENDENCY_RELATIONS.has(dep.relation)) {
    throw new Error("unsupported plugin dependency relation");
  }
  requireString(dep.to_ref, "dependency to_ref");
  if (dep.from_file !== undefined
      && validateRepoPath(dep.from_file, "dependency from_file") !== filePath) {
    throw new Error("plugin dependency must belong to its file result");
  }
  if (dep.to_file !== undefined && dep.to_file !== null) {
    validateRepoPath(dep.to_file, "dependency to_file");
  }
}

function validatePluginDiagnostic(entry) {
  requireObject(entry, "plugin diagnostic");
  if (!DIAGNOSTIC_SEVERITY.has(entry.severity)) {
    throw new Error("invalid diagnostic severity");
  }
  requireString(entry.code, "diagnostic code");
  requireString(entry.message, "diagnostic message");
}

export function validatePluginAnalyzeResultV1(value) {
  validateProtocol(value);
  if (value.fact_version !== PLUGIN_FACT_VERSION) {
    throw new Error("unsupported plugin fact version");
  }
  requireString(value.request_id, "request id");
  if (!Array.isArray(value.files)) {
    throw new Error("plugin result files must be an array");
  }

  const seenPaths = new Set();
  const seenSymbolIds = new Set();
  for (const file of value.files) {
    requireObject(file, "plugin file result");
    const filePath = validateRepoPath(file.path, "result file path");
    if (seenPaths.has(filePath)) throw new Error("duplicate plugin file result");
    seenPaths.add(filePath);
    if (!FILE_STATUS.has(file.status)) {
      throw new Error("invalid plugin file status");
    }
    const symbols = file.symbols ?? [];
    const dependencies = file.dependencies ?? [];
    const diagnostics = file.diagnostics ?? [];
    if (!Array.isArray(symbols)
        || !Array.isArray(dependencies)
        || !Array.isArray(diagnostics)) {
      throw new Error("plugin facts must be arrays");
    }
    for (const symbol of symbols) {
      validatePluginSymbol(symbol, filePath, seenSymbolIds);
    }
    for (const dep of dependencies) validatePluginDependency(dep, filePath);
    for (const diagnostic of diagnostics) validatePluginDiagnostic(diagnostic);
  }
  return value;
}
