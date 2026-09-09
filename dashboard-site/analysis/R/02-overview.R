# 02-overview.R -- headline figures and the top-level distributions.
#
# These are the numbers the Overview page prints without any filter applied.
# The Explorer page recomputes the same quantities in the browser as the user
# filters; with every filter cleared the two must agree, and tests/ checks that
# they do. That is the guarantee that the site's JavaScript only re-aggregates
# and never introduces an analysis of its own.
#
# READS   analysis/derived/datasets.tsv, extracts 4.1a 3.3 4.3
# WRITES  public/data/overview.json
#
# RUN IT ALONE
#   Rscript analysis/R/02-overview.R

source(here::here("analysis", "R", "setup.R"))

datasets <- read_derived("datasets.tsv", CFG)
subjects_census <- read_extract("4.1a", CFG)
cafe_rollup <- read_extract("3.3", CFG)
repo_census <- read_extract("4.3", CFG)

datasets |>
  mutate(
    total_files = as_num(total_files),
    total_bytes = as_num(total_bytes),
    views_total = as_num(views_total),
    views_unique = as_num(views_unique),
    download_events = as_num(download_events),
    unique_downloaders = as_num(unique_downloaders),
    citation_count = as_num(citation_count),
    published_year = as.integer(published_year),
    is_harvested = as_pg_logical(is_harvested),
    is_linked = as_pg_logical(is_linked),
    has_draft = as_pg_logical(has_draft),
    n_keywords = as.integer(n_keywords),
    n_authors = as.integer(n_authors)
  ) ->
ds

message(sprintf("02-overview: %d datasets", nrow(ds)))

# ---------------------------------------------------------------------------
# Headline
# ---------------------------------------------------------------------------
headline <- list(
  datasets = nrow(ds),
  subcollections = n_distinct(ds$subcollection),
  collections_in_tree = as.integer(cafe_rollup$collections_in_subtree[1]),
  files = sum(ds$total_files, na.rm = TRUE),
  bytes = sum(ds$total_bytes, na.rm = TRUE),
  bytes_pretty = pretty_bytes(sum(ds$total_bytes, na.rm = TRUE)),
  authors = n_distinct(read_derived("dataset-authors.tsv", CFG)$author),
  keywords = n_distinct(read_derived("dataset-keywords.tsv", CFG)$keyword),
  views_total = sum(ds$views_total, na.rm = TRUE),
  views_unique = sum(ds$views_unique, na.rm = TRUE),
  downloads = sum(ds$download_events, na.rm = TRUE),
  unique_downloaders = sum(ds$unique_downloaders, na.rm = TRUE),
  citations = sum(ds$citation_count, na.rm = TRUE),
  harvested = sum(ds$is_harvested),
  linked = sum(ds$is_linked),
  # The repository census is the denominator, never a CAFE figure. 4.3 is the
  # one deliberately unscoped query in the extract pack.
  repository_datasets = as.numeric(repo_census$datasets[1]),
  share_of_repository = nrow(ds) / as.numeric(repo_census$datasets[1])
)

# ---------------------------------------------------------------------------
# Distributions
# ---------------------------------------------------------------------------

# By subcollection. Carries the usage and size totals too, because the Explorer
# shows the same table and needs the same columns.
ds |>
  group_by(subcollection, subcollection_name) |>
  summarise(
    datasets = n(),
    harvested = sum(is_harvested),
    linked = sum(is_linked),
    files = sum(total_files, na.rm = TRUE),
    bytes = sum(total_bytes, na.rm = TRUE),
    views = sum(views_total, na.rm = TRUE),
    downloads = sum(download_events, na.rm = TRUE),
    citations = sum(citation_count, na.rm = TRUE),
    median_files = median(total_files, na.rm = TRUE),
    .groups = "drop"
  ) |>
  arrange(desc(datasets)) ->
by_subcollection

# By membership route. All three ways a dataset reaches CAFE.
ds |>
  count(membership, name = "datasets") |>
  arrange(desc(datasets)) |>
  mutate(label = recode(membership,
    owned = "Owned by a CAFE collection",
    linked = "Linked in individually",
    linked_collection = "In a collection linked into CAFE"
  )) ->
