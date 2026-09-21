import test from "node:test";
import assert from "node:assert/strict";
import { isBlockedFile, redactSecrets } from "../src/security.js";

test("blocks common secret-bearing files", () => {
  assert.equal(isBlockedFile(".env"), true);
  assert.equal(isBlockedFile("certs/server.key"), true);
  assert.equal(isBlockedFile("src/app.go"), false);
});

test("redacts common credential forms", () => {
  const output = redactSecrets("api_key=abc123 password='hunter2' Authorization: Bearer secret-token");
  assert.equal(output.includes("abc123"), false);
  assert.equal(output.includes("hunter2"), false);
  assert.equal(output.includes("secret-token"), false);
});
