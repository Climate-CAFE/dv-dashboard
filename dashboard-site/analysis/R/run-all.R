# run-all.R -- run the R half of the pipeline in order.
#
# 01 must run first: it decides scope and writes the tables every other script
# reads. 02 through 08 are independent of each other and can be run singly.
#
#   Rscript analysis/R/run-all.R
#
# Each script is also runnable on its own, which is the point of the split:
#
#   Rscript analysis/R/04-keywords.R
#
# Every script is sourced in a fresh environment so a stray object left behind
# by one cannot silently satisfy a missing definition in the next.

source(here::here("analysis", "R", "setup.R"))

scripts <- c(
  "01-datasets.R",
  "02-overview.R",
  "03-authors.R",
  "04-keywords.R",
  "05-collections.R",
  "06-temporal.R",
  "07-geography.R",
  "08-files-usage.R"
)

started <- Sys.time()

for (script in scripts) {
  path <- here::here("analysis", "R", script)
  message("\n=== ", script, " ", strrep("=", max(0, 60 - nchar(script))))
  step_started <- Sys.time()
  sys.source(path, envir = new.env(parent = globalenv()))
  message(sprintf("    %.1fs", as.numeric(difftime(Sys.time(), step_started, units = "secs"))))
}

message(sprintf(
  "\nR pipeline complete in %.1fs. Site data in %s",
  as.numeric(difftime(Sys.time(), started, units = "secs")),
  dash_path(CFG, "site_data")
))
