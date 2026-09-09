#!/usr/bin/env python3
"""Fetch public citation metadata for the CAFE collection from Harvard Dataverse.

WHY THIS SCRIPT EXISTS
----------------------
`SETUP.md` requires a description-similarity analysis and says "each dataset's
full description is available in the metadata." It is, in extracts 1.4 and 1.7.
Neither is on disk. Nine of the 53 produced extracts carried email addresses
that depositors had typed into abstracts, notes and disclaimers, and those nine
were withheld from the "no-personal-data" set. 1.4 and 1.7 are two of them, and
they are the only place descriptions appear.

No field-type filter can strip a free-text address, so withholding them was the
right call. It also means the description text has to come from somewhere else.

WHERE IT COMES FROM
-------------------
Harvard Dataverse's public, unauthenticated, read-only Search API. This is
tier 1 of the acquisition ladder: a documented API, not a scraper.

TWO PASSES, AND WHY
-------------------
Pass 1 asks for the plain search result. It is reliable at `per_page=1000`, so
the whole collection arrives in two requests. It supplies titles, descriptions,
keywords, subjects, producers, publication status and dates.

Pass 2 adds `metadata_fields=citation:*`, which returns the full citation block:
author **affiliations** and **timePeriodCovered** ("date range for the data
contained in the dataset" in SETUP.md) appear nowhere else.

Pass 2 needs the adaptive splitting below because **the API 500s on individual
records when the citation block is requested**. Measured 2026-09-08: `per_page=1
start=42` returns `IndexOutOfBoundsException`; the same record fetched without
`metadata_fields` is fine. Any page containing such a record fails as a whole,
which is why a naive `per_page=100` walk cannot get past the first page. So
pass 2 requests a chunk, and on failure bisects down to single records, skipping
only the ones that genuinely cannot be served. The skipped ids are reported and
written to `cache/citation-unavailable.txt`; those datasets keep everything
pass 1 gave them and simply lack affiliation and time coverage.

Two details that matter for how long pass 2 takes. A 500 here is **not
retried**: it is a deterministic server-side defect, so retrying it four times
with exponential backoff buys nothing and costs minutes -- only transport
faults and rate-limit responses are retried. And the chunks are fetched
concurrently under a small semaphore, because bisection multiplies the request
count and the requests are pure I/O wait.

WHAT IT WILL NOT WRITE
----------------------
Email addresses. `datasetContact*` fields and anything of type EMAIL are dropped
before a record is serialised, matching both the `mv.fieldtype <> 'EMAIL'`
filter the SQL pack applies and Dataverse's own `:ExcludeEmailFromExport`
behaviour. Free-text addresses in abstracts, which no structural filter reaches,
are redacted by regex. The check is applied before anything touches disk, so the
gitignored cache is clean too, and `main()` refuses to finish if one survives.

OUTPUTS
-------
  cache/api-pages/base-XXX.json          raw pass-1 responses (gitignored)
  cache/api-pages/citation-XXXXX.json    raw pass-2 responses (gitignored)
  cache/citation-unavailable.txt         ids the citation block 500s on
  cache/descriptions.tsv                 full description text (gitignored)
  analysis/derived/public-metadata.tsv   everything else, snippets only

RUN IT ALONE
------------
  uv run python analysis/python/10_fetch_public_metadata.py
  uv run python analysis/python/10_fetch_public_metadata.py --refresh
  uv run python analysis/python/10_fetch_public_metadata.py --skip-citation
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import httpx
import pandas as pd
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from cafedash.config import config_dir, load_config
from cafedash.textprep import strip_markup

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

BASE_PAGE_SIZE = 1000

# Retried: the server is busy or the connection dropped.
RETRYABLE_STATUS = {429, 502, 503, 504}


class ServerRejected(Exception):
    """The API returned a hard error for this exact request.

    Raised instead of retrying, because the 500 pass 2 runs into is a
    deterministic per-record defect: the same request fails every time. The
    caller responds by splitting the request, not by asking again.
    """


# ---------------------------------------------------------------------------
# Sanitising
# ---------------------------------------------------------------------------
def strip_contact_fields(node: Any, drop_names: set[str], drop_types: set[str]) -> Any:
    """Recursively remove contact and email fields from a decoded API response.

    Dataverse nests compound metadata fields as
    `{"typeName": ..., "typeClass": "compound", "value": [{child: {...}}]}`,
    so removal has to walk the whole structure rather than pop known keys.
    """
    if isinstance(node, dict):
        if node.get("typeName") in drop_names:
            return None
        if str(node.get("fieldType", "")).upper() in drop_types:
            return None
        cleaned: dict[str, Any] = {}
        for key, value in node.items():
            if key in drop_names:
                continue
            scrubbed = strip_contact_fields(value, drop_names, drop_types)
            if scrubbed is not None:
                cleaned[key] = scrubbed
        return cleaned
    if isinstance(node, list):
        items = [strip_contact_fields(item, drop_names, drop_types) for item in node]
        return [item for item in items if item not in (None, {}, [])]
    if isinstance(node, str):
        return EMAIL_RE.sub("[email removed]", node)
    return node


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
def _params(api: dict[str, Any], start: int, per_page: int, with_citation: bool) -> dict[str, Any]:
    params: dict[str, Any] = {
        "q": "*",
        "subtree": api["subtree"],
        "type": "dataset",
        "per_page": per_page,
        "start": start,
        # A stable ordering is required for offset paging to be coherent.
        # `sort=name` 500s on this collection; `date` is the working choice.
        "sort": "date",
        "order": "asc",
    }
    if with_citation:
        params["metadata_fields"] = api["metadata_fields"]
    return params


def _unwrap(response: httpx.Response) -> dict[str, Any]:
    if response.status_code in RETRYABLE_STATUS:
        response.raise_for_status()
    if response.status_code >= 400:
        raise ServerRejected(f"HTTP {response.status_code} for {response.request.url}")
    payload = response.json()
    if payload.get("status") != "OK":
        raise ServerRejected(f"API status {payload.get('status')}")
    return payload["data"]


@retry(
    stop=stop_after_attempt(4),
    wait=wait_exponential(multiplier=2, min=2, max=30),
    retry=retry_if_exception_type((httpx.TransportError, httpx.HTTPStatusError)),
    reraise=True,
)
def _search(
    client: httpx.Client, api: dict[str, Any], start: int, per_page: int, with_citation: bool
) -> dict[str, Any]:
    return _unwrap(client.get(api["base_url"], params=_params(api, start, per_page, with_citation)))


@retry(
    stop=stop_after_attempt(4),
    wait=wait_exponential(multiplier=2, min=2, max=30),
    retry=retry_if_exception_type((httpx.TransportError, httpx.HTTPStatusError)),
    reraise=True,
)
async def _search_async(
    client: httpx.AsyncClient, api: dict[str, Any], start: int, per_page: int
) -> dict[str, Any]:
    return _unwrap(
        await client.get(api["base_url"], params=_params(api, start, per_page, with_citation=True))
    )


# ---------------------------------------------------------------------------
# Pass 1: the plain search result
# ---------------------------------------------------------------------------
def fetch_base(
    client: httpx.Client, config: dict[str, Any], pages_dir: Path, refresh: bool
) -> list[dict[str, Any]]:
    api = config["api"]
    drop_names = set(api["drop_field_names"])
    drop_types = {t.upper() for t in api["drop_field_types"]}

    cached = sorted(pages_dir.glob("base-*.json"))
    if cached and not refresh:
        items: list[dict[str, Any]] = []
        for page in cached:
            items.extend(json.loads(page.read_text(encoding="utf-8")))
        print(f"[base] reusing {len(items)} cached records from {len(cached)} pages")
        return items

    for stale in cached:
        stale.unlink()

    items = []
    start = 0
    total: int | None = None
    page_index = 0

    while total is None or start < total:
        data = _search(client, api, start, BASE_PAGE_SIZE, with_citation=False)
        if total is None:
            total = int(data["total_count"])
            print(f"[base] {total} datasets discoverable under subtree={api['subtree']}")
        page_items = strip_contact_fields(data.get("items", []), drop_names, drop_types)
        if not page_items:
            break
        (pages_dir / f"base-{page_index:03d}.json").write_text(
            json.dumps(page_items, ensure_ascii=False), encoding="utf-8"
        )
        items.extend(page_items)
        page_index += 1
        start += BASE_PAGE_SIZE
        print(f"[base] {len(items):5d}/{total}", flush=True)
        if start < (total or 0):
            time.sleep(api["delay_seconds"])

    return items


# ---------------------------------------------------------------------------
# Pass 2: the citation block, with adaptive splitting
# ---------------------------------------------------------------------------
async def _citation_span(
    client: httpx.AsyncClient,
    api: dict[str, Any],
    semaphore: asyncio.Semaphore,
    start: int,
    count: int,
    drop_names: set[str],
    drop_types: set[str],
    unavailable: list[int],
) -> list[dict[str, Any]]:
    """Fetch `count` records from `start`, splitting around ones the API rejects.

    Returns whatever could be served. Offsets that fail even as a single record
    are appended to `unavailable`.
    """
    async with semaphore:
        try:
            data = await _search_async(client, api, start, count)
            return strip_contact_fields(data.get("items", []), drop_names, drop_types)
        except ServerRejected:
            if count == 1:
                unavailable.append(start)
                return []
        except httpx.HTTPError as exc:
            if count == 1:
                print(f"[citation] giving up on offset {start}: {exc}")
                unavailable.append(start)
                return []

    half = count // 2
    left, right = await asyncio.gather(
        _citation_span(client, api, semaphore, start, half, drop_names, drop_types, unavailable),
        _citation_span(
            client, api, semaphore, start + half, count - half, drop_names, drop_types, unavailable
        ),
    )
    return left + right


async def _citation_worker(
    client: httpx.AsyncClient,
    api: dict[str, Any],
    semaphore: asyncio.Semaphore,
    pages_dir: Path,
    start: int,
    count: int,
    drop_names: set[str],
    drop_types: set[str],
    unavailable: list[int],
    progress: dict[str, int],
) -> list[dict[str, Any]]:
    items = await _citation_span(
        client, api, semaphore, start, count, drop_names, drop_types, unavailable
    )
    if items:
        (pages_dir / f"citation-{start:05d}.json").write_text(
            json.dumps(items, ensure_ascii=False), encoding="utf-8"
        )
    progress["done"] += count
    progress["got"] += len(items)
    print(
        f"[citation] {progress['done']:5d}/{progress['total']} "
        f"(enriched {progress['got']}, unavailable {len(unavailable)})",
        flush=True,
    )
    return items


async def fetch_citation_async(
    config: dict[str, Any], pages_dir: Path, total: int
) -> tuple[dict[str, dict[str, Any]], list[int]]:
    api = config["api"]
    drop_names = set(api["drop_field_names"])
    drop_types = {t.upper() for t in api["drop_field_types"]}
    chunk = int(api.get("citation_chunk", 25))

    semaphore = asyncio.Semaphore(int(api.get("concurrency", 4)))
    unavailable: list[int] = []
    progress = {"total": total, "done": 0, "got": 0}
    headers = {"User-Agent": api["user_agent"], "Accept": "application/json"}
    limits = httpx.Limits(max_connections=int(api.get("concurrency", 4)) + 2)

    blocks: dict[str, dict[str, Any]] = {}
    async with httpx.AsyncClient(
        timeout=api["timeout_seconds"], headers=headers, limits=limits
    ) as client:
        results = await asyncio.gather(
            *[
                _citation_worker(
                    client,
                    api,
                    semaphore,
                    pages_dir,
                    start,
                    min(chunk, total - start),
                    drop_names,
                    drop_types,
                    unavailable,
                    progress,
                )
                for start in range(0, total, chunk)
            ]
        )

    for items in results:
        for item in items:
            gid = str(item.get("global_id") or "")
            if gid:
                blocks[gid] = item
    return blocks, sorted(unavailable)


def fetch_citation(
    config: dict[str, Any], pages_dir: Path, total: int, refresh: bool
) -> tuple[dict[str, dict[str, Any]], list[int]]:
    cached = sorted(pages_dir.glob("citation-*.json"))
    if cached and not refresh:
        blocks: dict[str, dict[str, Any]] = {}
        for page in cached:
            for item in json.loads(page.read_text(encoding="utf-8")):
                gid = str(item.get("global_id") or "")
                if gid:
                    blocks[gid] = item
        print(f"[citation] reusing {len(blocks)} cached records from {len(cached)} chunks")
        return blocks, []

    for stale in cached:
        stale.unlink()
    return asyncio.run(fetch_citation_async(config, pages_dir, total))


# ---------------------------------------------------------------------------
# Flattening
# ---------------------------------------------------------------------------
def _field_map(item: dict[str, Any]) -> dict[str, Any]:
    """Index the citation block's fields by typeName."""
    blocks = item.get("metadataBlocks") or {}
    citation = blocks.get("citation") or {}
    return {
        f.get("typeName"): f.get("value") for f in citation.get("fields", []) if f.get("typeName")
    }


