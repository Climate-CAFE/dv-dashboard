# functions.R -- helpers shared by every R script in the pipeline.
#
# Sourced by setup.R, which is in turn sourced at the top of each numbered
# script. Nothing here reads the working directory: paths are anchored with
# here::here() off the .here sentinel in dashboard-site/.

# ---------------------------------------------------------------------------
# Package loading
#
# load_pkgs() strictly loads. Installs go through renv (via pak); if a package
# is missing, library() errors loudly and the fix is renv::restore().
# ---------------------------------------------------------------------------
load_pkgs <- function(...) {
  pkgs <- c(...)
  invisible(lapply(pkgs, library, character.only = TRUE))
}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

#' Read config/dashboard-config.yml.
#'
#' The same file drives the Python half of the pipeline. Anything that changes
#' a published number belongs there rather than inline in a script.
dash_config <- function() {
  yaml::read_yaml(here::here("config", "dashboard-config.yml"))
}

#' Resolve one of the config `paths:` entries to an absolute path.
#'
#' A leading "../" escapes to the repository root, which is how the extract
#' directory is reached: dv-data/ sits outside dashboard-site/ because it is
#' gitignored pending a decision on how it will be shared.
dash_path <- function(cfg, key, create = FALSE) {
  value <- cfg$paths[[key]]
  path <- if (startsWith(value, "/")) value else file.path(here::here(), value)
  path <- normalizePath(path, mustWork = FALSE)
  if (create && !dir.exists(path)) dir.create(path, recursive = TRUE)
  path
}

# ---------------------------------------------------------------------------
# Reading the SQL extracts
# ---------------------------------------------------------------------------

#' Read one extract, addressed by query number ("2.15").
#'
#' The extracts are quoted CSV with a tab delimiter, not naive TSVs: extract
#' 3.2's `description` column holds HTML with embedded newlines, so a
#' split-on-tab reader mangles it and invents rows. Everything is read as
#' character and blanks stay blank -- several columns are genuinely
#' three-valued, and `first_published` being empty means "draft" for a local
#' dataset but "harvested" for a harvested one.
read_extract <- function(query, cfg = dash_config()) {
  path <- file.path(dash_path(cfg, "extracts"), paste0(cfg$paths$extract_prefix, query, ".tsv"))
  if (!file.exists(path)) {
    stop(sprintf(
      paste0(
        "extract %s not found at %s.\n",
        "Extracts 1.4, 1.5a, 1.5b, 1.7, 2.3, 2.5a, 2.13b, 2.13c, 3.1 and 4.1d were\n",
        "withheld from the no-personal-data set because they carry email addresses.\n",
        "See dv-data/README.md."
      ),
      query, path
    ), call. = FALSE)
  }
  readr::read_delim(
    path,
    delim = "\t",
    quote = "\"",
    escape_double = TRUE,
    escape_backslash = FALSE,
    col_types = readr::cols(.default = readr::col_character()),
    na = character(),
    trim_ws = FALSE,
    progress = FALSE
  )
}

#' PostgreSQL text booleans ("t"/"f") to logical.
#'
#' Anything unrecognised errors rather than silently becoming FALSE: a typo in
#' a membership flag would otherwise shrink the analysis population with no
#' signal at all.
as_pg_logical <- function(x) {
  lowered <- tolower(trimws(as.character(x)))
  known <- c("t", "true", "yes", "y", "1", "f", "false", "no", "n", "0", "")
  unknown <- setdiff(unique(lowered), known)
  if (length(unknown) > 0) {
    stop("unrecognised boolean values: ", paste(unknown, collapse = ", "), call. = FALSE)
  }
  lowered %in% c("t", "true", "yes", "y", "1")
}

#' TRUE where a character column is empty or whitespace-only.
is_blank <- function(x) is.na(x) | trimws(as.character(x)) == ""

#' Blank-safe numeric coercion. Empty strings become NA, not 0.
as_num <- function(x) {
  out <- suppressWarnings(as.numeric(trimws(as.character(x))))
  out[is_blank(x)] <- NA_real_
  out
}

#' Blank-safe date coercion for the extracts' timestamp columns.
as_dt <- function(x) {
  cleaned <- trimws(as.character(x))
  cleaned[cleaned == ""] <- NA_character_
  as.POSIXct(cleaned, tz = "UTC", tryFormats = c(
    "%Y-%m-%d %H:%M:%OS", "%Y-%m-%dT%H:%M:%OSZ", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"
  ))
}

# ---------------------------------------------------------------------------
# Text normalisation
# ---------------------------------------------------------------------------

#' Collapse whitespace and trim. Used before any string comparison.
squish <- function(x) stringr::str_squish(as.character(x))

#' Case-fold a persistent identifier so it can be used as a join key.
#'
#' DOIs are case-insensitive by specification, and the two sources here
#' disagree about case: the Dataverse application database stores harvested
#' DOIs lowercased ("doi:10.17603/ds2-00j5-j181") while the search API returns
#' them uppercased ("doi:10.17603/DS2-00J5-J181"). Joining on the raw string
#' drops every harvested dataset -- 513 of 1,307 here -- and the symptom looks
#' like "the API has no description for these" rather than like a join bug.
#' Always join on doi_key(), never on global_id.
doi_key <- function(x) tolower(squish(x))

