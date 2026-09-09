# 01-datasets.R -- build the canonical dataset table.
#
# Everything downstream, in both R and Python, reads what this script writes.
# Scope is decided here and nowhere else, so the two halves of the pipeline
# cannot disagree about which datasets are in the analysis.
#
# READS
#   extracts 2.15 2.10 2.9 2.14a 2.11a 2.12 4.2d 3.2 2.8c
#   analysis/derived/public-metadata.tsv   (from 10_fetch_public_metadata.py)
#
# WRITES
#   analysis/derived/datasets.tsv          one row per discoverable dataset
#   analysis/derived/dataset-keywords.tsv  long: dataset x keyword
#   analysis/derived/dataset-authors.tsv   long: dataset x author
#   analysis/derived/dataset-geography.tsv long: dataset x declared place
#   public/data/datasets.json              the explorer payload
#   public/data/scope.json                 the scope accounting
#
# RUN IT ALONE
#   Rscript analysis/R/01-datasets.R
#   # or, in an interactive session:
#   source(here::here("analysis", "R", "01-datasets.R"))

source(here::here("analysis", "R", "setup.R"))

message("01-datasets: reading extracts")

roll   <- read_extract("2.15", CFG)   # master roll-up, one row per dataset
harv   <- read_extract("2.10", CFG)   # global_id + harvest detail
cite   <- read_extract("2.9",  CFG)   # DOI / citation parts, discoverable only
tags   <- read_extract("2.14a", CFG)  # keywords, subjects, topics (long)
mdc    <- read_extract("2.11a", CFG)  # Make Data Count views/downloads
extcit <- read_extract("2.12", CFG)   # external citation counts
geo    <- read_extract("4.2d", CFG)   # declared geographic coverage
colls  <- read_extract("3.2",  CFG)   # collection inventory
clinks <- read_extract("2.8c", CFG)   # collection-to-collection links

api <- read_derived("public-metadata.tsv", CFG)

# ---------------------------------------------------------------------------
# Scope
#
# SETUP.md: "make note of whether any of the datasets included in the results
# are drafts (i.e., unpublished) and exclude them from analysis."
#
# The test is NOT `first_published != ""`. Harvested datasets carry a NULL
# publication date and are nonetheless fully visible: 513 of 1,307 live
# datasets, 39%. dv-data/README.md calls this the most consequential gotcha in
# the pack, and it was found in eight separate places there. A dataset counts
# as live if it has been published locally OR is harvested.
# ---------------------------------------------------------------------------
roll |>
  left_join(harv |> select(dataset_id, global_id, harvesting_client_name = harvesting_client),
            by = "dataset_id") |>
  mutate(
    is_harvested   = as_pg_logical(is_harvested),
    has_draft      = as_pg_logical(has_draft),
    published_here = !is_blank(first_published),
    is_discoverable = published_here | is_harvested
  ) ->
all_datasets

scope_counts <- list(
  in_scope_total    = nrow(all_datasets),
  discoverable      = sum(all_datasets$is_discoverable),
  published_locally = sum(all_datasets$published_here),
  harvested         = sum(all_datasets$is_harvested),
  drafts_excluded   = sum(!all_datasets$is_discoverable),
  with_unreleased_draft_version = sum(all_datasets$has_draft & all_datasets$is_discoverable)
)

message(sprintf(
  "  %d datasets in CAFE scope; %d discoverable (%d published + %d harvested); %d drafts excluded",
  scope_counts$in_scope_total, scope_counts$discoverable,
  scope_counts$published_locally, scope_counts$harvested, scope_counts$drafts_excluded
))

# The extract documentation records 794 + 513 = 1,307, reconciled exactly
# against Harvard Dataverse's public Solr index. If that stops holding, the
# extract set has been refreshed and every published figure moves with it.
if (scope_counts$published_locally + scope_counts$harvested != scope_counts$discoverable) {
  stop("published + harvested != discoverable; the two categories are overlapping",
       call. = FALSE)
}

