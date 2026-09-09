# Audit guide

Every number on the dashboard is produced here. This is the map: what each
script reads, what it writes, what it decides, and how to run just that one.

`SETUP.md` asks that the analyses "can be run and audited in isolation, so that
we can review the analyses individually in an R or python interactive session
without launching the dashboard itself." That is the organising constraint. No
script needs the site, none needs the others except in the order below, and each
leaves its objects in the session when sourced.

## Order

```
10  fetch public metadata      Python   network; caches
     ↓
01  build the dataset table    R        decides scope; everything reads this
     ↓
02–08  descriptive summaries   R        independent of each other
11–12  similarity              Python   independent of 02–08
```

Only two edges are real: 01 needs 10, and everything else needs 01. Within
02–08 and 11–12, order does not matter.

## Running one script

```sh
# R
Rscript analysis/R/04-keywords.R

# Python
uv run python analysis/python/11_keyword_similarity.py
```

Interactively, which is the point of the split:

```r
source(here::here("analysis", "R", "setup.R"))   # packages, config, paths
datasets <- read_derived("datasets.tsv", CFG)
keywords <- read_derived("dataset-keywords.tsv", CFG)
raw      <- read_extract("2.15", CFG)            # any extract, by query number
```

```python
import sys

sys.path.insert(0, "analysis/python")
from cafedash import load_config, read_extract
from cafedash.similarity import keyword_jaccard

config = load_config()
roll_up = read_extract("2.15", config)
```

Sourcing a numbered R script leaves every intermediate in the session, so you
can check a step rather than only its output.

## What each script does

### 10 · `python/10_fetch_public_metadata.py`

Fetches public citation metadata from Harvard Dataverse's Search API.

**Why it exists.** Extracts 1.4 and 1.7, the only place dataset descriptions
appear, were withheld from the extract set because depositors type email
addresses into abstracts and no field-type filter reaches free text. The
description-similarity analysis cannot be done without them.

**Two passes.** The plain search result is reliable at `per_page=1000`, so the
whole collection arrives in two requests. Adding `metadata_fields=citation:*`
returns author affiliations and time-period-covered — and 500s on individual
records, every harvested one included. The second pass bisects around the
failures and reports which ids it could not serve.

**Privacy.** Contact and email-typed fields are dropped before serialisation;
free-text addresses are redacted by pattern; the script refuses to finish if one
survives into its output.

Writes `cache/` (gitignored) and `analysis/derived/public-metadata.tsv`.

### 01 · `R/01-datasets.R`

Builds the canonical dataset table. **This is where scope is decided**, once, so
the R and Python halves cannot disagree about which datasets are in the
analysis.

Decisions it makes:

- **Drafts out, harvested in.** A dataset is live if it has a local publication
  date *or* is harvested. The obvious test — has a publication date — drops 513
  of 1,307 datasets.
- **Subcollection for linked datasets.** A dataset linked into CAFE lives in a
  collection outside the CAFE tree, so its own alias says nothing about where it
  appears. Datasets in a linked collection are resolved by walking their
  ancestry against the collection-link table.
- **Author parsing**, with descriptor labels removed by whole-string match.
- **Keyword parsing**, from the extract with one row per value.
- **Drops depositor usernames** at the earliest point rather than relying on
  them not being selected later.

Two checks run before it writes: published plus harvested must equal
discoverable, and the master roll-up must agree with its own drill-down extracts
on views and citations for every dataset.

Writes `analysis/derived/*.tsv`, `public/data/datasets.json`, `scope.json`.

### 02 · `R/02-overview.R`

The unfiltered reference figures the Overview page prints. The Explorer
recomputes the same quantities in the browser; with no filter applied the two
must agree, and `tests/test_site_data.py` asserts they do.

Separates the `N/A` subject placeholder, which Dataverse assigns to records
arriving without a subject and which accounts for 39% of the distribution.

### 03 · `R/03-authors.R`

Per-author aggregates, co-authorship pairs, affiliation counts. Parsing happened
in 01; this only aggregates, which keeps "what counts as an author" in one place.

