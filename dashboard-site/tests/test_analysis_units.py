"""Unit tests for the analysis helpers.

These need neither the extract set nor the network: they exercise the pure
functions that decide what the numbers mean. The cases below are the ones that
were actually wrong at some point, or that would be easy to get wrong.
"""

from __future__ import annotations

import numpy as np
import pytest
import scipy.sparse as sp

from cafedash.similarity import (
    classical_mds,
    cluster,
    keyword_jaccard,
    keyword_ppmi_svd,
    keyword_tfidf_cosine,
    nearest_neighbours,
)
from cafedash.textprep import build_document, clean_description, strip_markup


# ---------------------------------------------------------------------------
# Text preparation
# ---------------------------------------------------------------------------
def test_strip_markup_removes_tags():
    assert "post-title" not in strip_markup('<h3 class="post-title">Hello</h3>')
    assert "Hello" in strip_markup('<h3 class="post-title">Hello</h3>')


def test_strip_markup_handles_double_escaping():
    """Some records arrive escaped twice, having passed through two layers."""
    assert "<" not in strip_markup("&amp;lt;p&amp;gt;Text&amp;lt;/p&amp;gt;")
    assert "Text" in strip_markup("&amp;lt;p&amp;gt;Text&amp;lt;/p&amp;gt;")


def test_clean_description_drops_urls_dois_and_numbers():
    cleaned = clean_description(
        "Grid at 0.01 degrees. See https://example.org/x and doi:10.7910/DVN/AB12 for 2015."
    )
    assert "https" not in cleaned
    assert "10.7910" not in cleaned
    assert "0.01" not in cleaned
    assert "Grid" in cleaned and "degrees" in cleaned


def test_clean_description_removes_the_redaction_marker():
    """The marker this pipeline inserts must not become a token in the model."""
    assert "email" not in clean_description("Contact [email removed] for access.").lower()


def test_build_document_includes_the_title():
    document = build_document("Heat and Mortality", "<p>A study of exposure.</p>")
    assert "Heat" in document and "exposure" in document


def test_build_document_omits_keywords_unless_asked():
    assert "sunburn" not in build_document("T", "A description.")
    assert "sunburn" in build_document("T", "A description.", ["sunburn"])


def test_description_pipeline_does_not_feed_keywords_into_the_text():
    """Keyword structure is the other similarity dimension on the site. Folding
    it into the description text would make the two dimensions agree by
    construction rather than on the evidence, so the description script must
    call build_document with two arguments, not three.

    Asserted against the source because it is a property of the call site, not
    of the function.
    """
    from pathlib import Path

    source = (
        Path(__file__).resolve().parents[1] / "analysis" / "python" / "12_description_similarity.py"
    ).read_text(encoding="utf-8")
    calls = [
        line for line in source.splitlines() if "build_document(" in line and "import" not in line
    ]
    assert calls, "expected 12_description_similarity.py to call build_document"
    for call in calls:
        assert "keyword" not in call.lower(), f"keywords passed into the description text: {call}"


# ---------------------------------------------------------------------------
# Keyword similarity
# ---------------------------------------------------------------------------
@pytest.fixture
def toy():
    """Four datasets over five keywords.

    d0: a b c      d1: a b        d2: c d      d3: e
    `a` and `b` always travel together; `e` is unique to d3.
    """
    rows = [0, 0, 0, 1, 1, 2, 2, 3]
    cols = [0, 1, 2, 0, 1, 2, 3, 4]
    incidence = sp.csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(4, 5))
    return incidence, ["a", "b", "c", "d", "e"]


def test_jaccard_matches_the_hand_computation(toy):
    incidence, keywords = toy
    result = keyword_jaccard(incidence, keywords)
    # d0 = {a,b,c}, d1 = {a,b}: intersection 2, union 3.
    assert result.similarity[0, 1] == pytest.approx(2 / 3)
    # d1 = {a,b}, d3 = {e}: nothing shared.
    assert result.similarity[1, 3] == pytest.approx(0.0)
    assert result.similarity[0, 0] == pytest.approx(1.0)


