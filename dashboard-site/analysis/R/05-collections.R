# 05-collections.R -- the CAFE collection tree, sized by holdings.
#
# SETUP.md: "a general representation of the size of each subcollection and its
# relationship to the parent CAFE collection ... derived from a dendrogram or
# similar tree diagram, and show the subcollections in a way that scales with
# their sizes proportionally."
#
# This builds the nested structure once, in R, with three size measures on
# every node, and the site draws it three ways (dendrogram, treemap, sunburst)
# from the same JSON. The recursion is here rather than in the browser so the
# roll-up arithmetic is auditable.
#
# TWO SIZES PER NODE, AND WHY BOTH
#   direct       datasets sitting in that collection itself
#   cumulative   direct plus everything in its descendants
# A dendrogram scaled on `direct` shows where content actually lives; one
# scaled on `cumulative` shows the shape of the hierarchy. Collections here are
# nested up to six deep with several empty intermediate nodes, so the two look
# very different and the site offers both.
#
# READS   extract 3.2, analysis/derived/datasets.tsv
# WRITES  public/data/collections.json
#
# RUN IT ALONE
#   Rscript analysis/R/05-collections.R

source(here::here("analysis", "R", "setup.R"))

colls <- read_extract("3.2", CFG)
datasets <- read_derived("datasets.tsv", CFG)

datasets |>
  mutate(
    total_bytes = as_num(total_bytes),
    total_files = as_num(total_files),
    views_total = as_num(views_total),
    is_harvested = as_pg_logical(is_harvested),
    is_linked = as_pg_logical(is_linked)
  ) ->
ds

# ---------------------------------------------------------------------------
# Nodes
#
# 3.2's `collection_path` is the full ancestry as "harvard > CAFE > ...".
# CAFE is the root of the tree drawn here, so the leading "harvard" is peeled
# off; every path in this extract is verified to start there.
# ---------------------------------------------------------------------------
if (!all(startsWith(colls$collection_path, "harvard > CAFE"))) {
  stop("3.2 contains a collection outside the CAFE subtree; scope has changed",
       call. = FALSE)
}

colls |>
  transmute(
    alias,
    name = squish(name),
    description = strip_html(description),
    path = squish(collection_path),
    depth = as.integer(depth),
    published_at = na_if(squish(publicationdate), ""),
    extract_direct_datasets = as_num(direct_datasets),
    extract_discoverable = as_num(discoverable_datasets),
    extract_linked_datasets = as_num(linked_datasets),
    extract_files = as_num(file_count)
  ) |>
  mutate(
    ancestry = map(path, \(p) squish(str_split(p, ">")[[1]])),
    ancestry = map(ancestry, \(a) a[a != "harvard"]),
    parent = map_chr(ancestry, \(a) if (length(a) > 1) a[[length(a) - 1]] else NA_character_)
  ) ->
nodes

# Holdings, recomputed from the scoped dataset table rather than taken from
# 3.2. 3.2's counts include drafts; SETUP.md excludes them, so the two differ
# by design and the difference is reported.
ds |>
  group_by(alias = subcollection) |>
  summarise(
    direct_datasets = n(),
    direct_harvested = sum(is_harvested),
    direct_linked = sum(is_linked),
    direct_files = sum(total_files, na.rm = TRUE),
    direct_bytes = sum(total_bytes, na.rm = TRUE),
    direct_views = sum(views_total, na.rm = TRUE),
    .groups = "drop"
  ) ->
holdings

nodes |>
  left_join(holdings, by = "alias") |>
  mutate(across(starts_with("direct_"), \(x) coalesce(x, 0))) ->
nodes

# Datasets whose subcollection is not a node in the tree would vanish from the
# diagram. There should be none; failing loudly beats a chart that quietly
# omits content.
orphans <- setdiff(unique(ds$subcollection), nodes$alias)
if (length(orphans) > 0) {
  stop(sprintf(
    "%d subcollections are absent from the collection tree: %s",
    length(orphans), paste(orphans, collapse = ", ")
  ), call. = FALSE)
}

# ---------------------------------------------------------------------------
# Cumulative roll-up
#
# Depth-first from the leaves. Every node's cumulative measure is its own plus
# the sum of its children's, so a parent is never smaller than its subtree.
# ---------------------------------------------------------------------------
children_of <- split(nodes$alias, nodes$parent)

