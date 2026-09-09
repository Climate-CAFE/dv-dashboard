"""Similarity methods, each with the justification the site prints beside it.

`SETUP.md` asks that the method be selectable from a dropdown and that the
reasoning appear below the plot. The reasoning is written here, next to the
implementation it describes, so the two cannot drift: if someone changes how a
metric is computed and not its `justification`, the change is in the same
function and the diff shows it.

Every method is deterministic and needs no model download and no network call.
An auditor can rerun any of them from a plain Python session:

    >>> import sys; sys.path.insert(0, "analysis/python")
    >>> from cafedash.similarity import keyword_tfidf_cosine
    >>> result = keyword_tfidf_cosine(incidence, keywords)
    >>> result.similarity.shape
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import scipy.sparse as sp
from sklearn.decomposition import NMF, TruncatedSVD
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import pairwise_distances
from sklearn.preprocessing import normalize


@dataclass
class SimilarityResult:
    """One similarity metric applied to one set of datasets.

    `similarity` is the full n x n matrix, symmetric, with 1.0 on the diagonal
    and values in [0, 1]. n is at most a few thousand here, so materialising it
    costs a few megabytes and buys exact nearest neighbours and an exact
    distance matrix for the projection.
    """

    key: str
    label: str
    justification: str
    similarity: np.ndarray
    params: dict[str, Any] = field(default_factory=dict)
    diagnostics: dict[str, Any] = field(default_factory=dict)
    terms: list[dict[str, Any]] = field(default_factory=list)
    per_dataset_terms: list[list[str]] = field(default_factory=list)

    def __post_init__(self) -> None:
        n = self.similarity.shape[0]
        if self.similarity.shape != (n, n):
            raise ValueError(f"{self.key}: similarity must be square, got {self.similarity.shape}")
        # Numerical noise can put a cosine a hair outside [0, 1] or make the
        # matrix very slightly asymmetric. Both would surface later as a
        # negative distance or a t-SNE failure, so they are fixed here rather
        # than debugged there.
        self.similarity = np.clip(self.similarity, 0.0, 1.0)
        self.similarity = (self.similarity + self.similarity.T) / 2.0
        np.fill_diagonal(self.similarity, 1.0)

    @property
    def distance(self) -> np.ndarray:
        """1 - similarity, with an exact zero diagonal."""
        d = 1.0 - self.similarity
        np.fill_diagonal(d, 0.0)
        return np.clip(d, 0.0, None)


def _cosine_from_rows(matrix: sp.spmatrix | np.ndarray) -> np.ndarray:
    """Cosine similarity between L2-normalised rows, as a dense array."""
    normalised = normalize(matrix, norm="l2", axis=1)
    product = normalised @ normalised.T
    return np.asarray(product.todense() if sp.issparse(product) else product, dtype=np.float64)


# ===========================================================================
# Keyword similarity
#
# Input is a datasets x keywords binary incidence matrix, built from extract
# 2.14a after the normalisation in 01-datasets.R (whitespace collapsed,
# case-folded, placeholders dropped).
# ===========================================================================

KEYWORD_PREAMBLE = (
    "Keywords on Harvard Dataverse are free text. Depositors choose their own, "
    "so the vocabulary is uneven: 2,823 distinct keywords across 1,177 "
    "datasets, and most are used exactly once. Any measure of keyword "
    "similarity has to decide what to do about that long tail, and the three "
    "methods here decide differently."
)


def keyword_jaccard(incidence: sp.csr_matrix, keywords: list[str]) -> SimilarityResult:
    """Overlap of keyword sets, ignoring how common each keyword is."""
    binary = (incidence > 0).astype(np.float64)
    intersection = np.asarray((binary @ binary.T).todense())
    sizes = np.asarray(binary.sum(axis=1)).ravel()
    union = sizes[:, None] + sizes[None, :] - intersection
    with np.errstate(divide="ignore", invalid="ignore"):
        similarity = np.where(union > 0, intersection / union, 0.0)

    return SimilarityResult(
        key="jaccard",
        label="Keyword overlap (Jaccard)",
        justification=(
            f"{KEYWORD_PREAMBLE}\n\n"
            "**What this measures.** The Jaccard index: the number of keywords "
            "two datasets share, divided by the number of distinct keywords "
            "across both. Two datasets tagged exactly alike score 1; two "
            "sharing nothing score 0.\n\n"
            "**Why start here.** It is the measure a reader would compute by "
            "hand, so it is the honest baseline. Nothing is weighted, nothing "
            "is learned, and a score can be checked against the two datasets' "
            "keyword lists directly.\n\n"
            "**What it gets wrong.** Every keyword counts the same. Two "
            "datasets sharing only *earth science*, which 267 datasets carry, "
            "score the same as two sharing only *pneumoconiosis*, which one "
            "pair carries. The first tells you almost nothing; the second is "
            "close to a fingerprint. It also scores 0 for any pair with no "
            "shared keyword, which is most pairs, so the structure it can show "
            "is limited to datasets that were tagged by the same hand."
        ),
        similarity=similarity,
        params={"keywords": len(keywords)},
        diagnostics={
            "mean_keywords_per_dataset": float(sizes.mean()),
            "pairs_with_any_overlap": int((intersection > 0).sum() - len(sizes)),
        },
    )


def keyword_tfidf_cosine(
    incidence: sp.csr_matrix, keywords: list[str], min_df: int = 2
) -> SimilarityResult:
    """Cosine similarity over inverse-document-frequency-weighted keywords."""
    n_datasets = incidence.shape[0]
    document_frequency = np.asarray((incidence > 0).sum(axis=0)).ravel()
    # Smoothed IDF, the same form scikit-learn uses, so a keyword on every
    # dataset gets weight near zero rather than exactly zero.
    idf = np.log((1.0 + n_datasets) / (1.0 + document_frequency)) + 1.0
    weighted = incidence.multiply(idf[None, :]).tocsr()
    similarity = _cosine_from_rows(weighted)

    rarest = np.argsort(-idf)[:15]
    commonest = np.argsort(idf)[:15]

    return SimilarityResult(
        key="tfidf_cosine",
        label="Weighted keyword similarity (TF-IDF cosine)",
        justification=(
            f"{KEYWORD_PREAMBLE}\n\n"
            "**What this measures.** The same shared-keyword idea as Jaccard, "
            "but each keyword is weighted by how rare it is across the "
            "collection, using inverse document frequency: "
            "`idf = log((1 + N) / (1 + datasets carrying the keyword)) + 1`. "
            "Datasets become vectors over the keyword vocabulary and the score "
            "is the cosine of the angle between them.\n\n"
            "**Why it is better than plain overlap.** Sharing a rare keyword "
            "is strong evidence of relatedness; sharing a ubiquitous one is "
            "almost none. IDF encodes exactly that. In this collection "
            f"*{keywords[commonest[0]]}* is among the least informative "
            f"keywords and *{keywords[rarest[0]]}* among the most, and the two "
            "should not contribute equally to a similarity score.\n\n"
            "**What it still gets wrong.** It matches on keyword *identity*. "
            "Two datasets tagged *heat wave* and *extreme heat* respectively, "
            "with nothing else in common, score 0, even though a reader would "
            "call them near-identical. The third method exists to fix that."
        ),
        similarity=similarity,
        params={"keywords": len(keywords), "min_df": min_df, "weighting": "smoothed idf"},
        diagnostics={
            "least_informative": [keywords[i] for i in commonest[:8]],
            "most_informative": [keywords[i] for i in rarest[:8]],
        },
    )


def keyword_ppmi_svd(
    incidence: sp.csr_matrix,
    keywords: list[str],
    dims: int = 96,
    shift: float = 1.0,
    seed: int = 0,
) -> SimilarityResult:
    """Similarity in a learned keyword space, so related keywords can match."""
    binary = (incidence > 0).astype(np.float64)

    # Keyword-by-keyword co-occurrence: how often two keywords appear on the
    # same dataset.
    cooccurrence = np.asarray((binary.T @ binary).todense())
    np.fill_diagonal(cooccurrence, 0.0)

    total = cooccurrence.sum()
    if total == 0:
        raise ValueError("no keyword co-occurrences; cannot build an embedding")

    # Positive pointwise mutual information. PMI asks whether two keywords
    # co-occur more than chance would predict; the positive part discards the
    # "these two avoid each other" half, which is dominated by sampling noise
    # at this vocabulary size.
    joint = cooccurrence / total
    marginal = joint.sum(axis=1)
    expected = np.outer(marginal, marginal)
    with np.errstate(divide="ignore", invalid="ignore"):
        pmi = np.log(
            np.divide(joint, expected, out=np.zeros_like(joint), where=expected > 0),
            out=np.zeros_like(joint),
            where=joint > 0,
        )
    ppmi = np.maximum(pmi - np.log(shift), 0.0)

    dims = int(min(dims, max(2, min(ppmi.shape) - 1)))
    svd = TruncatedSVD(n_components=dims, random_state=seed)
    keyword_vectors = svd.fit_transform(ppmi)
    keyword_vectors = normalize(keyword_vectors, norm="l2", axis=1)

    # A dataset is the IDF-weighted mean of its keywords' vectors, so a dataset
    # with one very specific keyword is not swamped by one with twenty generic
    # ones.
    n_datasets = incidence.shape[0]
    document_frequency = np.asarray(binary.sum(axis=0)).ravel()
    idf = np.log((1.0 + n_datasets) / (1.0 + document_frequency)) + 1.0
    weights = binary.multiply(idf[None, :]).tocsr()
    dataset_vectors = weights @ keyword_vectors

    similarity = _cosine_from_rows(dataset_vectors)

    return SimilarityResult(
        key="ppmi_svd",
        label="Related-keyword similarity (PPMI + SVD embedding)",
        justification=(
            f"{KEYWORD_PREAMBLE}\n\n"
            "**What this measures.** Similarity in a learned keyword space, so "
            "two datasets can be close without sharing a single keyword.\n\n"
            "**How it is built.** Three steps, all from the collection itself "
            "and nothing external:\n\n"
            "1. Count how often each pair of keywords appears on the same "
            "dataset.\n"
            "2. Reweight those counts as positive pointwise mutual "
            "information, which asks whether a pair co-occurs more than chance "
            "would predict and keeps only the pairs that do. Raw counts would "
            "just re-rank the common keywords.\n"
            f"3. Factor the PPMI matrix with a truncated SVD to {dims} "
            "dimensions. Keywords that keep the same company end up with "
            "similar vectors. A dataset is the IDF-weighted mean of its "
            "keywords' vectors, and the score is the cosine between datasets.\n\n"
            "**Why this is the semantic one.** *heat wave* and *extreme heat* "
            "are different strings, so the first two methods treat them as "
            "unrelated. Here they are pulled together because they co-occur "
            "with the same other keywords across the collection. The meaning "
            "is inferred from usage within CAFE, which is why it reflects how "
            "this community tags rather than general English.\n\n"
            "**What to watch for.** The embedding is learned from roughly "
            f"{int((cooccurrence > 0).sum() / 2):,} co-occurring keyword pairs. "
            "Keywords used once co-occur with little, so their vectors are "
            "poorly determined and the datasets carrying only such keywords "
            "sit in a diffuse cloud rather than a meaningful position. The "
            "cluster structure is trustworthy; the exact placement of an "
            "isolated point is not."
        ),
        similarity=similarity,
        params={"dims": dims, "shift": shift, "weighting": "ppmi", "seed": seed},
        diagnostics={
            "keyword_pairs_cooccurring": int((cooccurrence > 0).sum() / 2),
            "explained_variance": float(svd.explained_variance_ratio_.sum()),
        },
    )


# ===========================================================================
# Description similarity
# ===========================================================================

DESCRIPTION_PREAMBLE = (
    "Every dataset in this collection has a description, ranging from one "
    "sentence to several thousand words. They are written by many different "
    "depositors and arrive as HTML, so before any of these methods sees them "
    "the text is stripped of markup, URLs, DOIs and bare numbers, and the "
    "title is prepended. Keywords are deliberately left out: keyword structure "
    "is the other dimension on this page, and folding it in would make the two "
    "agree by construction rather than on the evidence."
)


def _vectorise(documents: list[str], config: dict[str, Any]) -> tuple[Any, Any, list[str]]:
    from cafedash.textprep import english_stopwords

    vectorizer = TfidfVectorizer(
        stop_words=english_stopwords(),
        max_features=int(config["max_features"]),
        min_df=int(config["min_df"]),
        max_df=float(config["max_df"]),
        ngram_range=(1, int(config["ngram_max"])),
        sublinear_tf=True,
        strip_accents="unicode",
        lowercase=True,
    )
    matrix = vectorizer.fit_transform(documents)
    return vectorizer, matrix, list(vectorizer.get_feature_names_out())


def description_tfidf_cosine(
    documents: list[str], config: dict[str, Any]
) -> tuple[SimilarityResult, Any, list[str]]:
    """Cosine similarity over TF-IDF term vectors."""
    _, matrix, vocabulary = _vectorise(documents, config)
    similarity = _cosine_from_rows(matrix)

    # The terms each document leans on hardest, for the site's tooltips.
    top_terms = []
    dense_order = matrix.tocsr()
    for row in range(dense_order.shape[0]):
        start, end = dense_order.indptr[row], dense_order.indptr[row + 1]
        indices = dense_order.indices[start:end]
        values = dense_order.data[start:end]
        best = indices[np.argsort(-values)[:6]] if len(indices) else []
        top_terms.append([vocabulary[i] for i in best])

    result = SimilarityResult(
        key="tfidf_cosine",
        label="Shared wording (TF-IDF cosine)",
        justification=(
            f"{DESCRIPTION_PREAMBLE}\n\n"
            "**What this measures.** Overlap in the words and two-word phrases "
            "two descriptions use, weighted so that a term common to the whole "
            "collection counts for little and a term specific to a few "
            "datasets counts for a lot. Term counts are damped "
            "logarithmically, so a word repeated forty times in a long "
            "abstract does not dominate.\n\n"
            f"**Vocabulary.** {len(vocabulary):,} terms survive the filters: "
            f"a term must appear in at least {config['min_df']} descriptions "
            f"and no more than {float(config['max_df']):.0%} of them, and "
            "English stop words plus a short list of Dataverse boilerplate "
            "(*dataset*, *download*, *readme*, *license* and similar) are "
            "removed. Domain vocabulary is never removed, even when common: "
            "how *climate* and *exposure* distribute across datasets is the "
            "signal, not noise.\n\n"
            "**Why start here.** It is transparent. Two datasets score highly "
            "because they literally share distinctive wording, and the terms "
            "responsible can be listed. Nothing is latent.\n\n"
            "**What it gets wrong.** It cannot see synonymy. A description "
            "about *mortality* and one about *deaths* share nothing here. It "
            "also rewards shared writing style, so several datasets deposited "
            "by one group with a common boilerplate paragraph will look "
            "similar for a reason that has nothing to do with their content."
        ),
        similarity=similarity,
        params={
            "terms": len(vocabulary),
            "min_df": config["min_df"],
            "max_df": config["max_df"],
            "ngram_range": [1, config["ngram_max"]],
            "sublinear_tf": True,
        },
        diagnostics={"vocabulary_size": len(vocabulary)},
        per_dataset_terms=top_terms,
    )
    return result, matrix, vocabulary


def description_lsa_cosine(
    matrix: Any, vocabulary: list[str], config: dict[str, Any], seed: int = 0
) -> SimilarityResult:
    """Cosine similarity in a reduced latent-semantic space."""
    dims = int(min(config["lsa_dims"], min(matrix.shape) - 1))
    svd = TruncatedSVD(n_components=dims, random_state=seed)
    reduced = svd.fit_transform(matrix)
    similarity = _cosine_from_rows(reduced)

    # Name the strongest components by their heaviest terms, so the axes are
    # not anonymous on the page.
    components = []
    for index in range(min(8, dims)):
        loadings = svd.components_[index]
        top = np.argsort(-np.abs(loadings))[:8]
        components.append(
            {
                "component": index + 1,
                "explained_variance": float(svd.explained_variance_ratio_[index]),
                "terms": [vocabulary[i] for i in top],
            }
        )

    return SimilarityResult(
        key="lsa_cosine",
        label="Latent topic similarity (LSA)",
        justification=(
            f"{DESCRIPTION_PREAMBLE}\n\n"
            "**What this measures.** The same TF-IDF vectors, projected onto "
            f"their {dims} strongest directions with a truncated SVD, then "
            "compared by cosine. This is latent semantic analysis.\n\n"
            "**Why the projection helps.** The term matrix has "
            f"{len(vocabulary):,} dimensions and most are near-empty. Terms "
            "that consistently appear together collapse onto a shared "
            "direction, so a description about *mortality* and one about "
            "*deaths* can land close even with no term in common, provided "
            "those two words keep similar company elsewhere in the collection. "
            "Discarding the weak directions also removes a great deal of "
            "one-off vocabulary that TF-IDF would otherwise treat as "
            f"distinctive. These {dims} components retain "
            f"{svd.explained_variance_ratio_.sum():.1%} of the variance.\n\n"
            "**What to watch for.** The components are not topics in any "
            "curated sense, and they can mix themes. They are also signed, so "
            "a component's negative end is as meaningful as its positive one, "
            "which makes an individual axis hard to read. The listed component "
            "terms below are for orientation, not interpretation. Use the "
            "topic model if you want components you can name."
        ),
        similarity=similarity,
        params={"dims": dims, "seed": seed},
        diagnostics={
            "explained_variance": float(svd.explained_variance_ratio_.sum()),
            "components": components,
        },
        terms=components,
    )


def description_nmf_topics(
    matrix: Any, vocabulary: list[str], config: dict[str, Any], seed: int = 0
) -> SimilarityResult:
    """Cosine similarity over a non-negative topic mixture."""
    n_topics = int(min(config["nmf_topics"], min(matrix.shape) - 1))
    model = NMF(
        n_components=n_topics,
        random_state=seed,
        init="nndsvda",
        max_iter=600,
        tol=1e-4,
    )
    weights = model.fit_transform(matrix)
    similarity = _cosine_from_rows(weights)

    topics = []
    for index in range(n_topics):
        loadings = model.components_[index]
        top = np.argsort(-loadings)[:10]
        share = float(weights[:, index].sum() / max(weights.sum(), 1e-12))
        topics.append(
            {
                "topic": index + 1,
                "terms": [vocabulary[i] for i in top],
                "share": share,
                "datasets": int((weights.argmax(axis=1) == index).sum()),
            }
        )

    dominant = weights.argmax(axis=1)
    per_dataset = [topics[t]["terms"][:4] for t in dominant]

    return SimilarityResult(
        key="nmf_topics",
        label="Topic-mixture similarity (NMF)",
        justification=(
            f"{DESCRIPTION_PREAMBLE}\n\n"
            f"**What this measures.** Each description is expressed as a "
            f"mixture of {n_topics} topics learned from the collection, and "
            "two datasets are similar when their mixtures point the same way.\n\n"
            "**How the topics are found.** Non-negative matrix factorisation "
            "decomposes the TF-IDF matrix into topics-by-terms and "
            "datasets-by-topics, with everything constrained to be "
            "non-negative. That constraint is what makes the result readable: "
            "a topic is a list of terms that are *present*, never a mix of "
            "present and absent, so each one can be read off and named. The "
            "topics found here are listed below the plot with their heaviest "
            "terms.\n\n"
            "**Why include it alongside LSA.** LSA gives a better-fitting "
            "space but signed, mixed components that resist interpretation. "
            "NMF gives a slightly coarser space whose dimensions are "
            "nameable, so when two datasets are near each other you can say "
            "which topic put them there. The two agreeing is real evidence; "
            "the two disagreeing tells you the pairing depends on the "
            "representation and should not be leaned on.\n\n"
            "**What to watch for.** The topic count is a choice, set to "
            f"{n_topics} in `config/dashboard-config.yml`, not something the "
            "data determined. Too few merges distinct themes; too many splits "
            "one theme across several topics. Short descriptions get unstable "
            "mixtures because there is little to fit."
        ),
        similarity=similarity,
        params={"topics": n_topics, "seed": seed, "init": "nndsvda"},
        diagnostics={
            "reconstruction_error": float(model.reconstruction_err_),
            "iterations": int(model.n_iter_),
        },
        terms=topics,
        per_dataset_terms=per_dataset,
    )


# ===========================================================================
# Shared post-processing
# ===========================================================================


def nearest_neighbours(similarity: np.ndarray, k: int) -> list[list[dict[str, Any]]]:
    """The k most similar datasets to each dataset, excluding itself."""
    n = similarity.shape[0]
    k = min(k, n - 1)
    masked = similarity.copy()
    np.fill_diagonal(masked, -np.inf)
    # argpartition finds the top k without sorting the whole row; the small
    # slice is then sorted properly.
    candidates = np.argpartition(-masked, kth=k - 1, axis=1)[:, :k]
    out = []
    for row in range(n):
        order = candidates[row][np.argsort(-masked[row, candidates[row]])]
        out.append([{"i": int(j), "s": round(float(similarity[row, j]), 4)} for j in order])
    return out


def classical_mds(distance: np.ndarray) -> np.ndarray:
    """Two-dimensional classical multidimensional scaling (Torgerson).

    A deterministic companion to t-SNE. t-SNE preserves neighbourhoods and
    distorts everything else, which is what you want for spotting clusters and
    exactly what you must not read distances off. Classical MDS preserves
    large distances instead, so a point far from the mass really is dissimilar
    to it. Offering both, from the same distance matrix, keeps a reader from
    over-reading either.
    """
    n = distance.shape[0]
    squared = distance**2
    centering = np.eye(n) - np.ones((n, n)) / n
    gram = -0.5 * centering @ squared @ centering
    gram = (gram + gram.T) / 2.0
    values, vectors = np.linalg.eigh(gram)
    order = np.argsort(-values)[:2]
    scale = np.sqrt(np.maximum(values[order], 0.0))
    return vectors[:, order] * scale


def project_tsne(distance: np.ndarray, seed: int, perplexity: float, iterations: int) -> np.ndarray:
    """t-SNE from a precomputed distance matrix."""
    from sklearn.manifold import TSNE

    n = distance.shape[0]
    # Perplexity has to stay below n/3 or the neighbourhood it implies is
    # larger than the data.
    effective = float(max(5.0, min(perplexity, (n - 1) / 3.0)))
    model = TSNE(
        n_components=2,
        metric="precomputed",
        init="random",
        random_state=seed,
        perplexity=effective,
        max_iter=int(iterations),
    )
    return model.fit_transform(distance)


def cluster(distance: np.ndarray, k: int, linkage: str = "complete") -> np.ndarray:
    """Complete-linkage agglomerative clustering on the distance matrix.

    Used only to colour the scatter. Agglomerative clustering is chosen over
    k-means because it consumes the distance matrix directly, so every metric
    on this page is clustered by the metric the reader selected rather than by
    a Euclidean stand-in for it. It is also deterministic: no seed, no restart
    variation, the same colours on every rebuild.

    **Complete linkage, not average.** Measured on the NMF description
    distances, 1,307 datasets into 10 clusters:

        average    silhouette +0.179   largest cluster 1,143 (87%)
        complete   silhouette +0.389   largest cluster   326 (25%)
        single     silhouette -0.026   largest cluster 1,192 (91%)

    Average and single linkage both chain: they absorb almost everything into
    one cluster and leave a handful of outlier specks, which colours the plot
    one colour and tells a reader nothing. Complete linkage merges on the
    worst-case pair within a candidate cluster, which resists chaining and here
    produces both a better silhouette and usable groups.
    """
    from sklearn.cluster import AgglomerativeClustering

    n = distance.shape[0]
    k = int(max(2, min(k, n - 1)))
    model = AgglomerativeClustering(n_clusters=k, metric="precomputed", linkage=linkage)
    return model.fit_predict(distance)


def silhouette(distance: np.ndarray, labels: np.ndarray) -> float:
    """Mean silhouette width, as a rough check that the clusters mean anything."""
    from sklearn.metrics import silhouette_score

    if len(set(labels.tolist())) < 2:
        return float("nan")
    return float(silhouette_score(distance, labels, metric="precomputed"))


def pairwise_jaccard_distance(incidence: sp.csr_matrix) -> np.ndarray:
    """Jaccard distance between rows of a binary incidence matrix."""
    return pairwise_distances(np.asarray((incidence > 0).todense()), metric="jaccard")
