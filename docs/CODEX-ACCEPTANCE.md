# Codex Desktop Acceptance — WP19-D

This acceptance closes the real-agent loop for CCE WP19 after the automated repository acceptance passes.

## Preconditions

- Windows repository: `D:\\GoProject\\code-context-engine`
- CCE MCP is registered in Codex Desktop.
- The repository is updated to the latest `main`.
- The MCP runtime is also updated to the same CCE commit used for this self-acceptance.
- Restart Codex Desktop after updating or repointing the stdio MCP runtime so an older server process cannot survive the update.
- Keep unrelated local experiment changes isolated or stashed before synchronizing `main`.

For CCE self-acceptance, the preferred development setup is to run the MCP server from the current repository checkout. If a separate stable runtime clone is used instead, it must be synchronized to the exact same commit before the acceptance begins.

## Automated repository acceptance

Run from the CCE repository:

```powershell
npm run acceptance:codex
```

Expected result:

- the command exits with code 0 and prints `"ok": true`;
- initial `context_index_status` semantics are fresh after indexing;
- a new untracked working-tree probe makes status stale before re-index;
- re-indexing returns status to fresh;
- adding the probe to Git local exclude makes status stale until the indexed copy is removed;
- runtime fingerprint recorded in the index matches the active runtime fingerprint after a successful index;
- the Semantic Provider query includes both `src/cli.js` and `src/server.js` in `must_read`;
- the CLI version task includes `src/cli.js` and `package.json` in `must_read`;
- the CLI version task returns at least one CLI-related test;
- the script restores the local exclude file and removes the probe in `finally`.

## Codex Desktop real-agent prompt

Ask Codex to work read-only and use CCE first:

```text
只读验收，不修改代码、不提交 Git。

这是 CCE 自身的真实检索验收。不要因为已经知道文件路径，就手动补读 CCE 没有返回的关键文件来把结果“补成通过”。

1. 先调用 CCE MCP 的 context_index_status，并原样报告：
   - stale
   - indexed_at
   - runtime.package_version
   - runtime.runtime_root
   - runtime.runtime_git_head
   - runtime.runtime_fingerprint
   - index_provenance.indexed_runtime_fingerprint
   - index_provenance.indexed_repository_head
   - index_provenance.current_repository_head
   - freshness.reasons

2. 这是 CCE 自身仓库的验收：
   - 如果 runtime.runtime_git_head 与 index_provenance.current_repository_head 都非空，它们必须相等。
   - 如果不相等，立即判定“运行时版本不一致”，停止后续 Query，不要继续验收。
   - 如果 stale=true，调用 context_index_repo，然后再次调用 context_index_status。
   - 第二次 status 必须 stale=false；否则停止并记录 FAIL。

3. 调用 context_query：
   查找 Semantic Provider 的 CLI 和 MCP 接入代码

4. 原样保留 CCE 返回的 must_read / maybe_read / tests。
   验收要求 CCE 自己返回：
   - src/cli.js
   - src/server.js
   如果缺任意一个，直接记录 Query 1 FAIL。
   不允许为了验收通过而手动直接打开缺失文件、不允许 rg、不允许遍历仓库补找。

5. 只有 Query 1 已满足上面要求时，读取 CCE 已返回的文件核对调用链。

6. 调用 context_query：
   为 CCE CLI 增加 --version 参数，并增加对应自动化测试

7. 原样保留 CCE 返回的 must_read / maybe_read / tests。
   验收要求 CCE 自己返回：
   - src/cli.js
   - package.json
   - tests 非空，并至少有一个与 CLI 主题相关的测试
   如果缺任意一项，直接记录 Query 2 FAIL。
   不允许手动直接打开 CCE 漏掉的 package.json 或已知测试路径来补结果。

8. 只有 Query 2 已满足上面要求时，再读取 CCE 已返回的文件核对源码。

9. 最后报告：
   - context_index_status 原始结果
   - runtime 是否与当前 CCE 仓库 commit 对齐
   - stale 是否被正确处理
   - 两次 CCE 原始结果
   - Query 1 是否由 CCE 自身返回 src/cli.js / src/server.js
   - Query 2 是否由 CCE 自身返回 src/cli.js / package.json / 相关 tests
   - 是否使用了任何额外文件搜索或手动补读遗漏路径；正常 PASS 时必须为“否”
   - git status --short

不要修改代码。
```

## Final WP19-D pass criteria

The real Codex Desktop run passes only when:

- active MCP runtime provenance is visible and aligned with the current CCE repository revision for this self-acceptance;
- `context_index_status` reports real working-tree freshness and becomes fresh after any required re-index;
- Query 1 surfaces `src/cli.js` and `src/server.js` without supplementary repository search or manually opening omitted known paths;
- Query 2 surfaces `src/cli.js`, `package.json`, and relevant tests without supplementary search or manually opening omitted known paths;
- Codex can complete source verification by directly reading files that CCE actually returned;
- `git status --short` is unchanged by the read-only acceptance.

If runtime provenance is mismatched, status remains stale, or supplementary search/manual omission repair is required, keep SGC-74 open and record the failure before changing any other retrieval behavior.
