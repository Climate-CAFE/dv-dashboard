"""Shared helpers for the CAFE Dataverse dashboard pipeline.

Every module here is importable from a plain Python session so that an auditor
can reproduce any published number without running the site build:

    >>> import sys; sys.path.insert(0, "analysis/python")
    >>> from cafedash import load_config, read_extract
    >>> cfg = load_config()
    >>> read_extract("2.15", cfg).shape
"""

from cafedash.config import CONFIG_PATH, load_config
from cafedash.extracts import extract_path, list_extracts, read_extract
from cafedash.paths import PROJECT_ROOT, REPO_ROOT, resolve_path

__all__ = [
    "CONFIG_PATH",
    "PROJECT_ROOT",
    "REPO_ROOT",
    "extract_path",
    "list_extracts",
    "load_config",
    "read_extract",
    "resolve_path",
]
