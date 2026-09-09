"""Turning similarity results into the payload the site loads.

Both similarity scripts write the same JSON shape, so the site has one loader
and one renderer regardless of which dimension the reader selects.

Coordinates are rounded and neighbours are stored as row indices rather than
dataset ids, which roughly halves the file. The `ids` array at the top level is
the key back to `datasets.json`.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np

from cafedash.similarity import (
    SimilarityResult,
    classical_mds,
    cluster,
    nearest_neighbours,
    project_tsne,
    silhouette,
)


def _round_coords(coords: np.ndarray, decimals: int = 2) -> list[list[float]]:
    """Scale to a stable range and round, so rebuilds produce small diffs."""
    finite = coords[np.isfinite(coords).all(axis=1)]
    if len(finite) == 0:
        return [[0.0, 0.0] for _ in range(len(coords))]
    span = np.abs(finite).max()
    scaled = coords / span * 100.0 if span > 0 else coords
    return [[round(float(x), decimals), round(float(y), decimals)] for x, y in scaled]


def build_method_payload(
    result: SimilarityResult,
    config: dict[str, Any],
) -> dict[str, Any]:
    """Project, cluster and package one similarity metric."""
    similarity_config = config["similarity"]
    projection = similarity_config["projection"]
    seed = int(similarity_config["random_seed"])
    distance = result.distance

    print(f"    [{result.key}] projecting {distance.shape[0]} datasets", flush=True)
    tsne = project_tsne(
        distance,
        seed=seed,
        perplexity=float(projection["tsne_perplexity"]),
        iterations=int(projection["tsne_iterations"]),
    )
    mds = classical_mds(distance)
    labels = cluster(distance, int(projection["clusters"]), projection.get("linkage", "complete"))

    # How lopsided the clustering came out. On a metric where most pairs are
    # exactly zero -- keyword Jaccard, where most datasets share no keyword at
    # all -- the distance matrix is nearly uniform and no linkage can find
    # groups in it: everything lands in one cluster with a few specks around
    # it. That is a fact about the metric, not a failure of the clustering, so
    # it is measured and published rather than papered over by an algorithm
    # that would return balanced groups whether or not they mean anything.
    sizes = Counter(labels.tolist())
    largest_share = max(sizes.values()) / len(labels)

    payload = {
        "key": result.key,
        "label": result.label,
        "justification": result.justification,
        "params": result.params,
        "diagnostics": {
            **result.diagnostics,
            "mean_similarity": round(
                float(
                    (result.similarity.sum() - distance.shape[0])
                    / max(distance.shape[0] * (distance.shape[0] - 1), 1)
                ),
                4,
            ),
            "silhouette": round(silhouette(distance, labels), 4),
            "clusters": len(set(labels.tolist())),
            "cluster_linkage": projection.get("linkage", "complete"),
            "largest_cluster_share": round(float(largest_share), 4),
            "clustering_informative": bool(largest_share <= 0.6),
        },
        "coords": {"tsne": _round_coords(tsne), "mds": _round_coords(mds)},
        "clusters": [int(v) for v in labels],
        "neighbours": nearest_neighbours(result.similarity, int(similarity_config["n_neighbors"])),
    }
    if result.terms:
        payload["terms"] = result.terms
    if result.per_dataset_terms:
        payload["datasetTerms"] = result.per_dataset_terms
    return payload


def write_bundle(
    path: Path,
    dimension: str,
    label: str,
    description: str,
    ids: list[str],
    methods: list[dict[str, Any]],
    excluded: dict[str, Any],
    extra: dict[str, Any] | None = None,
) -> None:
    payload: dict[str, Any] = {
        "dimension": dimension,
        "label": label,
        "description": description,
        "n": len(ids),
        "ids": ids,
        "methods": {method["key"]: method for method in methods},
        "methodOrder": [method["key"] for method in methods],
        "excluded": excluded,
    }
    if extra:
        payload.update(extra)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"  wrote {path.name:32s} {path.stat().st_size / 1024:8.1f} KB")
