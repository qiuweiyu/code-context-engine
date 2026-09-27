# Security

## Source privacy

Code Context Engine is intended to operate locally. The deterministic core does not upload source code or require an external model/API.

Semantic Provider v1 is optional and explicit opt-in. CCE-owned provider requests contain bounded task/candidate metadata and do not contain source-file bodies. A user-configured external provider is a separate process and may have its own network/privacy behavior; review that provider before enabling it.

## Sensitive files

CCE excludes common secret-bearing files such as `.env`, private keys, certificates, credential files and common lockfiles. This is defense-in-depth, not a complete DLP system.

Do not assume a repository is safe to share merely because CCE indexed it.

## MCP filesystem boundary

When using the MCP server, set `CCE_ALLOWED_ROOTS` to the smallest directory tree that should be accessible.

Example:

```bash
export CCE_ALLOWED_ROOTS=/home/me/projects
```

## Reporting a vulnerability

Please avoid publishing exploitable details in a public issue before a fix is available. Open a GitHub security advisory when repository security reporting is enabled, or contact the maintainer privately through the GitHub profile.
