"""Loading of `config/dashboard-config.yml`.

The same file drives the R half of the pipeline. Anything that changes a
published number belongs there rather than inline in a script.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from cafedash.paths import PROJECT_ROOT

CONFIG_PATH: Path = PROJECT_ROOT / "config" / "dashboard-config.yml"


@lru_cache(maxsize=4)
def load_config(path: str | Path | None = None) -> dict[str, Any]:
    """Read the shared configuration.

    Cached so repeated calls inside one session are free. Pass an explicit
    `path` to test against an alternative configuration.
    """
    config_path = Path(path) if path is not None else CONFIG_PATH
    with config_path.open(encoding="utf-8") as handle:
        config = yaml.safe_load(handle)
    if not isinstance(config, dict):
        raise ValueError(f"{config_path} did not parse to a mapping")
    return config


def config_dir(config: dict[str, Any], key: str, create: bool = False) -> Path:
    """Resolve one of the `paths:` entries to an absolute directory."""
    from cafedash.paths import resolve_path

    directory = resolve_path(config["paths"][key])
    if create:
        directory.mkdir(parents=True, exist_ok=True)
    return directory
