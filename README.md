# dv-dashboard

Interactive dashboard showcasing trends and summary statistics for the datasets
in the CAFE Dataverse collection and its subcollections.

**Live at <https://climate-cafe.github.io/dv-dashboard>**

The dashboard summarises the 1,307 published datasets in the
[CAFE Research Coordinating Center collection](https://dataverse.harvard.edu/dataverse.xhtml?alias=CAFE)
on Harvard Dataverse: what the collection holds, who contributed it, what it
covers in space and time, how the subcollections nest, and which datasets
resemble each other by keyword and by description.

## Where things are

| Path | What it is |
|---|---|
| [`dashboard-site/`](dashboard-site/) | Everything: the analysis pipeline and the site |
| [`dashboard-site/README.md`](dashboard-site/README.md) | Start here |
| [`dashboard-site/analysis/README.md`](dashboard-site/analysis/README.md) | The audit guide: every script, what it decides |
| [`dashboard-site/deploy/README.md`](dashboard-site/deploy/README.md) | Publishing to GitHub Pages |
| [`setup/SETUP.md`](setup/SETUP.md) | The original brief |
| `dv-data/` | The SQL extract set (gitignored) |

## Building it

```sh
cd dashboard-site
just setup     # restore the R (renv) and Python (uv) environments
just fetch     # re-acquire public metadata from Harvard Dataverse
just build     # run the pipeline: R descriptives, then Python similarity
just serve     # preview at http://localhost:8000
just check     # lint, tests, and the privacy scan
```

`just build` needs the extract set at `dv-data/`. Without it, the committed
site data still serves and `just serve` still works.

## How it is organised

**All data processing is in scripts that run on their own.** R does the
descriptive layer and Python does the semantic-similarity layer, so the work is
reviewable by both halves of the team, and any single script can be run and
audited in an interactive session without the dashboard running. The site's
JavaScript filters, sorts, and draws; it computes no statistics of its own, and
a test asserts that its unfiltered totals match the ones R produced.

## Two things to know before reading a number

**Drafts are excluded**, as the brief requires: 545 of the 1,852 datasets in
CAFE scope.

**"Published" is not "visible."** Harvested datasets are fully live but carry no
publication date, so filtering on `publication date is not null` silently drops
513 of 1,307 datasets. The test used throughout is
`published locally OR harvested`. The dashboard's Methods page covers this and
every other decision that moves a number.

## Data

`dv-data/` is gitignored: how those extracts will be shared has not been
settled, and publication to Dataverse is one option under consideration. The
aggregated payload the site draws from is committed under
`dashboard-site/public/data/`, and carries no personal data. See
`dashboard-site/deploy/README.md` for what that means for deployment, and the
dashboard's Methods page for the privacy decisions behind it.
