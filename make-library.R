# Build the class library from a handout folder's own shared/*.qmd, in place.
# Run from inside an extracted handout folder:  Rscript make-library.R
#
# Why this exists: the handouts carry their setup through Quarto {{< include >}},
# which only runs at render. Interactive execution never sees it. This lifts the
# same R out into plain files the session loads at startup.

chunks <- function(path) {
  if (!file.exists(path)) return(character())
  lines <- readLines(path, warn = FALSE)
  out <- character(); i <- 1L; starts <- integer()
  while (i <= length(lines)) {
    if (grepl("^```\\{r[^}]*\\}[[:space:]]*$", lines[i])) {
      start <- i; i <- i + 1L; buf <- character()
      while (i <= length(lines) && !grepl("^```[[:space:]]*$", lines[i])) {
        if (!grepl("^[[:space:]]*#\\|", lines[i])) buf <- c(buf, lines[i])
        i <- i + 1L
      }
      i <- i + 1L
      if (any(nzchar(trimws(buf)))) { out <- c(out, paste(buf, collapse = "\n")); starts <- c(starts, start) }
    } else i <- i + 1L
  }
  attr(out, "starts") <- starts
  out
}

dir.create("qtm285base/R", recursive = TRUE, showWarnings = FALSE)

code <- chunks("shared/shared-code.qmd")
style <- chunks("shared/shared-style.qmd")
# shared-code includes shared-style into its own middle, so style loads between
# the two halves. Flattening without this leaves colour names undefined.
# Not every handout ships shared/ -- some carry no shared files at all.
if (length(code) || length(style)) {
  inc <- if (file.exists("shared/shared-code.qmd"))
    grep("\\{\\{<[[:space:]]*include[^}]*shared-style", readLines("shared/shared-code.qmd", warn = FALSE)) else integer()
  split_at <- if (length(inc)) inc[1] else .Machine$integer.max
  st <- attr(code, "starts")
  if (any(st < split_at)) writeLines(paste(code[st < split_at], collapse = "\n\n"), "qtm285base/R/10-setup.R")
  if (length(style))      writeLines(paste(style, collapse = "\n\n"),              "qtm285base/R/20-style.R")
  if (any(st > split_at)) writeLines(paste(code[st > split_at], collapse = "\n\n"), "qtm285base/R/30-code.R")
}

# Outside a render knitr::current_input() is NULL and normalizePath() errors on it.
f <- "qtm285base/R/10-setup.R"
if (file.exists(f)) {
s <- readLines(f, warn = FALSE)
s <- sub('^qtm285_document = normalizePath\\(knitr::current_input\\(dir = TRUE\\).*$',
         'qtm285_document = local({ f = knitr::current_input(dir = TRUE); if (is.null(f)) NA_character_ else normalizePath(f, winslash = "/", mustWork = FALSE) })',
         s)
writeLines(s, f)
}

# Any chapter files the document includes carry code too -- ga-turnout and
# ca-income are the data ones -- and they are equally non-executed interactively.
# Lift whichever this handout actually names, in the order it names them.
main <- setdiff(list.files(pattern = "[.]qmd$"), c("_submit-reminder.qmd"))
if (length(main)) {
  txt <- readLines(main[1], warn = FALSE)
  hits <- regmatches(txt, regexpr("chapters/[A-Za-z0-9._-]+[.]qmd", txt))
  hits <- unique(hits[nzchar(hits)])
  n <- 40L
  for (h in hits) {
    if (!file.exists(h)) next
    ch <- chunks(h)
    if (!length(ch)) next
    writeLines(paste(ch, collapse = "\n\n"),
               sprintf("qtm285base/R/%d-%s.R", n, sub("[.]qmd$", "", basename(h))))
    n <- n + 1L
  }
  cat("lifted", length(hits), "chapter include(s)\n")
}

writeLines(c(
  '# Loads the class library before the student runs anything.',
  '# .Rprofile and .First both run BEFORE R attaches its default packages, so',
  '# grDevices/stats/etc are attached explicitly or the theme code cannot find rgb().',
  '.First <- function() {',
  '  for (p in c("grDevices","graphics","stats","utils","datasets"))',
  '    suppressMessages(library(p, character.only = TRUE))',
  '  for (f in sort(list.files("qtm285base/R", pattern = "[.][Rr]$", full.names = TRUE)))',
  '    sys.source(f, envir = globalenv())',
  '}'), ".Rprofile")

cat("built qtm285base/R from shared/*.qmd and wrote .Rprofile\n")
