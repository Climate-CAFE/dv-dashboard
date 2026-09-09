# 07-geography.R -- three different geographies, kept apart.
#
# SETUP.md asks to stratify by "location of the contributor". The extract set
# cannot answer that as written, and pretending otherwise would be the easiest
# mistake to make here. Three things are available, and they answer three
# different questions:
#
#   Where the DATA is about   4.2d/4.2e, declared geographic coverage
#   Where VIEWERS are         4.2a/4.2b, Make Data Count country aggregates
#   Who CONTRIBUTORS work for author affiliation, free text, 32% coverage
#
# The last is the closest available proxy and it is an institution, not a
# place. Each panel on the site is labelled with which of the three it shows.
# They are never summed or overlaid.
#
# Why the direct answer does not exist: linking a contributor to a location
# would need the depositor's account, and `authenticateduser` has no link to a
# collection. Extract 4.2c counts self-reported affiliations across the whole
# repository with no dataset key, so it cannot be attributed to CAFE at all.
#
# READS   analysis/derived/dataset-geography.tsv, dataset-affiliations.tsv,
#         datasets.tsv; extracts 4.2a 4.2b 4.2e
# WRITES  public/data/geography.json
#
# RUN IT ALONE
#   Rscript analysis/R/07-geography.R

source(here::here("analysis", "R", "setup.R"))

geo <- read_derived("dataset-geography.tsv", CFG)
affiliations <- read_derived("dataset-affiliations.tsv", CFG)
datasets <- read_derived("datasets.tsv", CFG)
viewer_countries <- read_extract("4.2a", CFG)
viewer_by_dataset <- read_extract("4.2b", CFG)
bboxes <- read_extract("4.2e", CFG)

datasets |>
  transmute(
    dataset_id, subcollection, subcollection_name, title, doi_url,
    views = as_num(views_total)
  ) ->
ds

message(sprintf("07-geography: %d datasets declare a place, of %d",
                n_distinct(geo$dataset_id), nrow(ds)))

# ---------------------------------------------------------------------------
# 1. Where the data is about
# ---------------------------------------------------------------------------
geo |> inner_join(ds, by = "dataset_id") -> coverage

coverage |>
  filter(nzchar(country)) |>
  distinct(dataset_id, country, subcollection) |>
  count(country, name = "datasets") |>
  arrange(desc(datasets)) ->
by_country

coverage |>
  filter(nzchar(state)) |>
  distinct(dataset_id, state) |>
  count(state, name = "datasets") |>
  arrange(desc(datasets)) ->
by_state

coverage |>
  filter(nzchar(city)) |>
  distinct(dataset_id, city) |>
  count(city, name = "datasets") |>
  arrange(desc(datasets)) |>
  head(120) ->
by_city

# How many places each dataset claims. A global product lists every country,
# so the distribution is bimodal: a handful of places, or all of them. Drawn on
# the site because it explains why the country bar chart looks the way it does.
coverage |>
  filter(nzchar(country)) |>
  distinct(dataset_id, country) |>
  count(dataset_id, name = "countries") |>
  mutate(bin = cut(
    countries, breaks = c(1, 2, 4, 11, 51, 101, Inf),
    labels = c("1", "2-3", "4-10", "11-50", "51-100", ">100"),
    include.lowest = TRUE, right = FALSE
  )) |>
  count(bin, name = "datasets") ->
countries_per_dataset

# Bounding boxes, already cast to numeric and sanity-checked by extract 4.2e.
bboxes |>
  filter(dataset_id %in% ds$dataset_id) |>
  transmute(
    dataset_id,
    west = as_num(west), east = as_num(east),
    north = as_num(north), south = as_num(south)
  ) |>
  filter(!is.na(west), !is.na(east), !is.na(north), !is.na(south)) |>
  filter(between(west, -180, 180), between(east, -180, 180),
         between(north, -90, 90), between(south, -90, 90)) |>
  inner_join(ds |> select(dataset_id, title, doi_url, subcollection), by = "dataset_id") ->
boxes

# ---------------------------------------------------------------------------
# 2. Where viewers are
#
# Make Data Count country aggregates. Small cells are a re-identification risk
# the extract pack flags and deliberately does not decide about: a single view
# from one country, combined with a niche dataset, is potentially identifying.
# This site publishes the collection-level view (4.2a), which aggregates over
# all datasets, and suppresses the per-dataset breakdown (4.2b) below a
# threshold rather than publishing it row by row.
# ---------------------------------------------------------------------------
MIN_CELL <- 5

