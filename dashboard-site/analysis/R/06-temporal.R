# 06-temporal.R -- the two different dates, kept apart.
#
# SETUP.md asks to stratify by two things that are easy to conflate:
#
#   "Date range for the data contained in the dataset"  -- temporal coverage
#   "Date the dataset was deposited to dataverse"       -- deposit date
#
# A 2024 deposit of 1950-2000 observations belongs in both, in different
# places. They are never merged here, and the site labels each panel with which
# one it is showing.
#
# Coverage is uneven and stated everywhere it matters. Temporal coverage comes
# from the citation block's timePeriodCovered, which Harvard Dataverse's API
# serves for 55% of this collection, so it is present for roughly 43% of
# datasets. Deposit dates are absent for harvested datasets, which carry no
# local publication date.
#
# READS   analysis/derived/datasets.tsv; extracts 2.11b 2.6b 2.7
# WRITES  public/data/temporal.json
#
# RUN IT ALONE
#   Rscript analysis/R/06-temporal.R

source(here::here("analysis", "R", "setup.R"))

datasets <- read_derived("datasets.tsv", CFG)
monthly <- read_extract("2.11b", CFG)
versions <- read_extract("2.6b", CFG)
dates <- read_extract("2.7", CFG)

datasets |>
  transmute(
    dataset_id, subcollection, subcollection_name, title, doi_url,
    is_harvested = as_pg_logical(is_harvested),
    published_date = suppressWarnings(as.Date(published_date)),
    deposit_date = suppressWarnings(as.Date(deposit_date)),
    published_year = as.integer(published_year),
    time_year_start = as.integer(time_year_start),
    time_year_end = as.integer(time_year_end),
    time_span_years = as.integer(time_span_years),
    views = as_num(views_total), bytes = as_num(total_bytes)
  ) ->
ds

message(sprintf("06-temporal: %d datasets", nrow(ds)))

# ---------------------------------------------------------------------------
# Deposit
#
# Two dates are available and they are not the same thing. `published_date` is
# when the version went public; `deposit_date` is the depositor-entered
# dateOfDeposit from the citation block. The first is authoritative and is what
# the site plots; the second is reported alongside for the datasets that have
# both, because a wide gap between them is itself informative.
# ---------------------------------------------------------------------------
ds |>
  filter(!is.na(published_year)) |>
  count(year = published_year, name = "datasets") |>
  arrange(year) ->
deposits_by_year

ds |>
  filter(!is.na(published_date)) |>
  mutate(month = format(published_date, "%Y-%m")) |>
  count(month, name = "datasets") |>
  arrange(month) |>
  mutate(cumulative = cumsum(datasets)) ->
deposits_by_month

ds |>
  filter(!is.na(published_year)) |>
  count(published_year, subcollection, subcollection_name, name = "datasets") |>
  arrange(published_year, desc(datasets)) ->
deposits_by_year_subcollection

ds |>
  filter(!is.na(published_date), !is.na(deposit_date)) |>
  mutate(lag_days = as.integer(published_date - deposit_date)) ->
with_both

deposit_lag <- if (nrow(with_both) > 0) {
  c(numeric_summary(with_both$lag_days),
    list(datasets = nrow(with_both),
         note = paste(
           "Days between the depositor-entered dateOfDeposit and the date the",
           "version was published. Negative values mean the depositor recorded",
           "a date after publication, which happens when metadata is edited",
           "later."
         )))
} else {
  list(datasets = 0)
}

# ---------------------------------------------------------------------------
# Temporal coverage of the data itself
# ---------------------------------------------------------------------------
ds |> filter(!is.na(time_year_start)) -> covered

coverage_note <- paste(
  "Temporal coverage is the timePeriodCovered field from the citation metadata",
  "block. Harvard Dataverse's public API returns that block for 55% of this",
  "collection -- it fails on every harvested record -- and not every dataset",
  "that has the block fills the field in. Everything in this panel is computed",
  "over the", nrow(covered), "datasets that declare a start year, out of",
  paste0(nrow(ds), ".")
)

covered |>
  count(year = time_year_start, name = "datasets") |>
  arrange(year) ->
coverage_starts

covered |>
  filter(!is.na(time_year_end)) |>
  count(year = time_year_end, name = "datasets") |>
  arrange(year) ->
coverage_ends

# How many datasets observe each calendar year. A dataset spanning 1950-2000
# contributes to every year in that range, which is what makes this the useful
# view of what the collection actually covers in time.
covered |>
  filter(!is.na(time_year_end), time_year_end >= time_year_start,
         time_year_start >= 1500, time_year_end <= 2100) |>
  transmute(dataset_id, subcollection, year = map2(time_year_start, time_year_end, seq)) |>
  unnest_longer(year) ->
