# setup.R -- sourced at the top of every numbered script in analysis/R/.
#
# Running any single script starts here, so a reviewer can open one script,
# source it, and land in a session with the packages loaded, the configuration
# read, and the paths resolved. Nothing below depends on the working directory.

source(here::here("analysis", "R", "functions.R"))

load_pkgs("dplyr", "tidyr", "stringr", "purrr", "tibble", "readr", "lubridate", "jsonlite")

CFG <- dash_config()

EXTRACTS_DIR <- dash_path(CFG, "extracts")
DERIVED_DIR  <- dash_path(CFG, "derived", create = TRUE)
SITE_DATA    <- dash_path(CFG, "site_data", create = TRUE)

if (!dir.exists(EXTRACTS_DIR)) {
  stop(sprintf(
    paste0(
      "Extract directory not found: %s\n",
      "The dashboard reads dv-data/, which is gitignored. Obtain the extract set\n",
      "and place it there, or point `paths.extracts` in config/dashboard-config.yml\n",
      "at wherever it lives."
    ),
    EXTRACTS_DIR
  ), call. = FALSE)
}