def test_similarity_is_symmetric_and_bounded(toy):
    incidence, keywords = toy
    for result in (
        keyword_jaccard(incidence, keywords),
        keyword_tfidf_cosine(incidence, keywords),
    ):
        assert np.allclose(result.similarity, result.similarity.T)
        assert result.similarity.min() >= 0.0
        assert result.similarity.max() <= 1.0
        assert np.allclose(np.diag(result.similarity), 1.0)
        assert np.allclose(np.diag(result.distance), 0.0)


def test_tfidf_downweights_a_ubiquitous_keyword():
    """Two datasets sharing only a keyword everyone has should score below two
    sharing only a rare one. This is the whole point of the weighting."""
    # k0 is on every dataset; k1 and k2 are on two each.
    rows = [0, 1, 2, 3, 0, 1, 2, 3]
    cols = [0, 0, 0, 0, 1, 1, 2, 2]
    incidence = sp.csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(4, 3))
    result = keyword_tfidf_cosine(incidence, ["common", "rare1", "rare2"])
    shared_common_only = result.similarity[0, 2]  # share k0 only
    shared_rare = result.similarity[0, 1]  # share k0 and k1
    assert shared_rare > shared_common_only


def test_ppmi_embedding_relates_keywords_that_travel_together(toy):
    """Datasets sharing no keyword can still be similar if their keywords
    co-occur elsewhere. That is what makes this the semantic method."""
    incidence, keywords = toy
    result = keyword_ppmi_svd(incidence, keywords, dims=3, seed=0)
    assert result.similarity.shape == (4, 4)
    assert np.allclose(result.similarity, result.similarity.T)
    # d3 carries only `e`, which co-occurs with nothing, so it should not be
    # the closest thing to d0.
    assert result.similarity[0, 1] > result.similarity[0, 3]


# ---------------------------------------------------------------------------
# Post-processing
# ---------------------------------------------------------------------------
def test_nearest_neighbours_excludes_self_and_sorts_descending():
    similarity = np.array(
        [
            [1.0, 0.9, 0.2, 0.5],
            [0.9, 1.0, 0.1, 0.3],
            [0.2, 0.1, 1.0, 0.7],
            [0.5, 0.3, 0.7, 1.0],
        ]
    )
    neighbours = nearest_neighbours(similarity, k=2)
    assert [n["i"] for n in neighbours[0]] == [1, 3]
    for row, items in enumerate(neighbours):
        assert all(item["i"] != row for item in items)
        scores = [item["s"] for item in items]
        assert scores == sorted(scores, reverse=True)


def test_classical_mds_recovers_a_known_geometry():
    """Four points on a square: MDS should return something congruent to it."""
    square = np.array([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]])
    distance = np.linalg.norm(square[:, None, :] - square[None, :, :], axis=-1)
    coords = classical_mds(distance)
    recovered = np.linalg.norm(coords[:, None, :] - coords[None, :, :], axis=-1)
    assert np.allclose(recovered, distance, atol=1e-8)


def test_cluster_is_deterministic_and_returns_the_requested_k():
    rng = np.random.default_rng(0)
    points = np.vstack([rng.normal(0, 0.1, (20, 2)), rng.normal(5, 0.1, (20, 2))])
    distance = np.linalg.norm(points[:, None, :] - points[None, :, :], axis=-1)
    first = cluster(distance, 2)
    second = cluster(distance, 2)
    assert np.array_equal(first, second)
    assert len(set(first.tolist())) == 2
    # The two well-separated blobs must not be split across the same label.
    assert len(set(first[:20].tolist())) == 1
    assert len(set(first[20:].tolist())) == 1


def test_cluster_complete_linkage_resists_chaining():
    """Why complete linkage: single and average linkage absorb a chain of
    points into one cluster, which is what put 87% of this collection into a
    single group when average linkage was used."""
    chain = np.arange(30, dtype=float).reshape(-1, 1)
    distance = np.abs(chain - chain.T)
    complete = cluster(distance, 3, linkage="complete")
    average = cluster(distance, 3, linkage="single")
    largest = lambda labels: max(np.bincount(labels))  # noqa: E731
    assert largest(complete) < largest(average)
