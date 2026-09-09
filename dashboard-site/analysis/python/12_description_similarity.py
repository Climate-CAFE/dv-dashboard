#!/usr/bin/env python3
"""Description similarity between CAFE datasets, by three methods.

`SETUP.md`: "each dataset's full description is available in the metadata.
Parse those descriptions and organize the datasets according to the semantic
similarity of their descriptions. You may use multiple methods for determining
similarity, but as with the keywords, please document your process and print
the justification below the plot on the page."

WHERE THE DESCRIPTIONS COME FROM
--------------------------------
Not from the extract set. Extracts 1.4 and 1.7 carry abstracts and were both
withheld from the "no-personal-data" set because depositors type email
addresses into abstracts and no field-type filter reaches those. Descriptions
are re-fetched from Harvard Dataverse's public Search API by
`10_fetch_public_metadata.py`, which redacts any address it finds, and land in
`cache/descriptions.tsv`. That cache is gitignored, so this script needs the
fetch to have run; it is not reproducible from a bare clone without network
access, and it says so rather than failing obscurely.

WHY THESE THREE METHODS AND NOT AN EMBEDDING MODEL
--------------------------------------------------
A sentence-transformer would give better semantic matching. It is not used
here, for reasons that are about this project rather than about quality:

  - It would add roughly a gigabyte of PyTorch and a downloaded model to a
    pipeline whose whole point is that an R or Python reviewer can rerun any
    step in isolation. Every method here runs from `uv sync` and nothing else.
  - Results would depend on a model checkpoint that is not in the repository,
    so "rerun this and check" stops being possible.
  - The three methods below disagree in informative ways. A single opaque
    embedding gives one answer with no handle on why.

The extension point is real, though: a fourth method returning an n x n
similarity matrix drops into `cafedash/similarity.py` and appears in the
dropdown with no other change. That is the intended route if the team decides
the tradeoff should go the other way.

READS   cache/descriptions.tsv, analysis/derived/datasets.tsv
WRITES  public/data/similarity-description.json

RUN IT ALONE
  uv run python analysis/python/12_description_similarity.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pandas as pd

from cafedash.bundle import build_method_payload, write_bundle
from cafedash.config import config_dir, load_config
from cafedash.similarity import (
    description_lsa_cosine,
    description_nmf_topics,
    description_tfidf_cosine,
)
from cafedash.textprep import build_document

DESCRIPTION = (
    "Datasets positioned by what their descriptions say. Pick a method to "
    "change how the text is represented: shared distinctive wording, a "
    "latent-semantic projection that lets different words match, or a "
    "topic model whose dimensions can be read and named."
)

# Below this many characters after cleaning there is not enough text to place a
# dataset anywhere meaningful, and including it would put a cluster of
# near-empty documents at the centre of the plot.
MIN_DOCUMENT_CHARS = 60


def main() -> int:
    config = load_config()
    derived = config_dir(config, "derived")
    cache = config_dir(config, "cache")
    site_data = config_dir(config, "site_data", create=True)
    description_config = config["similarity"]["description"]
    seed = int(config["similarity"]["random_seed"])

    descriptions_path = cache / "descriptions.tsv"
    if not descriptions_path.exists():
        raise SystemExit(
            f"{descriptions_path} not found.\n"
            "Descriptions are not in the extract set: 1.4 and 1.7 were withheld "
            "because they carry email addresses. Run\n"
            "  uv run python analysis/python/10_fetch_public_metadata.py\n"
            "to fetch them from Harvard Dataverse's public API first."
        )

    datasets = pd.read_csv(derived / "datasets.tsv", sep="\t", dtype=str, keep_default_na=False)
    descriptions = pd.read_csv(descriptions_path, sep="\t", dtype=str, keep_default_na=False)

    # DOIs are case-insensitive and the two sources disagree: the application
    # database lowercases harvested DOIs, the API uppercases them. Joining on
    # the raw string loses every harvested dataset -- 513 of 1,307 -- and looks
    # like missing descriptions rather than a join bug.
    datasets["gid_key"] = datasets["global_id"].str.strip().str.lower()
    descriptions["gid_key"] = descriptions["global_id"].str.strip().str.lower()

    merged = datasets.merge(
        descriptions[["gid_key", "description"]], on="gid_key", how="left", validate="one_to_one"
    )
    merged["description"] = merged["description"].fillna("")

    matched = int((merged["description"].str.len() > 0).sum())
    print(f"[description] {matched}/{len(merged)} datasets matched to a description")
    if matched < 0.9 * len(merged):
        raise SystemExit(
            f"FATAL: only {matched} of {len(merged)} datasets matched a description. "
            "Expected near-complete coverage; check the join key before publishing."
        )

    merged["document"] = [
        build_document(title, description)
        for title, description in zip(merged["title"], merged["description"], strict=True)
    ]

    usable = merged[merged["document"].str.len() >= MIN_DOCUMENT_CHARS].reset_index(drop=True)
    excluded = merged[merged["document"].str.len() < MIN_DOCUMENT_CHARS]
    print(
        f"[description] {len(usable)} usable documents; "
        f"{len(excluded)} shorter than {MIN_DOCUMENT_CHARS} characters, excluded"
    )

    ids = usable["dataset_id"].tolist()
    documents = usable["document"].tolist()

    lengths = usable["document"].str.len()
    print(
        f"[description] document length: median {int(lengths.median())}, "
        f"min {int(lengths.min())}, max {int(lengths.max())} characters"
    )

    # The TF-IDF matrix is shared: LSA and NMF both factor it, so building it
    # once keeps the three methods comparable by construction. They differ only
    # in what they do to the same representation.
    tfidf_result, matrix, vocabulary = description_tfidf_cosine(documents, description_config)

    methods = []
    for key in description_config["methods"]:
        print(f"  computing {key}")
        if key == "tfidf_cosine":
            result = tfidf_result
        elif key == "lsa_cosine":
            result = description_lsa_cosine(matrix, vocabulary, description_config, seed=seed)
        elif key == "nmf_topics":
            result = description_nmf_topics(matrix, vocabulary, description_config, seed=seed)
        else:
            raise ValueError(f"unknown description similarity method: {key}")
        methods.append(build_method_payload(result, config))

    write_bundle(
        site_data / "similarity-description.json",
        dimension="description",
        label="Description similarity",
        description=DESCRIPTION,
        ids=ids,
        methods=methods,
        excluded={
            "n": len(excluded),
            "reason": f"description shorter than {MIN_DOCUMENT_CHARS} characters after cleaning",
            "ids": excluded["dataset_id"].tolist()[:200],
        },
        extra={
            "vocabulary": len(vocabulary),
            "medianDocumentChars": int(lengths.median()),
            "source": (
                "Harvard Dataverse public Search API, fetched "
                "2026-09-08. Descriptions are not in the extract set: 1.4 and "
                "1.7 were withheld because they carry email addresses."
            ),
        },
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
