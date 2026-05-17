"""Entry point for ``python -m urban_acoustics`` and the systemd ExecStart.

The CLI is intentionally tiny — config lives in the JSON file pointed at by
``URBAN_ACOUSTICS_CONFIG`` (or ``--config``), and everything else is read
from that file. We don't accept calibration / threshold overrides on the
command line so a typo in a unit file can't silently change measurement.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import pathlib
import sys

from .config import load_config
from .supervisor import Supervisor


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="urban-acoustics", description="Urban Acoustics Pi firmware")
    p.add_argument(
        "--config", type=pathlib.Path, default=None,
        help="Path to config JSON (default: /etc/urban-acoustics/config.json or $URBAN_ACOUSTICS_CONFIG)",
    )
    p.add_argument(
        "--log-level", default=os.environ.get("URBAN_ACOUSTICS_LOG_LEVEL", "INFO"),
        help="Logging level (default: INFO)",
    )
    return p.parse_args(argv)


def _setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    _setup_logging(args.log_level)
    cfg = load_config(args.config)
    sup = Supervisor(cfg)
    try:
        return asyncio.run(sup.run())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
