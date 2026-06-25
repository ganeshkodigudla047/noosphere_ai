from __future__ import annotations

from pathlib import Path

_env_path = Path(__file__).resolve().parent.parent / ".env"

GROQ_API_KEY: str = ""

if _env_path.exists():
    for _line in _env_path.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line.startswith("GROQ_API_KEY="):
            GROQ_API_KEY = _line.split("=", 1)[1].strip().strip('"').strip("'")
            break

if not GROQ_API_KEY:
    import os
    GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
