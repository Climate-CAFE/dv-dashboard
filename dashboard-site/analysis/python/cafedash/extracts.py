"""Reading the SQL extract set.

The extracts are **quoted CSV with a tab delimiter**, not naive TSVs. Extract
3.2's `description` column holds HTML with embedded newlines, so a
split-on-tab reader mangles it and silently produces phantom rows. Everything
here goes through a proper RFC-4180 parser.

Every column is read as text and empty strings are preserved as empty strings
rather than becoming NaN, because several columns are genuinely three-valued:
`first_published` is empty for both drafts and harvested datasets, and those
two cases mean different things.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pandas as pd

from cafedash.config import config_dir, load_config

_BOOL_TRUE = {"t", "true", "yes", "y", "1"}
_BOOL_FALSE = {"f", "false", "no", "n", "0", ""}


def extract_path(query: str, config: dict[str, Any] | None = None) -> Path:
    """Absolute path to one extract, addressed by its query number ("2.15")."""
    config = config or load_config()
    directory = config_dir(config, "extracts")
    prefix = config["paths"]["extract_prefix"]
    return directory / f"{prefix}{query}.tsv"


def list_extracts(config: dict[str, Any] | None = None) -> list[str]:
    """Query numbers present on disk, in the order psql produced them."""
    config = config or load_config()
    directory = config_dir(config, "extracts")
    prefix = config["paths"]["extract_prefix"]
    return sorted(p.name[len(prefix) : -len(".tsv")] for p in directory.glob(f"{prefix}*.tsv"))


def read_extract(query: str, config: dict[str, Any] | None = None) -> pd.DataFrame:
    """Read one extract as an all-text DataFrame.

    Raises if the file is missing, naming the likely reason: nine of the 53
    produced extracts carried email addresses and were withheld from the
    "no-personal-data" set on disk.
    """
    path = extract_path(query, config)
    if not path.exists():
        raise FileNotFoundError(
            f"extract {query} not found at {path}. "
            "Extracts 1.4, 1.5a, 1.5b, 1.7, 2.3, 2.5a, 2.13b, 2.13c, 3.1 and 4.1d "
            "were withheld from the no-personal-data set because they carry email "
            "addresses; see dv-data/README.md."
        )
    return pd.read_csv(
        path,
        sep="\t",
        dtype=str,
        keep_default_na=False,
        na_filter=False,
        quotechar='"',
        doublequote=True,
        engine="python",
    )


def as_bool(series: pd.Series) -> pd.Series:
    """Convert PostgreSQL's `t`/`f` text booleans to real booleans.

    Anything unrecognised raises rather than silently becoming False: a typo in
    a membership flag would otherwise shrink the analysis population without
    any signal.
    """
    lowered = series.astype(str).str.strip().str.lower()
    unknown = set(lowered.unique()) - _BOOL_TRUE - _BOOL_FALSE
    if unknown:
        raise ValueError(f"unrecognised boolean values: {sorted(unknown)}")
    return lowered.isin(_BOOL_TRUE)


def is_blank(series: pd.Series) -> pd.Series:
    """True where a text column is empty or whitespace-only."""
    return series.astype(str).str.strip().eq("")


def split_list(series: pd.Series, pattern: str) -> pd.Series:
    """Split a delimiter-joined column into a Series of lists, dropping blanks."""
    compiled = re.compile(pattern)
    return series.astype(str).map(
        lambda value: [part.strip() for part in compiled.split(value) if part.strip()]
    )
