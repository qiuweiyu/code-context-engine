import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { sha256Text } from "./hash.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const helperDir = path.resolve(here, "../../internal/goindexer");
const helperSource = path.join(helperDir, "main.go");
const helperModule = path.join(helperDir, "go.mod");
const helperSum = path.join(helperDir, "go.sum");
export const GO_ANALYZER_VERSION = "2";
let cachedBinaryPromise = null;

function runProcess(command, args, { input = "", timeout = 120000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(cwd ? { cwd } : {})
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out`)); }, timeout);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 64 * 1024 * 1024) child.kill(); });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 2000)}`));
    });
    child.stdin.end(input);
  });
}

async function buildHelperBinary() {
  const parts = [
    await fs.readFile(helperSource, "utf8"),
    await fs.readFile(helperModule, "utf8"),
    await fs.readFile(helperSum, "utf8").catch(() => "")
  ];
  const digest = sha256Text(parts.join("\n--cce-go-helper--\n")).slice(0, 16);
  const ext = process.platform === "win32" ? ".exe" : "";
  const dir = path.join(os.tmpdir(), "code-context-engine");
  await fs.mkdir(dir, { recursive: true });
  const binary = path.join(dir, `goindexer-${digest}${ext}`);

  try {
    await fs.access(binary);
    return binary;
  } catch {}

  const buildOutput = path.join(
    dir,
    `goindexer-${digest}-${process.pid}.build${ext}`
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

export async function prepareGoAnalyzer() {
  await helperBinary();
}

export async function analyzeGoFiles(repoRoot, files) {
  if (!files.length) return new Map();
  const binary = await helperBinary();
  const payload = JSON.stringify({ root: repoRoot, files });
  const { stdout } = await runProcess(binary, [], { input: payload, timeout: 120000 });
  const out = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line);
    out.set(parsed.file_path, parsed);
  }
  return out;
}