Per-author totals count a dataset once per author, so they exceed the collection
totals. That is what a per-author view means and the output says so.

### 04 · `R/04-keywords.R`

Keyword frequency, keyword-by-subcollection, the keywords that most distinguish
each subcollection (by lift, not raw frequency — raw frequency inside a
subcollection just re-reports the collection-wide top terms), and co-occurrence.

Cross-checks its counts against the extract's own keyword census and warns if
the two parsings disagree.

### 05 · `R/05-collections.R`

The collection hierarchy with a cumulative roll-up on every node. Refuses to
write if the root total does not equal the scoped dataset count, or if any
parent comes out smaller than its own subtree.

### 06 · `R/06-temporal.R`

Keeps two dates strictly apart: when the data is *about* (time period covered)
and when the dataset was *deposited*. A 2024 deposit of 1950–2000 observations
belongs in both, in different places.

### 07 · `R/07-geography.R`

Three geographies that answer three different questions, never combined: where
the data is about, where viewers are, and what institution an author gave.
Suppresses per-dataset country cells below five datasets.

### 08 · `R/08-files-usage.R`

Files, content types, storage, tags, downloads, views, citations. Everything
here measures the latest released version only.

### 11 · `python/11_keyword_similarity.py`

Three keyword-similarity methods, differing in how much a shared keyword counts
and whether two different keywords can count as related at all:

| Method | What it adds |
|---|---|
| Jaccard | The honest baseline. Every keyword counts the same. |
| TF-IDF cosine | Weights each keyword by rarity. Sharing *earth science* stops meaning as much as sharing *pneumoconiosis*. |
| PPMI + SVD | Learns a keyword space from co-occurrence, so *heat wave* and *extreme heat* can match without being the same string. |

### 12 · `python/12_description_similarity.py`

Three description-similarity methods over the same TF-IDF matrix, so they are
comparable by construction: TF-IDF cosine (shared wording), LSA (a latent
projection that lets different words match), and NMF (a topic model whose
dimensions can be read and named).

**No neural embedding, deliberately.** A sentence-transformer would match
meaning better and would add roughly a gigabyte of dependencies plus a model
checkpoint that is not in this repository — which would end the property that
any reviewer can rerun any step from a clean clone. A fourth method returning an
n×n similarity matrix drops into `cafedash/similarity.py` and appears in the
site's dropdown with no other change, if the team decides the trade should go
the other way.

## Where the justification text lives

Each similarity method's explanation — including what it gets wrong — is written
in the same function as its implementation, in `python/cafedash/similarity.py`,
and carried into the JSON the site loads. Change how a metric is computed
without changing its `justification` and the diff shows it, because both are in
the same function. A test asserts that every method states both what it measures
and its limitations.

## Shared modules

| Module | What it holds |
|---|---|
| `R/functions.R` | Extract reading, type coercion, author and keyword normalisation, JSON writing |
| `R/setup.R` | Sourced by every numbered script: packages, config, paths |
| `python/cafedash/extracts.py` | Extract reading, with the quoted-CSV handling the files require |
| `python/cafedash/textprep.py` | Description cleaning |
| `python/cafedash/similarity.py` | Every similarity method, with its justification |
| `python/cafedash/bundle.py` | Projection, clustering, neighbours, JSON shape |

Two details worth knowing before writing anything new:

**The extracts are quoted CSV with a tab delimiter, not naive TSVs.** Extract
3.2's `description` column holds HTML with embedded newlines, so a split-on-tab
reader invents rows. Both halves use a real RFC-4180 parser.

**Join on `doi_key()`, never on `global_id`.** DOIs are case-insensitive and the
two sources disagree: the application database lowercases harvested DOIs, the
API uppercases them. Joining on the raw string loses all 513 harvested datasets
and looks like missing data rather than a join bug.

## Configuration

`config/dashboard-config.yml` holds everything that changes a published number:
the scope rule, the descriptor labels stripped from author lists, the keyword
stoplist, every similarity parameter, and the random seed. Both halves read it.
Anything tuned inline in a script instead is a bug.
