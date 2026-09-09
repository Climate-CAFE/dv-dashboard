# 04-keywords.R -- keyword summaries and co-occurrence.
#
# SETUP.md asks for stratification by "keyword, which needs to be parsed to
# reflect individual keywords". Parsing happens in 01-datasets.R, from extract
# 2.14a (one row per value) rather than from 2.15's "; "-joined string, so a
# keyword containing a semicolon survives. This script aggregates.
#
# The co-occurrence counts written here are also what the keyword-similarity
# analysis in analysis/python/ builds on, so the two views of keyword structure
# come from the same normalisation.
#
# READS   analysis/derived/dataset-keywords.tsv, datasets.tsv; extract 4.1b
# WRITES  public/data/keywords.json
#
# RUN IT ALONE
#   Rscript analysis/R/04-keywords.R

source(here::here("analysis", "R", "setup.R"))

keywords <- read_derived("dataset-keywords.tsv", CFG)
datasets <- read_derived("datasets.tsv", CFG)
census <- read_extract("4.1b", CFG)

datasets |>
  transmute(
    dataset_id, subcollection, subcollection_name, title, doi_url,
    is_harvested = as_pg_logical(is_harvested),
    views = as_num(views_total), citations = as_num(citation_count)
  ) ->
ds

#' Choose which original spelling of a keyword to display.
#'
#' Counting is case-folded, so a display form has to be picked back out. The
#' most frequent spelling is the default, except when it is SHOUTED: several
#' depositors upper-case every keyword, which would put "EARTH SCIENCE" beside
#' "sustainability" in the same chart. A longer all-caps string loses to any
#' mixed-case variant; short ones are left alone, because they are usually
#' acronyms and "nasa" is worse than "NASA".
pick_display_spelling <- function(variants) {
  counts <- sort(table(variants), decreasing = TRUE)
  best <- names(counts)[1]
  is_shout <- function(x) nchar(x) > 5 && x == toupper(x) && grepl("[A-Z]", x)
  if (!is_shout(best)) return(best)
  alternatives <- names(counts)[!vapply(names(counts), is_shout, logical(1))]
  if (length(alternatives) > 0) alternatives[1] else best
}

keywords |> inner_join(ds, by = "dataset_id") -> kw

message(sprintf("04-keywords: %d distinct keywords over %d datasets",
                n_distinct(kw$keyword), n_distinct(kw$dataset_id)))

# ---------------------------------------------------------------------------
# Frequency
# ---------------------------------------------------------------------------
kw |>
  group_by(keyword) |>
  summarise(
    datasets = n_distinct(dataset_id),
    subcollections = n_distinct(subcollection),
    views = sum(views, na.rm = TRUE),
    citations = sum(citations, na.rm = TRUE),
    harvested_datasets = sum(is_harvested),
    display = pick_display_spelling(keyword_raw),
    .groups = "drop"
  ) |>
  arrange(desc(datasets), keyword) ->
by_keyword

# Cross-check against 4.1b, the extract-side keyword census. It is computed
# over the same normalisation but without the draft exclusion, so it should be
# at least as large everywhere. A keyword that is *more* frequent here than
# there would mean the parsing disagrees.
census |>
  transmute(keyword = normalise_keyword(keyword, CFG), census_datasets = as_num(datasets)) |>
  filter(!is.na(keyword)) |>
  group_by(keyword) |>
  summarise(census_datasets = sum(census_datasets), .groups = "drop") ->
census_norm

by_keyword |>
  inner_join(census_norm, by = "keyword") |>
  filter(datasets > census_datasets) ->
over_counted

if (nrow(over_counted) > 0) {
  warning(sprintf(
    "%d keywords count higher here than in extract 4.1b; parsing may disagree (e.g. %s)",
    nrow(over_counted), paste(head(over_counted$keyword, 3), collapse = ", ")
  ))
} else {
  message("  keyword counts are consistent with extract 4.1b")
}

# How many keywords appear on exactly n datasets. Almost every collection has a
# long tail of single-use keywords, and the size of that tail is the argument
# for weighting keyword similarity rather than counting overlaps.
by_keyword |> count(datasets, name = "keywords") |> arrange(datasets) -> keyword_frequency

# ---------------------------------------------------------------------------
# Keyword by subcollection
# ---------------------------------------------------------------------------
top_keywords <- head(by_keyword$keyword, 60)

kw |>
  filter(keyword %in% top_keywords) |>
  count(keyword, subcollection, subcollection_name, name = "datasets") |>
  arrange(keyword, desc(datasets)) ->
keyword_by_subcollection

# The keywords that most distinguish a subcollection: highest lift of
# P(keyword | subcollection) over P(keyword) overall. Plain frequency inside a
# subcollection just re-reports the collection-wide top terms.
n_datasets <- n_distinct(kw$dataset_id)

kw |>
  group_by(subcollection) |>
  mutate(sub_datasets = n_distinct(dataset_id)) |>
  group_by(subcollection, subcollection_name, keyword, sub_datasets) |>
  summarise(datasets = n_distinct(dataset_id), .groups = "drop") |>
  left_join(by_keyword |> select(keyword, overall = datasets), by = "keyword") |>
  filter(sub_datasets >= 5, datasets >= 2) |>
  mutate(lift = (datasets / sub_datasets) / (overall / n_datasets)) |>
  group_by(subcollection) |>
  slice_max(lift, n = 12, with_ties = FALSE) |>
  ungroup() |>
  arrange(subcollection, desc(lift)) ->
distinctive_keywords

# ---------------------------------------------------------------------------
# Co-occurrence
#
# One edge per pair of keywords appearing on the same dataset. Restricted to
# keywords used at least three times, because pairs among single-use keywords
# are noise and there are tens of thousands of them.
# ---------------------------------------------------------------------------
frequent <- by_keyword$keyword[by_keyword$datasets >= 3]

kw |>
  filter(keyword %in% frequent) |>
  distinct(dataset_id, keyword) |>
  arrange(dataset_id, keyword) |>
  group_by(dataset_id) |>
  filter(n() > 1, n() <= 60) |>
  summarise(pairs = list(as_tibble(t(combn(keyword, 2)), .name_repair = ~ c("a", "b"))),
            .groups = "drop") |>
  tidyr::unnest(pairs) |>
  count(a, b, name = "shared_datasets") |>
  filter(shared_datasets >= 3) |>
  arrange(desc(shared_datasets)) |>
  head(600) ->
cooccurrence

message(sprintf("  %d keyword pairs sharing at least three datasets", nrow(cooccurrence)))

# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------
write_site_json(list(
  generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  summary = list(
    distinct_keywords = nrow(by_keyword),
    keyword_assignments = nrow(kw),
    datasets_with_keywords = n_distinct(kw$dataset_id),
    datasets_total = nrow(ds),
    single_use_keywords = sum(by_keyword$datasets == 1),
    median_per_dataset = median(table(kw$dataset_id)),
    normalisation = paste(
      "Whitespace collapsed, case-folded, and placeholders",
      paste0("(", paste(CFG$keywords$stoplist, collapse = ", "), ")"),
      "removed. Counting is case-insensitive; the display form is the most",
      "common original spelling, except that an all-capital spelling longer",
      "than five characters loses to any mixed-case variant, so a depositor",
      "who shouts every keyword does not set the label for everyone."
    )
  ),
  by_keyword = head(by_keyword, 400),
  frequency = keyword_frequency,
  by_subcollection = keyword_by_subcollection,
  distinctive = distinctive_keywords,
  cooccurrence = cooccurrence
), "keywords.json", CFG)

message("04-keywords: done")
