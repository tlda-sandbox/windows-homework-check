# windows-homework-check

A repeatable Windows execution check for the QTM 285 student handouts, run on
GitHub-hosted `windows-latest` runners in `tlda-sandbox`. It exists because no
Windows execution route existed anywhere else (measured 2026-10-09: no CI in the
course repo, no `windows-latest` workflow in any of 169 repos under `~/work`, no
Windows host on the tailnet, no local VM tooling), and because the Windows
student reports (`with_seed` failing "on some path issue") could not be tested
from a Mac.

## What it exercises

- Downloads the public student zips exactly as a student does:
  `https://qtm285.github.io/static/book/homework/handouts/<homework>-handout.zip`
  (currently `homework-comparing-estimators` and
  `homework-random-variables-and-moments`).
- Extracts them and records the extraction nesting (`extract-tree.txt`).
- Installs R (release) and Quarto, plus the packages the handouts load.
- Per handout folder, records the project configuration, the folder listing,
  the working directory R sees, whether `data/*.csv` resolves, whether
  `with_seed()` runs over a read, and the complete `quarto render` output.

The render failures ARE the evidence: the job ends red when a render fails, and
`render-log.txt` (the `render-logs` artifact on every run, pass or fail) carries
the full output including the exact commands and errors.

## What it does not exercise

- **Interactive Positron.** Batch rendering and the IDE are different execution
  modes. A Positron proof on Windows still needs a desktop errand; this repo
  only answers the batch-render question.
- A student's own machine or profile. It is a clean-room runner, which is the
  point: if a path fails here, the artifact or the code is implicated; if it
  passes here, the failure is environmental to the student's setup.

## Re-running

Actions -> "Windows handout check" -> Run workflow, or push to `main`.

## Provenance

Prepared 2026-10-09 by `hw5-review-render` (fleet:b25613b7) on task
fleet:b256-mv1h2cy6, through the `tlda-sandbox` App installation. Public repo on
purpose: public repositories get free Windows runner minutes, and the zips it
downloads are already public.
