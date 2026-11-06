#!/usr/bin/env python3
"""Checks that sw.js stores every script of the app and only files that exist."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    source = (ROOT / "sw.js").read_text()
    block = re.search(r"const APP_FILES = \[(.*?)\];", source, re.S)
    if not block:
        print("APP_FILES not found in sw.js")
        return 1
    listed = set(re.findall(r"'([^']+)'", block.group(1)))

    errors = [f"Listed but missing: {path}" for path in sorted(listed - {"./"}) if not (ROOT / path).is_file()]
    scripts = {path.relative_to(ROOT).as_posix() for folder in ("js", "css") for path in (ROOT / folder).rglob("*.*")}
    errors += [f"Not available offline: {path}" for path in sorted(scripts - listed)]

    for error in errors:
        print(error)
    if not errors:
        print(f"Offline list OK: {len(listed)} files")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
