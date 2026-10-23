# Changelog

## 0.12.1 (2026-10-23)

First public release. Fixes found while analyzing the official
[FastAPI full-stack template](https://github.com/fastapi/full-stack-fastapi-template):

- FastAPI: dependency aliases such as `SessionDep = Annotated[Session, Depends(get_db)]` are no longer listed as request parameters.
- A connection URL that takes its password from a variable (`postgresql://user:${POSTGRES_PASSWORD}@…`) is no longer reported as a hardcoded credential.
- Helpers that live in their own folder (`tests/utils/`, `e2e/helpers/`) are no longer "tests that check nothing".
- Masking a detected credential such as `password123` no longer hides the word `password` in unrelated text.
- Endpoint summaries and example requests are fully translated (no Spanish `y`, `texto` or `ejemplo.com` in English).
- Licensed under Apache-2.0.

## 0.12.0

- Backend map for Django and Django REST Framework: `urls.py` routes, function and class views, ViewSets, serializers and models.
- Typical AI mistakes in Django: route to a missing view, `save()` without `is_valid()`, `.objects.get()` without "does not exist" handling, `fields = "__all__"`, `@csrf_exempt`, `DEBUG = True` with `ALLOWED_HOSTS = ["*"]`.
- Tested on ten real projects: Express routers created by functions, `:id` in *Try it*, in-memory calls no longer shown as database steps, far fewer false SQL-concatenation alarms, keys in tests and docs downgraded to risks.

## 0.11.0

- Backend map for FastAPI, Flask, Next.js and NestJS, each with an example project with known answers in `examples/`.
- *Try it*: a ready-to-copy `curl` request per endpoint with values that satisfy its rules.
- Timeline marks AI edits made through terminal commands as "probable".
- Several folders in one window, each with its own analysis.

## 0.10.0

- Backend map for Spring Boot and Express: endpoints, step-by-step flow, DTOs and their rules, entities, external APIs and a glossary.
- Timeline of today's changes and which AI made them (Claude Code, Codex).
- Five-tab navigation: Summary, Activity, Problems, Map, Rules.

## 0.6.x

- Activity tab, API watcher with every HTTP status explained, log reading for Java/Kotlin, Node.js, Python, C# and Go.
- Simple / Professional toggle. Tested inside a real VS Code instance (`npm run test:vscode`).

## 0.5.0 and earlier

- Plain-language interface built around "what do I do now?".
- Reliability fixes: an empty result is "nothing detected in what was analyzed", never "correct"; incomplete analysis is always visible; `spectator trace` returns the program's exit code.
- Project parts, map by levels (parts → files → functions), `broken-import` failure, scope-aware call resolution for JS/TS and Python, incremental cache.
