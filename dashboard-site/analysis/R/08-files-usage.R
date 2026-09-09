# 08-files-usage.R -- files, storage, tags and usage.
#
# The remaining request-sheet bullets: file counts and types, sizes, storage
# drivers, tags, downloads, views and citations.
#
# One caveat runs through all of it. File counts and sizes measure the *latest
# released version only*. Draft-only datasets are excluded by SETUP.md and are
# absent here, superseded versions are not counted, and restricted files are
# counted but their bytes are still reported. It is the right number for "what
# is published", and the wrong number for sizing a migration.
#
# READS   analysis/derived/datasets.tsv; extracts 2.1 2.2 2.2b 2.4b 2.10b
#         2.12b 2.14b 2.14d 2.5b
# WRITES  public/data/files-usage.json
#
# RUN IT ALONE
#   Rscript analysis/R/08-files-usage.R

source(here::here("analysis", "R", "setup.R"))

datasets <- read_derived("datasets.tsv", CFG)
per_dataset <- read_extract("2.1", CFG)
types_by_dataset <- read_extract("2.2", CFG)
type_census <- read_extract("2.2b", CFG)
drivers <- read_extract("2.4b", CFG)
harvest_clients <- read_extract("2.10b", CFG)
related_pubs <- read_extract("2.12b", CFG)
file_tags <- read_extract("2.14b", CFG)
downloads <- read_extract("2.5b", CFG)

datasets |>
  transmute(
    dataset_id, subcollection, subcollection_name, title, doi_url,
    is_harvested = as_pg_logical(is_harvested),
    total_files = as_num(total_files), total_bytes = as_num(total_bytes),
    views = as_num(views_total), views_unique = as_num(views_unique),
    download_events = as_num(download_events),
    unique_downloaders = as_num(unique_downloaders),
    citations = as_num(citation_count),
    n_content_types = as.integer(n_content_types)
  ) ->
ds

message(sprintf("08-files-usage: %d datasets, %s across %s files",
                nrow(ds), pretty_bytes(sum(ds$total_bytes, na.rm = TRUE)),
                format(sum(ds$total_files, na.rm = TRUE), big.mark = ",")))

# ---------------------------------------------------------------------------
# Files and types
#
# 2.2b is the collection-wide census but it is computed over the full extract
# scope, drafts included. Recomputing from 2.2, restricted to the scoped
# datasets, is what the site shows; the census is carried alongside for
# comparison.
# ---------------------------------------------------------------------------
types_by_dataset |>
  filter(dataset_id %in% ds$dataset_id) |>
  transmute(
    dataset_id,
    content_type = squish(effective_content_type),
    extension = tolower(squish(file_extension)),
    files = as_num(file_count),
    bytes = as_num(bytes)
  ) |>
  filter(nzchar(content_type)) ->
types

types |>
  group_by(content_type, extension) |>
  summarise(
    files = sum(files, na.rm = TRUE),
    bytes = sum(bytes, na.rm = TRUE),
    datasets = n_distinct(dataset_id),
    .groups = "drop"
  ) |>
  arrange(desc(files)) ->
by_content_type

types |>
  filter(nzchar(extension)) |>
  group_by(extension) |>
  summarise(
    files = sum(files, na.rm = TRUE),
    bytes = sum(bytes, na.rm = TRUE),
    datasets = n_distinct(dataset_id),
    .groups = "drop"
  ) |>
  arrange(desc(files)) |>
  head(60) ->
by_extension

# A coarse grouping, because 1,549 distinct content types is not a chart.
family_of <- function(content_type, extension) {
  ct <- tolower(content_type)
  case_when(
    str_detect(ct, "^image/") ~ "Image",
    str_detect(ct, "^video/") ~ "Video",
    str_detect(ct, "^audio/") ~ "Audio",
    str_detect(ct, "pdf") ~ "PDF",
    str_detect(ct, "zip|gzip|x-tar|compress|7z|rar") ~ "Archive",
    str_detect(ct, "csv|tab-separated|excel|spreadsheet|dbf|parquet|dta|sav|rdata|rds") ~ "Tabular",
    extension %in% c("nc", "hdf", "hdf5", "h5", "grib", "grb", "nc4") ~ "Scientific array",
    extension %in% c("tif", "tiff", "shp", "geojson", "kml", "gpkg", "asc") ~ "Geospatial",
    str_detect(ct, "^text/|json|xml|markdown") ~ "Text and markup",
    str_detect(ct, "octet-stream") ~ "Unlabelled binary",
    TRUE ~ "Other"
  )
}

types |>
  mutate(family = family_of(content_type, extension)) |>
  group_by(family) |>
  summarise(
    files = sum(files, na.rm = TRUE),
    bytes = sum(bytes, na.rm = TRUE),
    datasets = n_distinct(dataset_id),
    .groups = "drop"
  ) |>
  arrange(desc(files)) ->
by_family

types |>
  mutate(family = family_of(content_type, extension)) |>
  inner_join(ds |> select(dataset_id, subcollection, subcollection_name), by = "dataset_id") |>
  group_by(subcollection, subcollection_name, family) |>
  summarise(files = sum(files, na.rm = TRUE), bytes = sum(bytes, na.rm = TRUE),
            .groups = "drop") |>
  arrange(subcollection, desc(files)) ->
family_by_subcollection

