# CAFE Dataverse Dashboard

An interactive dashboard for the [CAFE Research Coordinating Center
collection](https://dataverse.harvard.edu/dataverse.xhtml?alias=CAFE) on Harvard
Dataverse, published at
<https://climate-cafe.github.io/dv-dashboard>. It summarises the collection's
1,307 published datasets across their metadata, lets you filter and re-aggregate
them, draws the collection hierarchy at scale, and positions every dataset by
keyword and description similarity.

It is built for a team that reviews its own numbers. Every figure the site shows
is produced by a script that runs on its own, in R or in Python, without the
site running.

## Quick start

```sh
cd dashboard-site
just setup     # restore the R (renv) and Python (uv) environments
just fetch     # re-acquire public metadata from Harvard Dataverse
just build     # run the pipeline: R descriptives, then Python similarity
just serve     # preview at http://localhost:8000
```

`just build` needs the SQL extract set at `../dv-data/`. `just fetch` needs
network access, and caches, so it is a one-time cost. Without either, the
committed `public/data/` still serves and `just serve` still works.

Run `just` on its own to list every recipe.

## Layout

```
dashboard-site/
├── config/dashboard-config.yml   every tunable that changes a published number
├── analysis/
│   ├── R/          01–08, descriptive summaries      → public/data/*.json
│   ├── python/     10–12, metadata fetch + similarity → public/data/*.json
│   ├── derived/    intermediates shared between the two (gitignored)
│   └── README.md   the audit guide: what each script does and how to run it
├── public/         the deployed site; public/data/ is committed
├── tests/          contract tests for the published payload
├── cache/          raw API responses and full description text (gitignored)
└── deploy/         GitHub Pages setup and the one file that lives outside here
```

## How it is put together

**R does the descriptive layer, Python does the semantic-similarity layer.** The
split is deliberate: the people reviewing this work include both R and Python
users, and each half is readable without the other. The two communicate only
through `analysis/derived/` and `config/dashboard-config.yml`.

**The site computes nothing.** Its JavaScript filters, sorts, and draws. The
Explorer re-aggregates a pre-parsed table as you filter, and with every filter
cleared its totals equal the Overview's exactly — `tests/test_site_data.py`
asserts that, so the site cannot drift into being a second, competing analysis.

**Everything that took a decision is in one place.** Which datasets are in
scope, what counts as an author, how a keyword is normalised, which collection a
linked dataset belongs to: all of it is decided in `analysis/R/01-datasets.R`
and configured in `config/dashboard-config.yml`.

## Two things that will bite you

**"Published" is not "visible."** Harvested datasets are fully live but carry no
publication date. Filtering on `publication date is not null` silently drops 513
of 1,307 datasets — 39% of the collection. The test throughout is
`published locally OR harvested`.

**Descriptions are not in the extract set.** Extracts 1.4 and 1.7 hold the
abstracts and were both withheld because depositors type email addresses into
them, and no field-type filter reaches free text. They are re-acquired from
Harvard Dataverse's public read-only Search API by
`analysis/python/10_fetch_public_metadata.py`, which drops contact fields and
redacts addresses before writing anything.

## Privacy

The repository is public, so nothing personal is committed. The extract set on
disk is already the "no-personal-data" subset; the API fetch drops email-typed
and contact fields; depositor usernames are dropped in the first analysis script
rather than merely left unselected later; per-dataset view-by-country cells are
suppressed below five datasets.

`just check-privacy` scans every git-tracked file for addresses and fails on
one. It reads the files rather than trusting column names, which is the only
method that works here: of the nine extracts found to contain addresses, five
were in columns whose names gave no hint, and one had them inside filenames.

`just check` runs the linter, the tests, and that scan together. Run it before
pushing.

## Reproducing a single number

Every script says what it reads and what it writes in its header, and runs on
its own:

```sh
Rscript analysis/R/04-keywords.R                          # just the keyword summaries
uv run python analysis/python/11_keyword_similarity.py    # just the keyword similarity
```

Or from an interactive session, which is the point of the split:

```r
source(here::here("analysis", "R", "setup.R"))
datasets <- read_derived("datasets.tsv", CFG)
```

```python
import sys; sys.path.insert(0, "analysis/python")
from cafedash import load_config, read_extract
read_extract("2.15", load_config()).shape
```

See `analysis/README.md` for the full guide.

## What the data cannot tell you

Three items on the original request sheet have no answer in this database, and
the dashboard says so rather than approximating quietly: search-term frequency
(Dataverse stores no searches), views by individual user (only monthly
aggregates exist), and the location of a contributor (no such field; author
affiliation is the nearest proxy and is an institution, not a place). The
Methods page covers each in full.

## Next

Usage and citation data from outside Dataverse — the web-scraped citations
`SETUP.md` anticipates — is the obvious addition. External citations currently
stand at 21 across the whole collection, which reflects what DataCite has
registered rather than how often these datasets have been used.