all_datasets |>
  filter(is_discoverable) |>
  mutate(gid_key = doi_key(global_id)) ->
datasets

# ---------------------------------------------------------------------------
# Subcollection
#
# The stratifier SETUP.md asks for. It is not simply `collection_alias`:
# a dataset linked into CAFE lives in a collection outside the CAFE tree, so
# its own alias says nothing about where it appears under CAFE.
#
#   owned              its own collection
#   linked             the CAFE collection it is linked into (2.15)
#   linked_collection  the CAFE collection its owning collection attaches to,
#                      resolved through 2.8c by walking its ancestry
# ---------------------------------------------------------------------------
link_targets <- setNames(clinks$linked_into_collection, clinks$linked_collection)

resolve_linked_collection <- function(path, fallback) {
  ancestors <- squish(str_split(path, ">")[[1]])
  hit <- ancestors[ancestors %in% names(link_targets)]
  if (length(hit) > 0) unname(link_targets[[hit[[1]]]]) else fallback
}

datasets |>
  mutate(
    linked_into_first = map_chr(str_split(cafe_linked_into, ","), \(x) squish(x)[[1]]),
    subcollection = case_when(
      cafe_membership == "owned" ~ collection_alias,
      cafe_membership == "linked" & nzchar(linked_into_first) ~ linked_into_first,
      cafe_membership == "linked_collection" ~ map2_chr(
        owner_collection_path, collection_alias, resolve_linked_collection
      ),
      TRUE ~ collection_alias
    )
  ) ->
datasets

# Display names and tree depth come from the collection inventory. A linked
# dataset's subcollection is always inside the CAFE tree, so this join covers
# every row; anything unmatched keeps its alias as its label.
colls |>
  transmute(
    subcollection = alias,
    subcollection_name = squish(name),
    subcollection_depth = as.integer(depth),
    subcollection_path = squish(collection_path)
  ) ->
collection_labels

datasets |>
  left_join(collection_labels, by = "subcollection") |>
  mutate(subcollection_name = coalesce(na_if(subcollection_name, ""), subcollection)) ->
datasets

unmatched <- sum(is.na(datasets$subcollection_depth))
if (unmatched > 0) {
  message(sprintf("  note: %d datasets sit in a subcollection absent from 3.2", unmatched))
}

# Two columns of 2.15 are dropped here rather than carried forward.
#
# `keywords` is a "; "-joined string, superseded by 2.14a, which has one row
# per value and so survives a keyword that contains a semicolon.
#
# `editor_identifiers` holds depositor usernames. The request sheet asked for
# contributors and the site reports how many edited each dataset, but this
# repository is public, so the names are dropped at the earliest point rather
# than relied on not to be selected later.
datasets |> select(-keywords, -editor_identifiers) -> datasets

# ---------------------------------------------------------------------------
# Long tables: keywords, authors, geography
# ---------------------------------------------------------------------------
message("01-datasets: parsing keywords, authors and geography")

# Keywords. Extract 2.14a holds one row per value, which is a better source
# than 2.15's "; "-joined string: a keyword containing a semicolon would be
# split wrongly by the latter. Subjects and topics arrive in the same extract
# under different field names.
tags |>
  filter(dataset_id %in% datasets$dataset_id) |>
  mutate(value = squish(tag)) |>
  filter(nzchar(value)) ->
tags_scoped

tags_scoped |>
  filter(field_name == "keywordValue") |>
  mutate(keyword = normalise_keyword(value, CFG)) |>
  filter(!is.na(keyword)) |>
  distinct(dataset_id, keyword, .keep_all = TRUE) |>
  select(dataset_id, keyword, keyword_raw = value) ->
dataset_keywords

tags_scoped |>
  filter(field_name == "subject") |>
  distinct(dataset_id, subject = value) ->
dataset_subjects

tags_scoped |>
  filter(field_name == "topicClassValue") |>
  distinct(dataset_id, topic = value) ->
dataset_topics