def _compound_values(value: Any, child: str) -> list[str]:
    """Pull one child field out of every repetition of a compound field."""
    if not isinstance(value, list):
        return []
    out = []
    for entry in value:
        if isinstance(entry, dict) and isinstance(entry.get(child), dict):
            text = str(entry[child].get("value", "")).strip()
            if text:
                out.append(text)
    return out


def _as_text(value: Any) -> str:
    if isinstance(value, list):
        return "; ".join(str(v).strip() for v in value if str(v).strip())
    return str(value or "").strip()


def flatten_item(
    item: dict[str, Any], citation: dict[str, Any] | None, snippet_chars: int
) -> dict[str, Any]:
    fields = _field_map(citation) if citation else {}

    # Authors. `authors` is already one entry per author, which is what
    # SETUP.md's author-parsing requirement needs; the citation block carries
    # the matching affiliations in the same order.
    authors = [str(a).strip() for a in (item.get("authors") or []) if str(a).strip()]
    if not authors and citation:
        authors = [str(a).strip() for a in (citation.get("authors") or []) if str(a).strip()]
    if not authors:
        authors = _compound_values(fields.get("author"), "authorName")
    affiliations = _compound_values(fields.get("author"), "authorAffiliation")

    # Description. `dsDescription` repeats; the flat `description` is the first
    # repetition only, so prefer the block where pass 2 supplied one.
    descriptions = _compound_values(fields.get("dsDescription"), "dsDescriptionValue")
    description = "\n\n".join(descriptions) if descriptions else str(item.get("description") or "")
    # Abstracts are stored as HTML, and several arrive double-escaped. Tags are
    # removed here, at the point the text lands on disk, so nothing downstream
    # has to remember to do it: the similarity analysis would strip them anyway,
    # but the snippet the site shows in a tooltip would otherwise start with a
    # literal <h3 class="post-title">.
    description = strip_markup(description)
    description = EMAIL_RE.sub("[email removed]", description)
    description = " ".join(description.split()).strip()

    keywords = _compound_values(fields.get("keyword"), "keywordValue")
    if not keywords:
        keywords = [str(k).strip() for k in (item.get("keywords") or []) if str(k).strip()]
    topics = _compound_values(fields.get("topicClassification"), "topicClassValue")

    subjects = fields.get("subject") or item.get("subjects") or []
    producers = _compound_values(fields.get("producer"), "producerName") or [
        str(p).strip() for p in (item.get("producers") or []) if str(p).strip()
    ]

    return {
        "global_id": str(item.get("global_id") or "").strip(),
        "api_title": str(item.get("name") or "").strip(),
        "api_url": str(item.get("url") or "").strip(),
        "collection_alias": str(item.get("identifier_of_dataverse") or "").strip(),
        "collection_name": str(item.get("name_of_dataverse") or "").strip(),
        "publication_statuses": "; ".join(item.get("publicationStatuses") or []),
        "version_state": str(item.get("versionState") or "").strip(),
        "major_version": str(item.get("majorVersion") or "").strip(),
        "minor_version": str(item.get("minorVersion") or "").strip(),
        "created_at": str(item.get("createdAt") or "").strip(),
        "updated_at": str(item.get("updatedAt") or "").strip(),
        "published_at": str(item.get("published_at") or "").strip(),
        "api_file_count": str(item.get("fileCount") or "").strip(),
        "publisher": str(item.get("publisher") or "").strip(),
        "authors": "; ".join(authors),
        "author_affiliations": "; ".join(affiliations),
        "producers": "; ".join(producers),
        "distributors": "; ".join(_compound_values(fields.get("distributor"), "distributorName")),
        "subjects": _as_text(subjects),
        "api_keywords": "; ".join(keywords),
        "topics": "; ".join(topics),
        "language": _as_text(fields.get("language")),
        "date_of_deposit": _as_text(fields.get("dateOfDeposit")),
        "production_date": _as_text(fields.get("productionDate")),
        "distribution_date": _as_text(fields.get("distributionDate")),
        "time_period_start": "; ".join(
            _compound_values(fields.get("timePeriodCovered"), "timePeriodCoveredStart")
        ),
        "time_period_end": "; ".join(
            _compound_values(fields.get("timePeriodCovered"), "timePeriodCoveredEnd")
        ),
        "collection_date_start": "; ".join(
            _compound_values(fields.get("dateOfCollection"), "dateOfCollectionStart")
        ),
        "collection_date_end": "; ".join(
            _compound_values(fields.get("dateOfCollection"), "dateOfCollectionEnd")
        ),
        "has_citation_block": "t" if citation else "f",
        "description_chars": str(len(description)),
        "description_snippet": " ".join(description[:snippet_chars].split()),
        "_description_full": description,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch public CAFE metadata from Harvard Dataverse"
    )
    parser.add_argument("--refresh", action="store_true", help="re-fetch instead of reusing cache")
    parser.add_argument(
        "--skip-citation",
        action="store_true",
        help="pass 1 only; skips author affiliations and time coverage",
    )
    args = parser.parse_args()

    config = load_config()
    api = config["api"]
    cache_dir = config_dir(config, "cache", create=True)
    derived_dir = config_dir(config, "derived", create=True)
    pages_dir = cache_dir / "api-pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    snippet_chars = int(config["similarity"]["description"]["snippet_chars"])

    headers = {"User-Agent": api["user_agent"], "Accept": "application/json"}
    with httpx.Client(timeout=api["timeout_seconds"], headers=headers) as client:
        items = fetch_base(client, config, pages_dir, refresh=args.refresh)
    if not items:
        raise SystemExit("FATAL: pass 1 returned no records")

    citation_blocks: dict[str, dict[str, Any]] = {}
    unavailable: list[int] = []
    if not args.skip_citation:
        citation_blocks, unavailable = fetch_citation(
            config, pages_dir, len(items), refresh=args.refresh
        )

    if unavailable:
        (cache_dir / "citation-unavailable.txt").write_text(
            "\n".join(str(offset) for offset in unavailable) + "\n", encoding="utf-8"
        )

    records = [
        flatten_item(item, citation_blocks.get(str(item.get("global_id") or "")), snippet_chars)
        for item in items
    ]
    frame = pd.DataFrame.from_records(records)

    missing_id = frame["global_id"].eq("")
    if missing_id.any():
        print(f"[flatten] dropping {int(missing_id.sum())} records with no global_id")
        frame = frame.loc[~missing_id].copy()

    before = len(frame)
    frame = frame.drop_duplicates(subset="global_id", keep="first")
    if len(frame) != before:
        print(f"[flatten] dropped {before - len(frame)} duplicate global_ids")

    # Full descriptions stay in the gitignored cache; only the snippet is
    # carried into analysis/derived/, which the site build reads.
    frame[["global_id", "_description_full"]].rename(
        columns={"_description_full": "description"}
    ).to_csv(cache_dir / "descriptions.tsv", sep="\t", index=False)

    public = frame.drop(columns=["_description_full"])
    public.to_csv(derived_dir / "public-metadata.tsv", sep="\t", index=False)

    leaked = sum(
        int(public[column].astype(str).str.contains(EMAIL_RE.pattern, regex=True).sum())
        for column in public.columns
    )
    if leaked:
        raise SystemExit(f"FATAL: {leaked} email addresses survived into public-metadata.tsv")

    described = int((frame["description_chars"].astype(int) > 0).sum())
    enriched = int(frame["has_citation_block"].eq("t").sum())
    print(
        f"\n[write] {len(public)} datasets -> {derived_dir / 'public-metadata.tsv'}\n"
        f"[write] {described} with a description ({described / len(public):.1%})"
        f" -> {cache_dir / 'descriptions.tsv'}\n"
        f"[write] {enriched} with the citation block ({enriched / len(public):.1%});"
        f" {len(public) - enriched} lack affiliation and time coverage\n"
        f"[check] no email addresses in public-metadata.tsv"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