by_membership

ds |>
  count(harvested = if_else(is_harvested, "Harvested", "Deposited locally"), name = "datasets") ->
by_origin

# Subjects. 4.1a is the extract-side census; recomputing from the per-dataset
# table keeps it consistent with the draft exclusion.
#
# The placeholder matters. Dataverse assigns "N/A" to records arriving without
# a subject, typically harvested OAI metadata, and it is 39% of the
# distribution. It is reported separately, never as a subject, because a chart
# that treats it as one puts a non-category second from the top.
placeholder <- CFG$scope$subject_placeholder

datasets |>
  select(dataset_id, subjects) |>
  mutate(subject = split_list(subjects, ";")) |>
  select(dataset_id, subject) |>
  unnest_longer(subject) |>
  filter(!is.na(subject), nzchar(subject)) |>
  distinct(dataset_id, subject) ->
subject_long

subject_long |>
  count(subject, name = "datasets") |>
  arrange(desc(datasets)) ->
by_subject

subject_summary <- list(
  placeholder = placeholder,
  placeholder_datasets = sum(by_subject$datasets[by_subject$subject == placeholder]),
  datasets_with_real_subject = n_distinct(subject_long$dataset_id[subject_long$subject != placeholder]),
  datasets_total = nrow(ds),
  note = paste(
    "Dataverse assigns", shQuote(placeholder), "to records arriving without a",
    "subject, which is most harvested metadata. It is a placeholder, not a",
    "subject, and is shown separately from the real distribution."
  )
)

# Publication year. Harvested datasets have no local publication date, so the
# denominator here is smaller than the collection; the site says so.
ds |>
  filter(!is.na(published_year)) |>
  count(year = published_year, name = "datasets") |>
  arrange(year) ->
by_year

# Distribution shapes for the small-multiple histograms.
histogram <- function(x, breaks, labels) {
  binned <- cut(x, breaks = breaks, labels = labels, include.lowest = TRUE, right = FALSE)
  tibble(bin = labels, datasets = as.integer(table(factor(binned, levels = labels))))
}

size_bins <- histogram(
  ds$total_bytes,
  breaks = c(0, 1, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, Inf),
  labels = c("empty", "<1 MB", "1-10 MB", "10-100 MB", "100 MB-1 GB",
             "1-10 GB", "10-100 GB", ">100 GB")
)

file_bins <- histogram(
  ds$total_files,
  breaks = c(0, 1, 2, 6, 11, 51, 101, 501, Inf),
  labels = c("0", "1", "2-5", "6-10", "11-50", "51-100", "101-500", ">500")
)

keyword_bins <- histogram(
  ds$n_keywords,
  breaks = c(0, 1, 4, 8, 16, 33, Inf),
  labels = c("none", "1-3", "4-7", "8-15", "16-32", ">32")
)

author_bins <- histogram(
  ds$n_authors,
  breaks = c(0, 1, 2, 3, 6, 11, Inf),
  labels = c("none", "1", "2", "3-5", "6-10", ">10")
)

# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------
write_site_json(list(
  generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  headline = headline,
  numeric = list(
    files = numeric_summary(ds$total_files),
    bytes = numeric_summary(ds$total_bytes),
    views = numeric_summary(ds$views_total),
    downloads = numeric_summary(ds$download_events),
    citations = numeric_summary(ds$citation_count),
    keywords_per_dataset = numeric_summary(ds$n_keywords),
    authors_per_dataset = numeric_summary(ds$n_authors)
  ),
  by_subcollection = by_subcollection,
  by_membership = by_membership,
  by_origin = by_origin,
  by_subject = by_subject,
  subject_summary = subject_summary,
  by_year = by_year,
  year_coverage = list(
    with_publication_date = sum(!is.na(ds$published_year)),
    without = sum(is.na(ds$published_year)),
    note = paste(
      "Harvested datasets carry no local publication date, so the year",
      "histogram covers deposited datasets only."
    )
  ),
  histograms = list(
    size = size_bins, files = file_bins,
    keywords = keyword_bins, authors = author_bins
  )
), "overview.json", CFG)

message("02-overview: done")
