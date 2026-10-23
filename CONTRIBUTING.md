# Contributing to Spectator

Thanks for helping. Spectator has one unusual rule: **a finding that is wrong is worse than no finding**,
because people act on it. Please keep that in mind in every change.

## Principles

1. **Deterministic.** Same code in, same result out. No network calls and no AI inside the engine.
2. **Honest labels.** Call something a *failure* only when the code shows it. Anything that needs judgement is a *risk*; anything only the user knows is a *decision*.
3. **Say what was not analyzed.** Skipped files, missing tools and partial results must stay visible.
4. **Nothing leaves the machine.** Reports mask detected credentials; tests never hit the network.

## Development

Requires Node.js 22 or newer (the CLI alone runs on Node.js 20).

```bash
npm install          # also copies the tree-sitter grammars into grammars/
npm test             # engine, languages, frameworks, translations
npm run test:vscode  # optional: runs the extension inside your installed VS Code with a temporary profile
node src/cli.js scan examples/restaurante --html
```

`examples/` holds small projects with known answers, one per framework. When you fix a false positive or
add a rule, add a regression test next to the existing ones (see `test/reales.test.js`).

## Translations

Spanish is the source language: user-facing text is written as ``t`Texto en español` ``
and translated in `src/core/catalog.js` as `[es, en, ja]`. `npm test` fails if a string is missing a translation.
Improvements to the English and Japanese texts are very welcome.

Code comments are mostly in Spanish. New comments may be in English.

## Reporting a false positive

Open an issue with the smallest snippet that reproduces it, what Spectator said, and what it should have said.
False positives are treated as bugs.

## Pull requests

- One topic per pull request, with tests.
- Run `npm test` before pushing; CI runs it on Linux and macOS. Help with Windows support is very welcome.
- Keep the README in sync with what the code actually does.

By contributing you agree that your contribution is licensed under the Apache License 2.0.
