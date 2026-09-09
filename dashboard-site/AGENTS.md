# dashboard-site — project conventions

The CAFE Dataverse Dashboard: an analysis pipeline plus a static site, published
to <https://climate-cafe.github.io/dv-dashboard>.

This file is also the **project-root marker**. The R scripts anchor paths with
`here::here()` off the `.here` sentinel beside it; the Python scripts walk up
for `AGENTS.md`. Neither uses `setwd()` or a relative path, so any script runs
identically from the project root, from its own directory, or pasted into an
interactive session.

## Layout

```
dashboard-site/
├── config/dashboard-config.yml   single source of truth for every tunable
├── analysis/
│   ├── R/          descriptive summaries        → public/data/*.json
│   ├── python/     metadata fetch + similarity  → public/data/*.json
│   └── derived/    intermediates shared between the two halves (gitignored)
├── public/         the deployed site; public/data/ is committed
├── cache/          raw API responses and full description text (gitignored)
└── deploy/         GitHub Pages workflow
```

## The rule that matters most

**Every number shown on the site is produced by a script that runs on its own.**
No analysis lives in the site's JavaScript, and none of it needs the site to be
running. `analysis/README.md` lists each script, what it reads, what it writes,
and how to run just that one.

The site's JavaScript filters, sorts, and draws. It does not compute statistics.

## Language split

R does the descriptive layer, Python does the semantic-similarity layer. That
split is deliberate: the team reviewing this work has both R and Python users,
and each half is readable without the other. The two communicate only through
`analysis/derived/` and `config/dashboard-config.yml`.

## Conventions

**R.** `renv` for dependencies. Base pipe `|>`. tidyverse verbs over `[`
indexing. Multi-line pipelines end-assign with `->` and the object name on its
own line at the left margin. Paths via `here::here()`.

**Python.** `uv` for dependencies, `ruff` for lint and format. Type hints on
function signatures. `pathlib` over `os.path`. `httpx` for HTTP.

**Both.** No hardcoded absolute paths. No `setwd()` / `os.chdir()`. Anything that
changes a published number goes in `config/dashboard-config.yml`, not inline.

## Privacy

This repository is public. Two rules follow.

**No personal data is committed.** The extract set on disk is already the
"no-personal-data" subset, and the API fetch drops EMAIL-typed fields and
dataset-contact fields before anything reaches disk. `just check-privacy` scans
everything staged for commit and fails on an address.

**No bulk data is committed.** `dv-data/` and `cache/` are gitignored.
`public/data/` holds only what the site draws: aggregates, plus one row per
discoverable dataset with a truncated description snippet.

## Data provenance

`dv-data/` is the SQL extract set pulled from the Harvard Dataverse application
database on 2026-09-08. It is gitignored: SETUP.md records that the sharing
route for it has not been settled.

Dataset descriptions are **not** in that set. Extracts 1.4 and 1.7, which carry
them, were withheld because they contain email addresses depositors typed into
abstracts. Descriptions are re-acquired from Harvard Dataverse's public
read-only Search API by `analysis/python/10_fetch_public_metadata.py`. See
`analysis/README.md` for why that is the only route, and what it costs.