viewer_countries |>
  transmute(
    country_code = squish(countrycode),
    views = as_num(views_total), views_unique = as_num(views_unique),
    downloads = as_num(downloads_total), downloads_unique = as_num(downloads_unique),
    datasets_touched = as_num(datasets_touched)
  ) |>
  filter(nzchar(country_code)) |>
  arrange(desc(views)) ->
viewers

viewer_by_dataset |>
  filter(dataset_id %in% ds$dataset_id) |>
  transmute(
    dataset_id, country_code = squish(countrycode),
    views_unique = as_num(views_unique), downloads_unique = as_num(downloads_unique)
  ) |>
  inner_join(ds |> select(dataset_id, subcollection, subcollection_name), by = "dataset_id") |>
  group_by(subcollection, subcollection_name, country_code) |>
  summarise(
    datasets = n_distinct(dataset_id),
    views_unique = sum(views_unique, na.rm = TRUE),
    .groups = "drop"
  ) |>
  filter(datasets >= MIN_CELL) |>
  arrange(subcollection, desc(views_unique)) ->
viewers_by_subcollection

# ---------------------------------------------------------------------------
# 3. Who contributors work for
#
# Free-text institution strings. A country is derived where one is stated
# unambiguously, and the rate at which that succeeds is published alongside so
# nobody reads the derived column as complete.
# ---------------------------------------------------------------------------
country_patterns <- c(
  "United States" = "\\b(usa|u\\.s\\.a?\\.?|united states|america)\\b",
  "United Kingdom" = "\\b(uk|u\\.k\\.|united kingdom|england|scotland|wales)\\b",
  "Canada" = "\\bcanada\\b",
  "China" = "\\bchina\\b|\\bbeijing\\b|\\bshanghai\\b",
  "India" = "\\bindia\\b",
  "Australia" = "\\baustralia\\b",
  "Germany" = "\\bgermany\\b",
  "Netherlands" = "\\bnetherlands\\b",
  "Switzerland" = "\\bswitzerland\\b",
  "Kenya" = "\\bkenya\\b",
  "Brazil" = "\\bbrazil\\b",
  "Japan" = "\\bjapan\\b"
)

infer_country <- function(text) {
  lowered <- tolower(text)
  for (country in names(country_patterns)) {
    if (str_detect(lowered, country_patterns[[country]])) return(country)
  }
  NA_character_
}

affiliations |>
  mutate(affiliation = squish(affiliation)) |>
  filter(nzchar(affiliation)) |>
  mutate(country = map_chr(affiliation, infer_country)) ->
affil

affil |>
  count(affiliation, name = "datasets") |>
  arrange(desc(datasets)) |>
  head(150) ->
by_affiliation

affil |>
  filter(!is.na(country)) |>
  distinct(dataset_id, country) |>
  count(country, name = "datasets") |>
  arrange(desc(datasets)) ->
affiliation_countries

write_site_json(list(
  generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  note = paste(
    "Three geographies appear on this page and they answer different",
    "questions: where the data is about, where viewers are, and what",
    "institutions contributors give. They are shown separately and never",
    "combined. SETUP.md asks for the location of the contributor; the",
    "database records no such field, and affiliation is the nearest proxy."
  ),
  data_coverage = list(
    coverage = list(
      datasets_with_place = n_distinct(geo$dataset_id),
      total = nrow(ds),
      note = paste(
        "Declared geographic coverage from the citation block. Global products",
        "list every country individually, so country counts describe how many",
        "datasets name a place, not how much data is about it."
      )
    ),
    by_country = by_country,
    by_state = by_state,
    by_city = by_city,
    countries_per_dataset = countries_per_dataset,
    bounding_boxes = boxes
  ),
  viewers = list(
    note = paste(
      "Make Data Count aggregates, by country of the request. No IP addresses",
      "or per-user records exist in the schema. Per-dataset country counts are",
      "suppressed below", MIN_CELL, "datasets per cell: a single view from one",
      "country on a niche dataset is potentially identifying."
    ),
    min_cell = MIN_CELL,
    by_country = viewers,
    by_subcollection = viewers_by_subcollection
  ),
  contributors = list(
    note = paste(
      "Author affiliation, as free text the depositor typed. Present for",
      n_distinct(affil$dataset_id), "of", nrow(ds), "datasets, because it comes",
      "from the citation metadata block that Harvard Dataverse's API serves for",
      "only part of this collection. A country is inferred where the string",
      "states one unambiguously."
    ),
    datasets_with_affiliation = n_distinct(affil$dataset_id),
    datasets_total = nrow(ds),
    country_inferred = sum(!is.na(affil$country)),
    country_not_inferred = sum(is.na(affil$country)),
    by_affiliation = by_affiliation,
    by_country = affiliation_countries
  )
), "geography.json", CFG)

message("07-geography: done")