measures <- c("datasets", "harvested", "linked", "files", "bytes", "views")

roll_up <- function(alias) {
  row <- nodes[nodes$alias == alias, ]
  totals <- setNames(
    as.numeric(row[paste0("direct_", measures)]), measures
  )
  kids <- children_of[[alias]]
  for (kid in kids %||% character()) {
    totals <- totals + roll_up(kid)
  }
  cumulative[[alias]] <<- totals
  totals
}

cumulative <- new.env(parent = emptyenv())
cumulative <- list()
roots <- nodes$alias[is.na(nodes$parent)]
for (root in roots) invisible(roll_up(root))

cumulative_frame <- bind_rows(lapply(names(cumulative), \(a) {
  as_tibble(as.list(cumulative[[a]])) |>
    rename_with(\(nm) paste0("cumulative_", nm)) |>
    mutate(alias = a, .before = 1)
}))

nodes |> left_join(cumulative_frame, by = "alias") -> nodes

if (any(nodes$cumulative_datasets < nodes$direct_datasets)) {
  stop("roll-up produced a parent smaller than its own direct holdings", call. = FALSE)
}

root_total <- nodes$cumulative_datasets[nodes$alias == "CAFE"]
if (root_total != nrow(ds)) {
  stop(sprintf(
    "tree root holds %d datasets but the scoped table has %d; the hierarchy is losing content",
    root_total, nrow(ds)
  ), call. = FALSE)
}

message(sprintf(
  "05-collections: %d collections, %d holding at least one discoverable dataset; root total %d",
  nrow(nodes), sum(nodes$direct_datasets > 0), root_total
))

# ---------------------------------------------------------------------------
# Nested structure for the site
# ---------------------------------------------------------------------------
build_node <- function(alias) {
  row <- nodes[nodes$alias == alias, ]
  kids <- sort(children_of[[alias]] %||% character())
  node <- list(
    alias = row$alias,
    name = row$name,
    depth = row$depth,
    description = substr(row$description, 1, 400),
    published = row$published_at,
    direct = list(
      datasets = row$direct_datasets, harvested = row$direct_harvested,
      linked = row$direct_linked, files = row$direct_files,
      bytes = row$direct_bytes, views = row$direct_views
    ),
    cumulative = list(
      datasets = row$cumulative_datasets, harvested = row$cumulative_harvested,
      linked = row$cumulative_linked, files = row$cumulative_files,
      bytes = row$cumulative_bytes, views = row$cumulative_views
    ),
    # 3.2's own counts, kept alongside so the difference the draft exclusion
    # makes is visible on the page rather than only in this comment.
    extract = list(
      direct_datasets = row$extract_direct_datasets,
      discoverable = row$extract_discoverable
    )
  )
  if (length(kids) > 0) node$children <- unname(lapply(kids, build_node))
  node
}

tree <- build_node("CAFE")

# Flat form as well: the treemap and the sortable table read this, and it saves
# the site walking the tree to build a list.
nodes |>
  transmute(
    alias, name, depth, parent,
    path = map_chr(ancestry, \(a) paste(a, collapse = " > ")),
    direct_datasets, direct_harvested, direct_linked,
    direct_files, direct_bytes, direct_views,
    cumulative_datasets, cumulative_harvested, cumulative_linked,
    cumulative_files, cumulative_bytes, cumulative_views,
    extract_direct_datasets, extract_discoverable,
    # Drafts held by this collection. Both terms come from extract 3.2 and
    # count only datasets the collection OWNS, so they subtract cleanly.
    # Differencing against `direct_datasets` would not: that column also
    # carries datasets linked INTO the collection, which 3.2 does not count
    # as direct, and the result goes negative for CAFE itself.
    drafts_in_collection = extract_direct_datasets - extract_discoverable
  ) |>
  arrange(desc(cumulative_datasets)) ->
flat

write_site_json(list(
  generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  root = "CAFE",
  summary = list(
    collections = nrow(nodes),
    non_empty = sum(nodes$direct_datasets > 0),
    max_depth = max(nodes$depth) - min(nodes$depth),
    datasets = root_total,
    note = paste(
      "Sizes are recomputed from the scoped dataset table, so they exclude",
      "drafts. Extract 3.2's own counts are carried on each node as",
      "`extract` for comparison; the gap is the draft content."
    )
  ),
  tree = tree,
  flat = flat
), "collections.json", CFG)

message("05-collections: done")
