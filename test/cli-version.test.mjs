import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("CLI --version prints package.json version exactly", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(projectRoot, "package.json"), "utf8")
  );

  const result = await execFileAsync(
    process.execPath,
    [path.join(projectRoot, "src/cli.js"), "--version"],
    {
      cwd: projectRoot,
      windowsHide: true,
      encoding: "utf8"
    }
  );

  assert.equal(result.stdout, packageJson.version + "\n");
  assert.equal(result.stderr, "");
});

test("CLI --help behavior remains intact", async () => {
  const result = await execFileAsync(
    process.execPath,
    [path.join(projectRoot, "src/cli.js"), "--help"],
    {
      cwd: projectRoot,
      windowsHide: true,
      encoding: "utf8"
    }
  );

  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Code Context Engine v\d+\.\d+\.\d+/);
  assert.match(result.stderr, /Commands:/);
});