# Authors. The API returns a real list, one entry per author, which is what the
# authorship requirement needs; extract 2.9's `authors` is a single joined
# string and is only the fallback. Descriptor labels ("Federal Agency" and
# friends) are dropped by whole-string match, never as substrings.
api |>
  transmute(
    gid_key = doi_key(global_id),
    api_authors = split_list(authors, ";")
  ) ->
api_authors

cite |>
  transmute(
    gid_key = doi_key(global_id),
    fallback_authors = split_list(authors, CFG$authors$split_pattern)
  ) ->
fallback_authors

datasets |>
  select(dataset_id, gid_key) |>
  left_join(api_authors, by = "gid_key") |>
  left_join(fallback_authors, by = "gid_key") |>
  mutate(
    raw_authors = map2(api_authors, fallback_authors, \(a, b) {
      if (!is.null(a) && length(a) > 0) a else if (!is.null(b)) b else character()
    }),
    author = map(raw_authors, \(x) drop_descriptor_labels(x, CFG))
  ) |>
  select(dataset_id, author, raw_authors) ->
authors_wide

authors_wide |>
  select(dataset_id, author) |>
  unnest_longer(author) |>
  filter(!is.na(author), nzchar(author)) |>
  distinct(dataset_id, author) ->
dataset_authors

dropped_labels <- sum(lengths(authors_wide$raw_authors)) - sum(lengths(authors_wide$author))
message(sprintf(
  "  %d author mentions across %d datasets; %d descriptor labels dropped",
  nrow(dataset_authors), n_distinct(dataset_authors$dataset_id), dropped_labels
))

# Affiliations, kept separate: they exist for only the datasets whose citation
# block the API would serve, so they carry a different denominator.
api |>
  transmute(gid_key = doi_key(global_id), affiliation = split_list(author_affiliations, ";")) |>
  unnest_longer(affiliation) |>
  filter(!is.na(affiliation), nzchar(affiliation)) |>
  inner_join(datasets |> select(dataset_id, gid_key), by = "gid_key") |>
  distinct(dataset_id, affiliation) ->
dataset_affiliations

# Declared geographic coverage. This is where the *data* is about, not where
# the contributor is; the two are labelled distinctly throughout the site.
geo |>
  filter(dataset_id %in% datasets$dataset_id) |>
  transmute(
    dataset_id,
    country = squish(country), state = squish(state),
    city = squish(city), other = squish(other)
  ) |>
  filter(nzchar(country) | nzchar(state) | nzchar(city) | nzchar(other)) |>
  distinct() ->
dataset_geography

# ---------------------------------------------------------------------------
# Assemble the wide table
# ---------------------------------------------------------------------------
message("01-datasets: assembling")

api |>
  transmute(
    gid_key = doi_key(global_id),
    api_title, api_collection_name = collection_name,
    deposit_date = date_of_deposit,
    created_at, published_at,
    time_start = map_chr(str_split(time_period_start, ";"), \(x) squish(x)[[1]]),
    time_end   = map_chr(str_split(time_period_end, ";"), \(x) squish(x)[[1]]),
    has_citation_block = as_pg_logical(has_citation_block),
    description_chars = as.integer(description_chars),
    description_snippet
  ) ->
api_slim

# View, download and citation counts are taken from 2.15, the master roll-up.
# 2.11a and 2.12 are the drill-downs behind those same columns, so they are
# read here only to confirm the roll-up agrees with its sources. A mismatch
# means the extract set is internally inconsistent and every usage figure on
# the site is suspect, so it is worth one comparison rather than none.
mdc |>
  transmute(dataset_id, mdc_views = as_num(views_total), mdc_unique = as_num(views_unique)) ->
mdc_slim

extcit |> transmute(dataset_id, ext_cites = as_num(citation_count)) -> cite_slim

