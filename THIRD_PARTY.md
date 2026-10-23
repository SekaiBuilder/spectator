# Third-party components

Nothing ships in Spectator without a known license.

## Bundled in the extension

| Component | Use | Integration | License |
|---|---|---|---|
| web-tree-sitter 0.22.6 | Incremental parser (WASM) | Dependency | MIT |
| tree-sitter grammars (JS, TS, TSX, Python, Swift, Kotlin, Go, Java, C#, Rust, PHP, Ruby) via tree-sitter-wasms 0.1.13 | Per-language syntax | `.wasm` binaries copied to `grammars/` | MIT for each grammar; the package that builds them, Unlicense |

## Run as external processes (not distributed)

| Tool | Use | When | License |
|---|---|---|---|
| npm audit | Vulnerable dependencies | Deep scan, when `package-lock.json` exists | Artistic-2.0 (npm CLI) |
| gitleaks | Secrets | Deep scan, when installed | MIT |
| osv-scanner | Vulnerabilities in every ecosystem | Deep scan, when installed | Apache-2.0 |

The gitleaks and osv-scanner adapters are written but have **not yet been tested against the real tools**.
