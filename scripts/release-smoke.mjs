#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedVersion = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const git = process.platform === "win32" ? "git.exe" : "git";

async function run(command, args, options = {}) {
  const needsWindowsShell =
    process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
  return exec(command, args, {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    shell: needsWindowsShell,
    ...options
  });
}

function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(label + " returned invalid JSON: " + error.message); }
}

async function verifyPackSurface() {
  const { stdout } = await run(npm, ["pack", "--dry-run", "--json"], { cwd: root });
  const report = parseJson(stdout, "npm pack --dry-run")[0];
  const files = report?.files?.map((entry) => entry.path) ?? [];
  const forbiddenPrefixes = [".github/", "benchmarks/", "test/"];
  const forbidden = files.filter((entry) =>
    forbiddenPrefixes.some((prefix) => entry.startsWith(prefix))
  );
  if (forbidden.length) throw new Error("development-only files packed: " + forbidden.join(", "));

  const required = [
    "package.json", "README.md", "README-ZH.md", "LICENSE",
    "src/cli.js", "src/server.js", "src/context/indexer.js",
    "src/semantic/provider-v1.js", "internal/goindexer/main.go",
    "internal/scipexporter/main.go", "docs/QUICKSTART.md",
    "docs/QUICKSTART-ZH.md", "docs/INTEROPERABILITY.md",
    "docs/SEMANTIC-PROVIDER.md", "docs/KNOWN-LIMITATIONS.md",
    "docs/RELEASE-NOTES-v0.2.0.md", "docs/RELEASE-NOTES-v0.3.0.md",
    "CHANGELOG.md", "src/observability/api.js", "src/observability/ui/index.html",
    "scripts/release-smoke.mjs"
  ];
  const missing = required.filter((entry) => !files.includes(entry));
  if (missing.length) throw new Error("required package files missing: " + missing.join(", "));
  return { file_count: report.entryCount, packed_bytes: report.size, unpacked_bytes: report.unpackedSize };
}

async function createFixture(repoRoot) {
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "src", "tasks.js"),
    "export function publishHomework() { return 'published'; }\n");
  await run(git, ["init", "-q"], { cwd: repoRoot });
  await run(git, ["config", "user.email", "release-smoke@example.invalid"], { cwd: repoRoot });
  await run(git, ["config", "user.name", "CCE Release Smoke"], { cwd: repoRoot });
  await run(git, ["add", "."], { cwd: repoRoot });
  await run(git, ["commit", "-qm", "fixture"], { cwd: repoRoot });
}

function localBin(installRoot, name) {
  return path.join(
    installRoot, "node_modules", ".bin",
    name + (process.platform === "win32" ? ".cmd" : "")
  );
}

async function runBin(installRoot, name, args, options = {}) {
  return run(localBin(installRoot, name), args, options);
}

async function stopChildTree(child) {
  if (child.exitCode !== null) return;

  if (process.platform === "win32" && child.pid) {
    try {
      await run("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]);
    } catch {
      child.kill();
    }
  } else {
    child.kill("SIGTERM");
  }

  await new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function verifyMcpStarts(installRoot, fixtureRoot) {
  const command = localBin(installRoot, "code-context-engine-mcp");
  const child = spawn(command, [], {
    cwd: installRoot,
    env: { ...process.env, CCE_ALLOWED_ROOTS: fixtureRoot },
    windowsHide: true,
    shell: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  await new Promise((resolve, reject) => {
    const onExit = (code) => {
      clearTimeout(timer);
      reject(new Error(
        "MCP server exited before smoke window with code " + code + ": " + stderr.trim()
      ));
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve();
    }, 400);
    child.once("error", (error) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      reject(error);
    });
    child.once("exit", onExit);
  });

  await stopChildTree(child);
}

async function verifyObservabilityUi(installRoot) {
  const modulePath = path.join(
    installRoot, "node_modules", "code-context-engine", "src", "observability", "api.js"
  );
  const { startObservabilityApi } = await import(pathToFileURL(modulePath).href);
  const api = await startObservabilityApi({
    port: 0, directory: path.join(installRoot, "telemetry")
  });
  try {
    for (const [route, expected] of [
      ["/", "CCE · 本地观测台"],
      ["/status", '"service":"cce-observability"'],
      ["/effects", '"controlled_experiment":{"status":"unavailable"']
    ]) {
      const response = await fetch(api.url + route);
      const body = await response.text();
      if (!response.ok || !body.includes(expected)) {
        throw new Error("packed observability " + route + " failed");
      }
    }
  } finally {
    await api.close();
  }
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cce-release-smoke-"));
try {
  const packDir = path.join(temp, "pack");
  const installRoot = path.join(temp, "consumer");
  const fixtureRoot = path.join(temp, "fixture");
  await fs.mkdir(packDir, { recursive: true });
  await fs.mkdir(installRoot, { recursive: true });
  await fs.mkdir(fixtureRoot, { recursive: true });

  const surface = await verifyPackSurface();
  const { stdout: packed } = await run(
    npm, ["pack", "--json", "--pack-destination", packDir], { cwd: root }
  );
  const filename = parseJson(packed, "npm pack")[0]?.filename;
  if (!filename) throw new Error("npm pack did not return a filename");

  await run(npm, ["init", "-y"], { cwd: installRoot });
  await run(npm, [
    "install", "--ignore-scripts", "--no-audit", "--no-fund",
    path.join(packDir, filename)
  ], { cwd: installRoot });

  const installed = parseJson(
    await fs.readFile(path.join(
      installRoot, "node_modules", "code-context-engine", "package.json"
    ), "utf8"),
    "installed package.json"
  );
  if (installed.version !== expectedVersion) {
    throw new Error("installed version mismatch: " + installed.version);
  }

  for (const bin of ["cce", "code-context-engine"]) {
    const help = await runBin(installRoot, bin, ["--help"]);
    if (!(help.stderr + help.stdout).includes("Code Context Engine v" + expectedVersion)) {
      throw new Error(bin + " --help did not report v" + expectedVersion);
    }
  }

  await createFixture(fixtureRoot);
  const index = parseJson(
    (await runBin(installRoot, "cce", ["index", "--repo", fixtureRoot])).stdout,
    "cce index"
  );
  if (index.ok !== true) throw new Error("packed cce index failed");

  const status = parseJson(
    (await runBin(installRoot, "cce", ["status", "--repo", fixtureRoot])).stdout,
    "cce status"
  );
  if (status.ok !== true) throw new Error("packed cce status failed");

  const query = parseJson(
    (await runBin(installRoot, "cce", [
      "query", "--repo", fixtureRoot, "--task", "publish homework", "--compact"
    ])).stdout,
    "cce query"
  );
  if (query.ok !== true) throw new Error("packed cce query failed");
  const selected = [...(query.must_read ?? []), ...(query.maybe_read ?? [])]
    .map((entry) => entry.path);
  if (!selected.includes("src/tasks.js")) {
    throw new Error("packed cce query did not select src/tasks.js");
  }

  await verifyMcpStarts(installRoot, fixtureRoot);
  await verifyObservabilityUi(installRoot);
  process.stdout.write(JSON.stringify({
    ok: true,
    package: "code-context-engine@" + expectedVersion,
    packed_surface: surface,
    cli_bins: ["cce", "code-context-engine"],
    mcp_bin: "code-context-engine-mcp",
    smoke: { index: true, status: true, query: true, mcp_start: true, observability_ui: true }
  }, null, 2) + "\n");
} finally {
  await fs.rm(temp, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 8 : 2,
    retryDelay: 250
  });
}