#' Split a delimiter-joined column into a list-column, dropping blanks.
split_list <- function(x, pattern) {
  purrr::map(stringr::str_split(as.character(x), pattern), \(parts) {
    parts <- squish(parts)
    parts[nzchar(parts)]
  })
}

#' Strip HTML tags and decode the handful of entities Dataverse emits.
#'
#' Collection descriptions (3.2) and many dataset abstracts are stored as HTML.
#' Left in place, tag names become tokens in the text analysis and markup shows
#' up in the site's tooltips.
strip_html <- function(x) {
  out <- stringr::str_replace_all(as.character(x), "<[^>]*>", " ")
  entities <- c(
    "&nbsp;" = " ", "&amp;" = "&", "&lt;" = "<", "&gt;" = ">",
    "&quot;" = "\"", "&#39;" = "'", "&apos;" = "'", "&mdash;" = "-", "&ndash;" = "-"
  )
  for (entity in names(entities)) {
    out <- stringr::str_replace_all(out, stringr::fixed(entity), entities[[entity]])
  }
  squish(out)
}

# ---------------------------------------------------------------------------
# Author and keyword parsing
# ---------------------------------------------------------------------------

#' Drop descriptor labels from a character vector of author names.
#'
#' SETUP.md: '"Federal Agency" is not a unique author, but a descriptor label,
#' and should be ignored during author parsing.'
#'
#' Matching is on the whole trimmed string, case-insensitively, never as a
#' substring. "National Aeronautics and Space Administration (NASA)" has to
#' survive a rule that removes "Federal Agency", and a substring match on
#' "Industry" would eat "Industry Canada".
drop_descriptor_labels <- function(names, cfg = dash_config()) {
  labels <- tolower(squish(cfg$authors$descriptor_labels))
  cleaned <- squish(names)
  keep <- !(tolower(cleaned) %in% labels) &
    nchar(cleaned) >= cfg$authors$min_name_chars
  cleaned[keep]
}

#' Normalise a keyword for counting: squish, case-fold, drop placeholders.
normalise_keyword <- function(x, cfg = dash_config()) {
  out <- squish(x)
  if (isTRUE(cfg$keywords$normalize)) out <- tolower(out)
  out[nchar(out) < cfg$keywords$min_chars] <- NA_character_
  out[tolower(out) %in% tolower(cfg$keywords$stoplist)] <- NA_character_
  out
}

# ---------------------------------------------------------------------------
# Writing site data
# ---------------------------------------------------------------------------

#' Write a JSON payload into public/data/.
#'
#' auto_unbox is on so scalars serialise as scalars rather than one-element
#' arrays; digits is capped so floating-point noise does not churn the diff on
#' every rebuild. Anything meant to stay an array must be wrapped in I().
write_site_json <- function(x, filename, cfg = dash_config(), pretty = FALSE) {
  dir <- dash_path(cfg, "site_data", create = TRUE)
  path <- file.path(dir, filename)
  jsonlite::write_json(
    x, path,
    auto_unbox = TRUE, null = "null", na = "null",
    digits = 6, pretty = pretty
  )
  message(sprintf("  wrote %-28s %8.1f KB", filename, file.size(path) / 1024))
  invisible(path)
}

#' Write an intermediate shared with the Python half.
write_derived <- function(x, filename, cfg = dash_config()) {
  dir <- dash_path(cfg, "derived", create = TRUE)
  path <- file.path(dir, filename)
  readr::write_tsv(x, path, na = "")
  message(sprintf("  wrote %-28s %8.1f KB  (%d rows)", filename, file.size(path) / 1024, nrow(x)))
  invisible(path)
}

#' Read an intermediate written by the Python half.
read_derived <- function(filename, cfg = dash_config()) {
  path <- file.path(dash_path(cfg, "derived"), filename)
  if (!file.exists(path)) {
    stop(sprintf(
      "%s not found. Run `uv run python analysis/python/10_fetch_public_metadata.py` first.",
      path
    ), call. = FALSE)
  }
  readr::read_tsv(
    path,
    col_types = readr::cols(.default = readr::col_character()),
    na = character(), progress = FALSE
  )
}

# ---------------------------------------------------------------------------
# Small summary helpers
# ---------------------------------------------------------------------------

#' Count rows by one or more columns, sorted descending, as a plain tibble.
tally_by <- function(data, ..., name = "n") {
  data |>
    dplyr::count(..., name = name) |>
    dplyr::arrange(dplyr::desc(.data[[name]]))
}

#' Five-number summary plus mean and total, blank-safe.
numeric_summary <- function(x) {
  x <- x[!is.na(x)]
  if (length(x) == 0) {
    return(list(n = 0L, total = 0, mean = NA, min = NA, q25 = NA,
                median = NA, q75 = NA, max = NA))
  }
  quartiles <- stats::quantile(x, c(0.25, 0.5, 0.75), names = FALSE)
  list(
    n = length(x), total = sum(x), mean = mean(x), min = min(x),
    q25 = quartiles[1], median = quartiles[2], q75 = quartiles[3], max = max(x)
  )
}

#' Human-readable byte size, matching the extracts' `*_size_pretty` columns.
pretty_bytes <- function(bytes) {
  if (is.na(bytes) || bytes <= 0) return("0 B")
  units <- c("B", "KB", "MB", "GB", "TB", "PB")
  power <- min(floor(log(bytes, 1024)), length(units) - 1)
  sprintf("%.1f %s", bytes / 1024^power, units[power + 1])
}
