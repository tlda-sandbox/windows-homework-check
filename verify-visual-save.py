"""Compare the actual downloaded and Positron-saved homework as Pandoc documents."""
import json
import re
import subprocess
import sys
from pathlib import Path


def parse(text):
    # Pandoc needs {.r} where Quarto uses {r}. Preserve all code contents.
    lines = []
    fence = None
    cells = []
    cell = None
    for line in text.splitlines(keepends=True):
        match = re.match(r"^( {0,3})(`{3,}|~{3,})([^\r\n]*)", line)
        if match and fence:
            run = match.group(2)
            if run[0] == fence[0] and len(run) >= len(fence) and not match.group(3).strip():
                if cell is not None:
                    cell["closing"] = match.group(2)
                    cells.append(cell)
                    cell = None
                fence = None
            elif cell is not None:
                cell["body"] += line
        elif match:
            fence = match.group(2)
            if re.fullmatch(r"\{[A-Za-z][\w.+-]*\}", match.group(3)):
                cell = {"opening": match.group(2) + match.group(3), "body": ""}
                start = match.start(3)
                line = line[:start + 1] + "." + line[start + 1:]
        elif cell is not None:
            cell["body"] += line
        lines.append(line)
    if cell is not None:
        cells.append(cell)
    text = "".join(lines)
    result = subprocess.run(
        ["quarto", "pandoc", "--from=markdown", "--to=json"],
        input=text, capture_output=True, text=True, encoding="utf-8", check=True,
    )
    document = json.loads(result.stdout)
    # Keep executable identity separate from the reader adaptation above:
    # {r} executes, while {.r} is merely displayed. Never erase that distinction.
    document["quarto-executable-cells"] = cells
    return document


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
    print("Downloaded and Preview-saved homework have identical Pandoc content; executable fences are parsed as code and paragraph line wrapping is normalized.")


if __name__ == "__main__":
    main()
