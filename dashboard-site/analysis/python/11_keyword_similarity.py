#!/usr/bin/env python3
"""Keyword similarity between CAFE datasets, by three methods.

`SETUP.md`: "using the parsed keywords, please create vector representations of
similarity between datasets that are based on the usage of similar keywords.
Document the process for determining similarity of keywords and print the
justification below the plot on the page when this similarity dimension is
selected."

The parsing is not repeated here. `01-datasets.R` writes
`dataset-keywords.tsv` from extract 2.14a, already normalised, and this script
reads that. One normalisation, used by both the R keyword summaries and this
analysis, so the two views of keyword structure cannot disagree.

The three methods, and why there are three: a reader asking "which datasets are
like this one" is asking a question with more than one defensible answer, and
the methods differ in exactly the way that matters -- how much a shared keyword
counts, and whether two different keywords can count as related at all. Each
one's reasoning, including what it gets wrong, is written next to its
implementation in `cafedash/similarity.py` and is carried into the JSON so the
site can print it beneath the plot.

READS   analysis/derived/dataset-keywords.tsv, datasets.tsv
WRITES  public/data/similarity-keyword.json

RUN IT ALONE
  uv run python analysis/python/11_keyword_similarity.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import pandas as pd
import scipy.sparse as sp

from cafedash.bundle import build_method_payload, write_bundle
from cafedash.config import config_dir, load_config
from cafedash.similarity import keyword_jaccard, keyword_ppmi_svd, keyword_tfidf_cosine

DESCRIPTION = (
    "Datasets positioned by the keywords their depositors assigned. Pick a "
    "method to change what counts as 'similar': raw overlap, overlap weighted "
    "by how rare each keyword is, or similarity in a keyword space learned "
    "from how keywords co-occur across the collection."
)


def main() -> int:
    config = load_config()
    derived = config_dir(config, "derived")
    site_data = config_dir(config, "site_data", create=True)
    keyword_config = config["similarity"]["keyword"]
    seed = int(config["similarity"]["random_seed"])

    datasets = pd.read_csv(derived / "datasets.tsv", sep="\t", dtype=str, keep_default_na=False)
    pairs = pd.read_csv(
        derived / "dataset-keywords.tsv", sep="\t", dtype=str, keep_default_na=False
    )

    pairs = pairs[pairs["dataset_id"].isin(set(datasets["dataset_id"]))]
    pairs = pairs[pairs["keyword"].str.len() > 0]

    # Datasets with no keywords cannot be placed by keyword similarity. They
    # are dropped rather than parked at the origin, where they would form a
    # dense fake cluster that a reader would take for a finding.
    with_keywords = sorted(set(pairs["dataset_id"]))
    excluded_ids = sorted(set(datasets["dataset_id"]) - set(with_keywords))
    print(
        f"[keyword] {len(with_keywords)} datasets with keywords; "
        f"{len(excluded_ids)} without, excluded"
    )

    dataset_index = {ds: i for i, ds in enumerate(with_keywords)}
    vocabulary = sorted(set(pairs["keyword"]))
    keyword_index = {kw: i for i, kw in enumerate(vocabulary)}

    rows = pairs["dataset_id"].map(dataset_index).to_numpy()
    cols = pairs["keyword"].map(keyword_index).to_numpy()
    incidence = sp.csr_matrix(
        (np.ones(len(rows), dtype=np.float64), (rows, cols)),
        shape=(len(with_keywords), len(vocabulary)),
    )
    incidence.data[:] = 1.0  # a dataset carrying a keyword twice still carries it once
    print(f"[keyword] incidence matrix {incidence.shape}, {incidence.nnz} assignments")

    methods = []
    for key in keyword_config["methods"]:
        print(f"  computing {key}")
        if key == "jaccard":
            result = keyword_jaccard(incidence, vocabulary)
        elif key == "tfidf_cosine":
            result = keyword_tfidf_cosine(
                incidence, vocabulary, min_df=int(keyword_config["tfidf_min_df"])
            )
        elif key == "ppmi_svd":
            result = keyword_ppmi_svd(
                incidence,
                vocabulary,
                dims=int(keyword_config["ppmi_dims"]),
                shift=float(keyword_config["ppmi_shift"]),
                seed=seed,
            )
        else:
            raise ValueError(f"unknown keyword similarity method: {key}")
        methods.append(build_method_payload(result, config))

    # Each dataset's rarest keywords, for the tooltip: they are what makes it
    # sit where it does under the weighted methods.
    document_frequency = np.asarray((incidence > 0).sum(axis=0)).ravel()
    rarity = {kw: int(document_frequency[i]) for kw, i in keyword_index.items()}
    by_dataset = pairs.groupby("dataset_id")["keyword"].apply(list)
    dataset_keywords = [
        sorted(by_dataset.get(ds, []), key=lambda k: rarity.get(k, 0))[:8] for ds in with_keywords
    ]

    write_bundle(
        site_data / "similarity-keyword.json",
        dimension="keyword",
        label="Keyword similarity",
        description=DESCRIPTION,
        ids=with_keywords,
        methods=methods,
        excluded={
            "n": len(excluded_ids),
            "reason": "no keywords recorded in the latest released version",
            "ids": excluded_ids[:200],
        },
        extra={
            "vocabulary": len(vocabulary),
            "assignments": int(incidence.nnz),
            "datasetKeywords": dataset_keywords,
        },
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