roll |>
  select(dataset_id, views_total, external_citation_count) |>
  mutate(views_total = as_num(views_total), roll_cites = as_num(external_citation_count)) |>
  left_join(mdc_slim, by = "dataset_id") |>
  left_join(cite_slim, by = "dataset_id") |>
  summarise(
    view_mismatch = sum(coalesce(views_total, 0) != coalesce(mdc_views, 0)),
    cite_mismatch = sum(coalesce(roll_cites, 0) != coalesce(ext_cites, 0))
  ) ->
rollup_check

if (rollup_check$view_mismatch > 0 || rollup_check$cite_mismatch > 0) {
  warning(sprintf(
    "2.15 disagrees with its drill-downs: %d datasets differ on views, %d on citations",
    rollup_check$view_mismatch, rollup_check$cite_mismatch
  ))
} else {
  message("  2.15 agrees with 2.11a and 2.12 on every dataset")
}

# Collapse the long tables back to one list-column per dataset.
summarise_list <- function(data, key, value) {
  data |>
    group_by(dataset_id) |>
    summarise("{key}" := list(sort(unique(.data[[value]]))), .groups = "drop")
}

datasets |>
  left_join(api_slim, by = "gid_key") |>
  left_join(summarise_list(dataset_keywords, "keywords", "keyword"), by = "dataset_id") |>
  left_join(summarise_list(dataset_subjects, "subjects", "subject"), by = "dataset_id") |>
  left_join(summarise_list(dataset_topics, "topics", "topic"), by = "dataset_id") |>
  left_join(summarise_list(dataset_authors, "authors", "author"), by = "dataset_id") |>
  left_join(summarise_list(dataset_affiliations, "affiliations", "affiliation"),
            by = "dataset_id") |>
  left_join(
    dataset_geography |> filter(nzchar(country)) |> summarise_list("countries", "country"),
    by = "dataset_id"
  ) |>
  mutate(
    title = squish(coalesce(na_if(squish(title), ""), api_title)),
    doi_url = pid_url,
    published_date = as.Date(as_dt(first_published)),
    published_year = as.integer(format(published_date, "%Y")),
    deposit_date_parsed = suppressWarnings(as.Date(deposit_date)),
    total_files = as_num(total_files),
    total_bytes = as_num(total_bytes),
    total_versions = as_num(total_versions),
    released_versions = as_num(released_versions),
    download_events = as_num(download_events),
    unique_downloaders = as_num(unique_downloaders),
    distinct_editors = as_num(distinct_editors),
    views_total = coalesce(as_num(views_total), 0),
    views_unique = coalesce(as_num(views_unique), 0),
    citation_count = coalesce(as_num(external_citation_count), 0),
    content_type_list = split_list(content_types, ";"),
    n_content_types = lengths(content_type_list),
    n_keywords = lengths(coalesce(keywords, list(character()))),
    n_authors = lengths(coalesce(authors, list(character()))),
    time_year_start = suppressWarnings(as.integer(str_extract(time_start, "\\d{4}"))),
    time_year_end   = suppressWarnings(as.integer(str_extract(time_end, "\\d{4}"))),
    time_span_years = if_else(
      !is.na(time_year_start) & !is.na(time_year_end) & time_year_end >= time_year_start,
      time_year_end - time_year_start + 1L, NA_integer_
    ),
    is_linked = cafe_membership != "owned"
  ) ->
wide

# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------
message("01-datasets: writing")

flatten_col <- function(x) map_chr(x, \(v) if (is.null(v)) "" else paste(v, collapse = "; "))

wide |>
  transmute(
    dataset_id, global_id, doi_url, title,
    subcollection, subcollection_name, subcollection_depth, subcollection_path,
    collection_alias, owner_collection_path,
    membership = cafe_membership, is_linked, is_harvested, harvesting_client,
    has_draft, published_here,
    published_date = as.character(published_date), published_year,
    deposit_date = as.character(deposit_date_parsed),
    latest_released_version, total_versions, released_versions,
    total_files, total_bytes,
    content_types = flatten_col(content_type_list), n_content_types,
    download_events, unique_downloaders, views_total, views_unique,
    citation_count, distinct_editors,
    keywords = flatten_col(keywords), n_keywords,
    subjects = flatten_col(subjects),
    topics = flatten_col(topics),
    authors = flatten_col(authors), n_authors,
    affiliations = flatten_col(affiliations),
    countries = flatten_col(countries),
    time_start, time_end, time_year_start, time_year_end, time_span_years,
    has_citation_block, description_chars, description_snippet
  ) ->
