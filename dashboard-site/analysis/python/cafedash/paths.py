"""Project-root resolution.

Paths are anchored to a marker file rather than to the working directory, so a
script behaves identically whether it is run from the project root, from
`analysis/python/`, or pasted into an interactive session.
"""

from __future__ import annotations

from pathlib import Path

MARKER = "AGENTS.md"


def _find_root(start: Path, marker: str = MARKER) -> Path:
    for parent in [start, *start.parents]:
        if (parent / marker).exists():
            return parent
    raise RuntimeError(f"no {marker} found at or above {start}")


PROJECT_ROOT: Path = _find_root(Path(__file__).resolve())
"""The `dashboard-site/` directory: everything this pipeline reads and writes."""

REPO_ROOT: Path = PROJECT_ROOT.parent
"""The repository root, one level up. `dv-data/` lives here, outside the site."""


def resolve_path(value: str | Path) -> Path:
    """Resolve a config path against the project root.

    A leading `../` escapes to the repository root, which is how the extract
    directory is reached: it sits outside `dashboard-site/` because it is
    gitignored pending a decision on how the data will be shared.
    """
    path = Path(value)
    return path if path.is_absolute() else (PROJECT_ROOT / path).resolve()
