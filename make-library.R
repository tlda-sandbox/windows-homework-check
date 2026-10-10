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
inc <- grep("\\{\\{<[[:space:]]*include[^}]*shared-style", readLines("shared/shared-code.qmd", warn = FALSE))
split_at <- if (length(inc)) inc[1] else length(code)
st <- attr(code, "starts")

writeLines(paste(code[st < split_at], collapse = "\n\n"), "qtm285base/R/10-setup.R")
writeLines(paste(style, collapse = "\n\n"),              "qtm285base/R/20-style.R")
writeLines(paste(code[st > split_at], collapse = "\n\n"), "qtm285base/R/30-code.R")

# Outside a render knitr::current_input() is NULL and normalizePath() errors on it.
f <- "qtm285base/R/10-setup.R"
s <- readLines(f, warn = FALSE)
s <- sub('^qtm285_document = normalizePath\\(knitr::current_input\\(dir = TRUE\\).*$',
         'qtm285_document = local({ f = knitr::current_input(dir = TRUE); if (is.null(f)) NA_character_ else normalizePath(f, winslash = "/", mustWork = FALSE) })',
         s)
writeLines(s, f)

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
