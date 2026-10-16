"""Compare the actual downloaded and Positron-saved homework as Pandoc documents."""
import json
import subprocess
import sys
from pathlib import Path


def parse(text):
    result = subprocess.run(
        ["quarto", "pandoc", "--from=markdown", "--to=json"],
        input=text, capture_output=True, text=True, encoding="utf-8", check=True,
    )
    return json.loads(result.stdout)


def normalize(value):
    if isinstance(value, list):
        return [normalize(item) for item in value]
    if isinstance(value, dict):
        if value.get("t") == "SoftBreak":
            return {"t": "Space"}
        return {key: normalize(item) for key, item in value.items()}
    return value


def main():
    before, after = (Path(name) for name in sys.argv[1:])
    original = normalize(parse(before.read_text(encoding="utf-8")))
    saved = normalize(parse(after.read_text(encoding="utf-8")))
    if original != saved:
        sys.exit("Positron changed document content, code, math, attributes or metadata; inspect the retained QMD files.")
    print("Downloaded and Preview-saved homework have identical Pandoc content; only paragraph line wrapping is normalized.")


if __name__ == "__main__":
    main()
