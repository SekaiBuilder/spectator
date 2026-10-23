# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use
[GitHub's private vulnerability reporting](https://github.com/SekaiBuilder/spectator/security/advisories/new)
with a description, steps to reproduce and the version you used. You will get an answer as soon as possible.

## What Spectator does with your code

- The analysis runs locally in a separate Node.js process and makes no network requests.
- Network traffic only happens when you ask for it: the API watcher and *Running app* call the application you point them at; starting a Spring Boot app lets Maven download missing dependencies; the optional deep scan runs `npm audit` (which contacts the npm registry), `gitleaks` and `osv-scanner` if they are installed.
- Detected credentials are masked in the panel, the HTML report and the JSON output. Masking depends on detection patterns: review a report before sharing it.
- The API watcher listens on `localhost` only. It does not store authentication headers or request bodies; error responses are kept as a short fragment with passwords and tokens masked.
- The Timeline reads the local logs of Claude Code and Codex only to get file paths, times and the changed fragment, never the conversation. It can be turned off with `spectator.chronology.aiLogs`.

## Scope

Security rules find **patterns** in code. A finding proves the pattern exists, not that it is exploitable,
and no finding does not mean the code is secure.
