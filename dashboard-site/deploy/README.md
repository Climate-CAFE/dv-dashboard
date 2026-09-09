# Deployment

The dashboard publishes to <https://climate-cafe.github.io/dv-dashboard> from
`dashboard-site/public/`.

## The one file outside `dashboard-site/`

`SETUP.md` asks that everything this project creates live under
`dashboard-site/`. One file cannot: GitHub reads workflows only from
`.github/workflows/` in the repository root, so the deploy workflow lives at

```
.github/workflows/deploy-pages.yml
```

Nothing else escapes. If you move this project into another repository, that
file is the one thing to carry across separately.

## Turning it on

Once, in the repository settings:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   Not "Deploy from a branch". The site lives in a subdirectory, and branch
   deployment can only serve the repository root or `/docs`.
2. Push to `main`. The workflow runs on any change under
   `dashboard-site/public/`, and can also be started by hand from the Actions
   tab.

The first deploy takes a minute or two; subsequent ones are faster.

## What the workflow does

It **copies** `dashboard-site/public/` to Pages. It does not run the analysis.

That is a deliberate consequence of where the data sits. The pipeline reads
`dv-data/`, which is gitignored while the team decides how those extracts will
be shared, so CI has nothing to run the analysis against. The generated payload
in `public/data/` is committed for the same reason.

**The contract this creates:** whoever changes the analysis runs `just build`
locally and commits `public/data/` in the same change as the code. Code and
data move together or the site goes stale silently.

Three checks guard the gap, and they run before anything is published:

| Check | Catches |
|---|---|
| Site data present and non-empty | A code change committed without rebuilding |
| No email addresses in `public/` | The failure mode this project is most exposed to |
| `pytest` against `public/data/` | Scope arithmetic, tree roll-up, explorer parity, neighbour integrity |

The tests run against the committed payload alone, so they work in CI without
`dv-data/` and without network access.

## Local preview

```sh
just serve          # http://localhost:8000
just serve 9000     # another port
```

`public/` is a plain static directory. Every path in it is relative, so it
behaves identically at `http://localhost:8000/` and at
`https://climate-cafe.github.io/dv-dashboard/`. There is no build step and no
base-path configuration to get wrong.

## When `dv-data/` finds a permanent home

`SETUP.md` leaves that open, with publication to Dataverse as one possibility.
When it is settled, the workflow can fetch the extracts and run the pipeline in
CI instead of trusting a committed payload. The pipeline is already
deterministic, its only network dependency is Harvard Dataverse's public API,
and both environments restore from lockfiles, so the change is to add a fetch
step and replace the copy with:

```yaml
- run: |
    cd dashboard-site
    just setup
    just fetch
    just build
```

At that point `public/data/` could stop being committed. Until then it must be.