# ---------------------------------------------------------------------------
# Storage and per-dataset shape
# ---------------------------------------------------------------------------
per_dataset |>
  filter(dataset_id %in% ds$dataset_id) |>
  transmute(
    dataset_id,
    total_files = as_num(total_files), restricted_files = as_num(restricted_files),
    total_bytes = as_num(total_bytes),
    median_file_bytes = as_num(median_file_bytes),
    max_file_bytes = as_num(max_file_bytes)
  ) ->
shape

storage <- drivers |>
  transmute(
    driver = squish(file_storage_driver),
    files = as_num(files), datasets = as_num(datasets), bytes = as_num(bytes)
  ) |>
  arrange(desc(bytes))

harvest <- harvest_clients |>
  transmute(
    client = squish(harvesting_client), harvest_type = squish(harvesttype),
    url = squish(harvestingurl), target = squish(target_collection),
    datasets = as_num(datasets)
  ) |>
  arrange(desc(datasets))

# ---------------------------------------------------------------------------
# Tags and related publications
# ---------------------------------------------------------------------------
file_tags |>
  filter(dataset_id %in% ds$dataset_id) |>
  transmute(dataset_id, category = squish(file_category)) |>
  filter(nzchar(category)) |>
  count(category, name = "files", sort = TRUE) |>
  head(60) ->
file_categories

related_pubs |>
  filter(dataset_id %in% ds$dataset_id) |>
  transmute(
    dataset_id, relation = squish(relation_type),
    id_type = toupper(squish(id_type))
  ) ->
related

# ---------------------------------------------------------------------------
# Usage
#
# Downloads come from guestbook rows collapsed to dataset-level events; views
# come from Make Data Count. They are different mechanisms with different
# coverage, so they are reported side by side and never combined into one
# "usage" number.
# ---------------------------------------------------------------------------
downloads |>
  filter(dataset_id %in% ds$dataset_id) |>
  transmute(
    dataset_id,
    download_events = as_num(download_events),
    unique_downloaders = as_num(unique_downloaders),
    first_download = squish(first_download), last_download = squish(last_download)
  ) ->
dl

ds |>
  group_by(subcollection, subcollection_name) |>
  summarise(
    datasets = n(),
    views = sum(views, na.rm = TRUE),
    views_unique = sum(views_unique, na.rm = TRUE),
    downloads = sum(download_events, na.rm = TRUE),
    downloaders = sum(unique_downloaders, na.rm = TRUE),
    citations = sum(citations, na.rm = TRUE),
    views_per_dataset = sum(views, na.rm = TRUE) / n(),
    .groups = "drop"
  ) |>
  arrange(desc(views)) ->
usage_by_subcollection

ds |>
  arrange(desc(views)) |>
  head(50) |>
  select(dataset_id, title, doi_url, subcollection_name, views, views_unique,
         download_events, citations) ->
most_viewed

ds |>
  filter(citations > 0) |>
  arrange(desc(citations)) |>
  head(50) |>
  select(dataset_id, title, doi_url, subcollection_name, citations, views) ->
most_cited

write_site_json(list(
  generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  note = paste(
    "File counts and sizes measure the latest released version of each",
    "dataset. Superseded versions are not counted and draft-only datasets are",
    "excluded, so this is what is published rather than what is stored."
  ),
  summary = list(
    files = sum(ds$total_files, na.rm = TRUE),
    bytes = sum(ds$total_bytes, na.rm = TRUE),
    bytes_pretty = pretty_bytes(sum(ds$total_bytes, na.rm = TRUE)),
    datasets_with_no_files = sum(coalesce(ds$total_files, 0) == 0),
    restricted_files = sum(shape$restricted_files, na.rm = TRUE),
    distinct_content_types = n_distinct(types$content_type),
    per_dataset_files = numeric_summary(ds$total_files),
    per_dataset_bytes = numeric_summary(ds$total_bytes),
    median_file_size = numeric_summary(shape$median_file_bytes)
  ),
  by_family = by_family,
  by_content_type = head(by_content_type, 80),
  by_extension = by_extension,
  family_by_subcollection = family_by_subcollection,
  extract_census = type_census |>
    transmute(content_type = squish(effective_content_type),
              extension = squish(file_extension),
              files = as_num(file_count), datasets = as_num(dataset_count),
              bytes = as_num(total_bytes)) |>
    arrange(desc(files)) |> head(40),
  storage = storage,
  harvest_clients = harvest,
  file_categories = file_categories,
  related_publications = list(
    datasets = n_distinct(related$dataset_id),
    by_relation = related |> count(relation, name = "entries", sort = TRUE),
    by_id_type = related |> filter(nzchar(id_type)) |> count(id_type, name = "entries", sort = TRUE)
  ),
  usage = list(
    by_subcollection = usage_by_subcollection,
    most_viewed = most_viewed,
    most_cited = most_cited,
    downloads_summary = numeric_summary(dl$download_events),
    downloaders_summary = numeric_summary(dl$unique_downloaders),
    datasets_never_downloaded = sum(coalesce(dl$download_events, 0) == 0),
    datasets_never_viewed = sum(coalesce(ds$views, 0) == 0),
    note = paste(
      "Downloads are guestbook rows collapsed to dataset-level events: a zip",
      "download of N files writes N rows, deduplicated per actor per minute.",
      "Views are Make Data Count monthly aggregates. The two are different",
      "mechanisms and are never added together."
    )
  )
), "files-usage.json", CFG)

message("08-files-usage: done")
