# 03-authors.R -- authorship summaries.
#
# SETUP.md asks for summaries stratified by authorship, "which needs to be
# parsed to show individual authors", and notes that '"Federal Agency" is not a
# unique author, but a descriptor label, and should be ignored during author
# parsing.'
#
# The parsing and the descriptor-label removal happen in 01-datasets.R, which
# writes dataset-authors.tsv. This script only aggregates. That split keeps the
# decision about what counts as an author in one place.
#
# READS   analysis/derived/dataset-authors.tsv, datasets.tsv,
#         dataset-affiliations.tsv
# WRITES  public/data/authors.json
#
# RUN IT ALONE
#   Rscript analysis/R/03-authors.R

source(here::here("analysis", "R", "setup.R"))

authors <- read_derived("dataset-authors.tsv", CFG)
affiliations <- read_derived("dataset-affiliations.tsv", CFG)
datasets <- read_derived("datasets.tsv", CFG)

datasets |>
  transmute(
    dataset_id, subcollection, subcollection_name,
    title, doi_url, published_year = as.integer(published_year),
    views = as_num(views_total), downloads = as_num(download_events),
    citations = as_num(citation_count), bytes = as_num(total_bytes),
    n_authors = as.integer(n_authors)
  ) ->
ds

authors |> inner_join(ds, by = "dataset_id") -> author_datasets

message(sprintf(
  "03-authors: %d distinct authors across %d datasets",
  n_distinct(author_datasets$author), n_distinct(author_datasets$dataset_id)
))

# ---------------------------------------------------------------------------
# Per-author aggregates
#
# An author's "reach" here is the sum over their datasets. Datasets with
# several authors are counted once for each, so these columns sum to more than
# the collection totals; that is what a per-author view means, and the site
# labels it as such rather than presenting it as a partition.
# ---------------------------------------------------------------------------
author_datasets |>
  group_by(author) |>
  summarise(
    datasets = n(),
    subcollections = n_distinct(subcollection),
    views = sum(views, na.rm = TRUE),
    downloads = sum(downloads, na.rm = TRUE),
    citations = sum(citations, na.rm = TRUE),
    bytes = sum(bytes, na.rm = TRUE),
    first_year = suppressWarnings(min(published_year, na.rm = TRUE)),
    last_year = suppressWarnings(max(published_year, na.rm = TRUE)),
    solo_datasets = sum(n_authors == 1),
    .groups = "drop"
  ) |>
  mutate(across(c(first_year, last_year), \(x) if_else(is.finite(x), x, NA_integer_))) |>
  arrange(desc(datasets), author) ->
by_author

# How many authors appear on exactly n datasets. A long tail is the usual
# shape; the site plots it to show how concentrated deposition is.
by_author |>
  count(datasets, name = "authors") |>
  arrange(datasets) ->
author_productivity

# Which subcollections each of the most prolific authors deposits into, for the
# stratified view SETUP.md asks for.
top_authors <- head(by_author$author, 40)

author_datasets |>
  filter(author %in% top_authors) |>
  count(author, subcollection, subcollection_name, name = "datasets") |>
  arrange(author, desc(datasets)) ->
top_author_subcollections

# ---------------------------------------------------------------------------
# Co-authorship
#
# One edge per pair of authors sharing a dataset. Only pairs that co-occur more
# than once are kept: single co-occurrences are the bulk of the pairs and carry
# no structure worth drawing.
# ---------------------------------------------------------------------------
author_datasets |>
  select(dataset_id, author) |>
  arrange(dataset_id, author) |>
  group_by(dataset_id) |>
  filter(n() > 1, n() <= 50) |>
  summarise(pairs = list(as_tibble(t(combn(author, 2)), .name_repair = ~ c("a", "b"))),
            .groups = "drop") |>
  tidyr::unnest(pairs) |>
  count(a, b, name = "shared_datasets") |>
  filter(shared_datasets > 1) |>
  arrange(desc(shared_datasets)) |>
  head(400) ->
coauthor_pairs

message(sprintf("  %d co-authorship pairs with more than one shared dataset",
                nrow(coauthor_pairs)))

# ---------------------------------------------------------------------------
# Affiliations
#
# The nearest available answer to SETUP.md's "location of the contributor".
# It is not a location and it is not complete: affiliations come only from the
# citation block, which Harvard Dataverse's API would serve for 55% of the
# collection, and they are free text a depositor typed. The site labels this
# panel "author affiliation (partial)" and prints the denominator.
# ---------------------------------------------------------------------------
affiliations |>
  mutate(affiliation = squish(affiliation)) |>
  filter(nzchar(affiliation)) ->
affil

affil |>
  count(affiliation, name = "datasets") |>
  arrange(desc(datasets)) ->
by_affiliation

affiliation_coverage <- list(
  datasets_with_affiliation = n_distinct(affil$dataset_id),
  datasets_total = nrow(ds),
  distinct_affiliations = n_distinct(affil$affiliation),
  note = paste(
    "Author affiliation is only present in the citation metadata block, which",
    "Harvard Dataverse's public API serves for 55% of this collection: it 500s",
    "on every harvested record. These are free-text strings as the depositor",
    "typed them, not a controlled vocabulary, and they describe an institution",
    "rather than a place."
  )
)

# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------
write_site_json(list(
  generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  summary = list(
    distinct_authors = nrow(by_author),
    datasets_with_authors = n_distinct(author_datasets$dataset_id),
    datasets_total = nrow(ds),
    author_mentions = nrow(author_datasets),
    mean_authors_per_dataset = mean(ds$n_authors, na.rm = TRUE),
    descriptor_labels = I(CFG$authors$descriptor_labels),
    note = paste(
      "Descriptor labels such as", shQuote("Federal Agency"), "are removed",
      "before counting. Matching is on the whole trimmed string and is",
      "case-insensitive, so an organisation whose name contains a label -- for",
      "example", shQuote("Industry Canada"), "-- is kept."
    )
  ),
  by_author = head(by_author, 300),
  productivity = author_productivity,
  top_author_subcollections = top_author_subcollections,
  coauthor_pairs = coauthor_pairs,
  by_affiliation = head(by_affiliation, 200),
  affiliation_coverage = affiliation_coverage
), "authors.json", CFG)

message("03-authors: done")