datasets_flat

write_derived(datasets_flat, "datasets.tsv", CFG)
write_derived(dataset_keywords, "dataset-keywords.tsv", CFG)
write_derived(dataset_authors, "dataset-authors.tsv", CFG)
write_derived(dataset_geography, "dataset-geography.tsv", CFG)
write_derived(dataset_affiliations, "dataset-affiliations.tsv", CFG)

# The explorer payload. Every list-column is written as a JSON array, including
# the empty and one-element cases: write_site_json() unboxes scalars, which
# would otherwise turn a dataset with exactly one keyword into a string and
# make the site's filter code test for three shapes instead of one. I() marks
# the vector as AsIs, which suppresses that unboxing.
as_array <- function(x) map(x, \(v) I(if (is.null(v)) character() else as.character(v)))

wide |>
  transmute(
    id = dataset_id, gid = global_id, url = doi_url, title,
    sub = subcollection, subName = subcollection_name,
    coll = collection_alias, path = owner_collection_path,
    membership = cafe_membership, harvested = is_harvested, linked = is_linked,
    hasDraft = has_draft,
    year = published_year, published = as.character(published_date),
    deposit = as.character(deposit_date_parsed),
    version = latest_released_version,
    versions = as.integer(total_versions),
    files = as.integer(total_files), bytes = total_bytes,
    views = as.integer(views_total), uviews = as.integer(views_unique),
    downloads = as.integer(coalesce(download_events, 0)),
    udownloaders = as.integer(coalesce(unique_downloaders, 0)),
    cites = as.integer(citation_count),
    editors = as.integer(coalesce(distinct_editors, 0)),
    kw = as_array(keywords), subj = as_array(subjects), topics = as_array(topics),
    auth = as_array(authors), affil = as_array(affiliations),
    countries = as_array(countries),
    types = as_array(content_type_list),
    tStart = time_year_start, tEnd = time_year_end, tSpan = time_span_years,
    snippet = description_snippet
  ) ->
explorer

if (nrow(explorer) > CFG$site$max_explorer_rows) {
  warning(sprintf(
    "explorer payload is %d rows, above the %d guard in config; consider splitting it",
    nrow(explorer), CFG$site$max_explorer_rows
  ))
}

write_site_json(explorer, "datasets.json", CFG)

write_site_json(list(
  generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  extract_date = "2026-09-08",
  scope = scope_counts,
  note = paste(
    "Drafts are excluded from every figure on this site. A dataset counts as",
    "live if it has been published locally OR is harvested: harvested datasets",
    "carry no publication date but are fully visible, and are 39% of live",
    "content."
  ),
  subcollections = n_distinct(datasets$subcollection),
  collections_in_tree = nrow(colls),
  # Denominators for the fields the API could only partly supply. The site
  # quotes these wherever it charts one of them, so a 42%-covered field is
  # never presented as if it described the whole collection.
  coverage = list(
    total = nrow(datasets_flat),
    keywords = sum(datasets_flat$n_keywords > 0),
    authors = sum(datasets_flat$n_authors > 0),
    affiliations = sum(nzchar(datasets_flat$affiliations)),
    time_period = sum(!is.na(datasets_flat$time_year_start)),
    geography = n_distinct(dataset_geography$dataset_id),
    description = sum(datasets_flat$description_chars > 0, na.rm = TRUE),
    citation_block = sum(datasets_flat$has_citation_block, na.rm = TRUE)
  )
), "scope.json", CFG, pretty = TRUE)

message("01-datasets: done")