year_coverage_long

year_coverage_long |>
  count(year, name = "datasets") |>
  arrange(year) ->
datasets_per_year

span_bins <- cut(
  covered$time_span_years,
  breaks = c(0, 2, 6, 11, 21, 51, 101, Inf),
  labels = c("1 year", "2-5", "6-10", "11-20", "21-50", "51-100", ">100"),
  include.lowest = TRUE, right = FALSE
)

tibble(
  bin = levels(span_bins),
  datasets = as.integer(table(factor(span_bins, levels = levels(span_bins))))
) ->
span_distribution

covered |>
  group_by(subcollection, subcollection_name) |>
  summarise(
    datasets = n(),
    earliest = min(time_year_start, na.rm = TRUE),
    latest = suppressWarnings(max(time_year_end, na.rm = TRUE)),
    median_span = median(time_span_years, na.rm = TRUE),
    .groups = "drop"
  ) |>
  mutate(latest = if_else(is.finite(latest), latest, NA_integer_)) |>
  arrange(desc(datasets)) ->
coverage_by_subcollection

# ---------------------------------------------------------------------------
# Usage over time
#
# Make Data Count reports monthly aggregates. Sum across datasets to get the
# collection's usage curve. If MDC were disabled this extract would be empty,
# and the site says so rather than drawing an empty axis.
# ---------------------------------------------------------------------------
monthly |>
  filter(dataset_id %in% ds$dataset_id) |>
  transmute(
    dataset_id, month = squish(monthyear),
    views_total = as_num(views_total), views_unique = as_num(views_unique),
    downloads_total = as_num(downloads_total), downloads_unique = as_num(downloads_unique)
  ) |>
  filter(nzchar(month)) |>
  mutate(month = substr(month, 1, 7)) |>
  group_by(month) |>
  summarise(
    datasets = n_distinct(dataset_id),
    views = sum(views_total, na.rm = TRUE),
    views_unique = sum(views_unique, na.rm = TRUE),
    downloads = sum(downloads_total, na.rm = TRUE),
    downloads_unique = sum(downloads_unique, na.rm = TRUE),
    .groups = "drop"
  ) |>
  arrange(month) ->
usage_by_month

# ---------------------------------------------------------------------------
# Versions
# ---------------------------------------------------------------------------
versions |>
  filter(dataset_id %in% ds$dataset_id) |>
  transmute(
    dataset_id,
    total_versions = as_num(total_versions),
    released_versions = as_num(released_versions),
    has_draft = as_pg_logical(has_draft),
    has_deaccessioned = as_pg_logical(has_deaccessioned)
  ) ->
vers

vers |>
  count(released_versions, name = "datasets") |>
  arrange(released_versions) ->
version_distribution

write_site_json(list(
  generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  deposit = list(
    coverage = list(
      with_publication_date = sum(!is.na(ds$published_date)),
      without = sum(is.na(ds$published_date)),
      total = nrow(ds),
      note = paste(
        "Harvested datasets carry no local publication date. They are live and",
        "counted everywhere else on this site, but they cannot appear on a",
        "deposit timeline."
      )
    ),
    by_year = deposits_by_year,
    by_month = deposits_by_month,
    by_year_subcollection = deposits_by_year_subcollection,
    lag = deposit_lag
  ),
  data_coverage = list(
    coverage = list(
      with_start_year = nrow(covered),
      with_full_range = sum(!is.na(covered$time_year_end)),
      total = nrow(ds),
      note = coverage_note
    ),
    starts = coverage_starts,
    ends = coverage_ends,
    datasets_per_year = datasets_per_year,
    span_distribution = span_distribution,
    by_subcollection = coverage_by_subcollection
  ),
  usage_by_month = usage_by_month,
  usage_note = if (nrow(usage_by_month) == 0) {
    "Make Data Count reports no monthly metrics for this collection."
  } else {
    paste(
      "Views and downloads come from Make Data Count, which reports monthly",
      "aggregates by country and agent type. Per-user view records do not",
      "exist anywhere in the Dataverse schema, so unique-view counts are",
      "available but viewer identities are not."
    )
  },
  versions = list(
    distribution = version_distribution,
    with_unreleased_draft = sum(vers$has_draft),
    with_deaccessioned = sum(vers$has_deaccessioned),
    summary = numeric_summary(vers$released_versions)
  )
), "temporal.json", CFG)

message("06-temporal: done")
