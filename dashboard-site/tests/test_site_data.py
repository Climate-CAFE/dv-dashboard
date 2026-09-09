"""Contract tests for the payload the published site loads.

These run against `public/data/`, which is committed, so they pass from a fresh
clone without the extract set or network access. They are the checks worth
having in CI: a broken pipeline usually produces plausible files rather than no
files, and the failure shows up as a wrong number on a chart.

    uv run pytest
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

SITE_DATA = Path(__file__).resolve().parents[1] / "public" / "data"

EXPECTED_FILES = [
    "scope.json",
    "datasets.json",
    "overview.json",
    "authors.json",
    "keywords.json",
    "collections.json",
    "temporal.json",
    "geography.json",
    "files-usage.json",
    "similarity-keyword.json",
    "similarity-description.json",
]


def load(name: str):
    return json.loads((SITE_DATA / name).read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def scope():
    return load("scope.json")


@pytest.fixture(scope="module")
def datasets():
    return load("datasets.json")


@pytest.fixture(scope="module")
def overview():
    return load("overview.json")


# ---------------------------------------------------------------------------
# Presence
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("name", EXPECTED_FILES)
def test_file_exists_and_parses(name):
    assert (SITE_DATA / name).exists(), f"{name} missing; run `just build`"
    load(name)


# ---------------------------------------------------------------------------
# Scope
# ---------------------------------------------------------------------------
def test_scope_arithmetic(scope):
    """Published plus harvested is the live count, and drafts are the remainder.

    This is the reconciliation the extract documentation reports against
    Harvard Dataverse's public search index. If it stops holding, either the
    extract has been refreshed or the scope rule has changed, and every figure
    on the site moves with it.
    """
    s = scope["scope"]
    assert s["published_locally"] + s["harvested"] == s["discoverable"]
    assert s["discoverable"] + s["drafts_excluded"] == s["in_scope_total"]


def test_drafts_are_excluded(scope, datasets):
    assert len(datasets) == scope["scope"]["discoverable"]
    assert scope["scope"]["drafts_excluded"] > 0, "expected some drafts in this collection"


def test_every_dataset_is_live(datasets):
    """No row may be both undated and unharvested: that is the draft signature."""
    orphans = [row for row in datasets if not row["harvested"] and not row["published"]]
    assert not orphans, (
        f"{len(orphans)} datasets have neither a publication date nor harvest status"
    )


# ---------------------------------------------------------------------------
# Explorer parity
#
# The Explorer re-aggregates datasets.json in the browser; the Overview prints
# figures computed in R. With no filter applied the two must agree exactly.
# This test reimplements the Explorer's aggregation in Python and compares.
# ---------------------------------------------------------------------------
def test_explorer_totals_match_overview(datasets, overview):
    headline = overview["headline"]
    assert len(datasets) == headline["datasets"]
    assert sum(row["files"] or 0 for row in datasets) == headline["files"]
    assert sum(row["bytes"] or 0 for row in datasets) == headline["bytes"]
    assert sum(row["views"] or 0 for row in datasets) == headline["views_total"]
    assert sum(row["downloads"] or 0 for row in datasets) == headline["downloads"]
    assert sum(row["cites"] or 0 for row in datasets) == headline["citations"]
    assert sum(1 for row in datasets if row["harvested"]) == headline["harvested"]
    assert sum(1 for row in datasets if row["linked"]) == headline["linked"]


def test_explorer_subcollection_counts_match_overview(datasets, overview):
    from collections import Counter

    counted = Counter(row["sub"] for row in datasets)
    expected = {row["subcollection"]: row["datasets"] for row in overview["by_subcollection"]}
    assert counted == Counter(expected)


def test_explorer_year_counts_match_overview(datasets, overview):
    from collections import Counter

    counted = Counter(row["year"] for row in datasets if row["year"])
    expected = {row["year"]: row["datasets"] for row in overview["by_year"]}
    assert dict(counted) == expected


def test_explorer_membership_counts_match_overview(datasets, overview):
    from collections import Counter

    counted = Counter(row["membership"] for row in datasets)
    expected = {row["membership"]: row["datasets"] for row in overview["by_membership"]}
    assert dict(counted) == expected


# ---------------------------------------------------------------------------
# Collection tree
# ---------------------------------------------------------------------------
def test_tree_rolls_up_to_the_dataset_count(datasets):
    collections = load("collections.json")
    assert collections["tree"]["cumulative"]["datasets"] == len(datasets)


def test_no_parent_smaller_than_its_subtree():
    collections = load("collections.json")

    def walk(node):
        total = node["direct"]["datasets"] + sum(walk(c) for c in node.get("children", []))
        assert node["cumulative"]["datasets"] == total, (
            f"{node['alias']}: cumulative {node['cumulative']['datasets']} != {total}"
        )
        return total

    walk(collections["tree"])


def test_every_subcollection_is_a_node(datasets):
    collections = load("collections.json")
    aliases = {row["alias"] for row in collections["flat"]}
    used = {row["sub"] for row in datasets}
    assert used <= aliases, f"datasets reference collections absent from the tree: {used - aliases}"


# ---------------------------------------------------------------------------
# Similarity bundles
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("name", ["similarity-keyword.json", "similarity-description.json"])
def test_similarity_bundle_is_internally_consistent(name, datasets):
    bundle = load(name)
    n = bundle["n"]
    assert len(bundle["ids"]) == n
    known = {row["id"] for row in datasets}
    assert set(bundle["ids"]) <= known, "similarity references datasets not in datasets.json"

    for key in bundle["methodOrder"]:
        method = bundle["methods"][key]
        assert method["justification"].strip(), f"{name}/{key} has no justification text"
        assert len(method["clusters"]) == n
        assert len(method["neighbours"]) == n
        for projection in ("tsne", "mds"):
            assert len(method["coords"][projection]) == n
            assert all(len(point) == 2 for point in method["coords"][projection])
        for row, neighbours in enumerate(method["neighbours"]):
            assert neighbours, f"{name}/{key} row {row} has no neighbours"
            assert all(0 <= item["i"] < n for item in neighbours)
            assert all(item["i"] != row for item in neighbours), "a dataset is its own neighbour"
            scores = [item["s"] for item in neighbours]
            assert scores == sorted(scores, reverse=True), "neighbours are not sorted by score"
            assert all(0.0 <= s <= 1.0 for s in scores)


def test_similarity_methods_are_documented():
    """Each method must say what it does AND what it gets wrong.

    A justification that only advertises is worse than none: the point of
    printing it beside the plot is that a reader can tell when not to trust it.
    """
    for name in ("similarity-keyword.json", "similarity-description.json"):
        bundle = load(name)
        for key in bundle["methodOrder"]:
            text = bundle["methods"][key]["justification"].lower()
            assert "what this measures" in text, f"{name}/{key} does not say what it measures"
            assert any(
                phrase in text for phrase in ("gets wrong", "watch for", "still gets wrong")
            ), f"{name}/{key} does not state its limitations"


# ---------------------------------------------------------------------------
# Privacy
# ---------------------------------------------------------------------------
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


@pytest.mark.parametrize("name", EXPECTED_FILES)
def test_no_email_addresses_in_published_data(name):
    """The repository is public. Nothing it publishes may carry an address."""
    text = (SITE_DATA / name).read_text(encoding="utf-8")
    found = EMAIL_RE.findall(text)
    assert not found, f"{name} contains {len(found)} email-shaped strings: {found[:3]}"


def test_no_depositor_usernames_in_published_data(datasets):
    """Contributor counts are published; contributor identities are not."""
    for row in datasets:
        assert "editors" in row, "expected a contributor count"
        assert "editor_identifiers" not in row
        assert "editorIdentifiers" not in row


def test_small_country_cells_are_suppressed():
    geography = load("geography.json")
    minimum = geography["viewers"]["min_cell"]
    for row in geography["viewers"]["by_subcollection"]:
        assert row["datasets"] >= minimum, (
            f"{row['subcollection']}/{row['country_code']} has {row['datasets']} datasets, "
            f"below the {minimum} suppression threshold"
        )


# ---------------------------------------------------------------------------
# Size guard
# ---------------------------------------------------------------------------
def test_payload_stays_small():
    """A dashboard nobody can load is not a dashboard.

    The whole payload is served on a static host with no compression control of
    our own, so this is a real budget rather than a style preference.
    """
    total = sum((SITE_DATA / name).stat().st_size for name in EXPECTED_FILES)
    assert total < 12 * 1024 * 1024, f"site data is {total / 1e6:.1f} MB; consider splitting it"
