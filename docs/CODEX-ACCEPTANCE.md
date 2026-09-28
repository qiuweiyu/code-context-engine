# Codex Desktop Acceptance — WP19-D

This acceptance closes the real-agent loop for CCE WP19 after the automated repository acceptance passes.

## Preconditions

- Windows repository: `D:\\GoProject\\code-context-engine`
- CCE MCP is registered in Codex Desktop.
- The repository is updated to the latest `main`.
- Keep any unrelated local experiment changes isolated or stashed before synchronizing `main`.

## Automated repository acceptance

Run from the CCE repository:

```powershell
npm run acceptance:codex
```

Expected result:

- the command exits with code 0 and prints `"ok": true`;
- the Semantic Provider query includes both `src/cli.js` and `src/server.js` in `must_read`;
- the CLI version task includes `src/cli.js` and `package.json` in `must_read`;
- the CLI version task returns at least one CLI-related test;
- an untracked probe test is indexed before `git add`;
- after the probe is added to Git's local exclude file it is removed from the temporary index;
- the script restores the local exclude file and removes the probe in `finally`.

## Codex Desktop real-agent prompt

Ask Codex to work read-only and use CCE first:

```text
只读验收，不修改代码、不提交 Git。

1. 先调用 CCE MCP 的 context_index_status 检查当前仓库索引。
2. 如果索引 stale，再调用 context_index_repo；否则不要重复索引。
3. 调用 context_query：
   查找 Semantic Provider 的 CLI 和 MCP 接入代码
4. 原样保留 CCE 返回的 must_read / maybe_read / tests，然后核对源码。
5. 再调用 context_query：
   为 CCE CLI 增加 --version 参数，并增加对应自动化测试
6. 原样保留 CCE 返回的 must_read / maybe_read / tests，然后核对源码。
7. 只有 CCE 没有提供完成核对所需的入口、manifest 或测试文件时，才允许额外使用 rg/搜索。
8. 最后报告：
   - 两次 CCE 原始结果
   - 是否包含 src/cli.js
   - 第一条是否包含 src/server.js
   - 第二条是否包含 package.json
   - 第二条 tests 是否非空且相关
   - 是否使用了额外 rg/搜索；如果用了，列出原因和命令
   - git status --short
不要修改代码。
```

## Final WP19-D pass criteria

The real Codex Desktop run passes when:

- Query 1 surfaces `src/cli.js` and `src/server.js` without supplementary repository search.
- Query 2 surfaces `src/cli.js`, `package.json`, and relevant tests without supplementary repository search.
- Codex can complete source verification from CCE guidance plus direct reads of returned files.
- `git status --short` is unchanged by the read-only acceptance.

If supplementary `rg` or broad search is still required, keep SGC-74 open and record the missing surface as the next retrieval defect.
