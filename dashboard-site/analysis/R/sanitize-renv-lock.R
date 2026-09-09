# sanitize-renv-lock.R -- trim renv.lock to the fields renv restores from.
#
# WHY THIS EXISTS
# ---------------
# `renv::snapshot()` on this project records each package's entire DESCRIPTION:
# Title, Description, Collate, VignetteBuilder, and -- the reason this script
# exists -- `Author`, `Authors@R` and `Maintainer`, which carry the CRAN
# maintainer's email address. That put 35 email addresses into a lockfile
# destined for a public repository.
#
# Those addresses are published by the maintainers themselves and are in every
# installed copy of every R package, so this is not a leak in any meaningful
# sense. It is still noise this repository has no reason to carry, and it trips
# the privacy scan that exists to catch the addresses that DO matter. A scan
# with a standing exception is a scan people stop reading.
#
# WHAT IT KEEPS
# -------------
# The fields renv uses to resolve and install a package:
#
#   Package Version Source Repository Hash Requirements
#   Remote* (for anything installed from GitHub or another remote)
#
# `Requirements` is derived from Depends / Imports / LinkingTo before those are
# dropped, so the dependency closure survives the trim rather than being lost
# with the rest of the DESCRIPTION.
#
# RUN IT
#   Rscript analysis/R/sanitize-renv-lock.R
#
# Run it after every `renv::snapshot()`. `just lock` does both.

lock_path <- here::here("renv.lock")
if (!file.exists(lock_path)) stop("renv.lock not found at ", lock_path, call. = FALSE)

lock <- jsonlite::fromJSON(lock_path, simplifyVector = FALSE)

KEEP <- c("Package", "Version", "Source", "Repository", "Hash", "Requirements",
          "OS_type", "RemoteType", "RemoteHost", "RemoteUsername", "RemoteRepo",
          "RemoteRef", "RemoteSha", "RemoteSubdir")

# Base packages ship with R and are never installed, so renv does not resolve
# them and they must not appear as requirements.
base_packages <- rownames(installed.packages(priority = "base"))

parse_requirements <- function(record) {
  fields <- unlist(record[c("Depends", "Imports", "LinkingTo")], use.names = FALSE)
  if (length(fields) == 0) return(character())
  parts <- unlist(strsplit(paste(fields, collapse = ","), ","), use.names = FALSE)
  names <- trimws(sub("\\s*\\(.*\\)\\s*$", "", parts))
  names <- names[nzchar(names)]
  sort(unique(setdiff(names, c("R", base_packages))))
}

before <- length(unlist(lock$Packages, use.names = FALSE))
addresses_before <- sum(grepl("@", unlist(lock$Packages, use.names = FALSE)))

lock$Packages <- lapply(lock$Packages, function(record) {
  requirements <- if (is.null(record$Requirements)) {
    parse_requirements(record)
  } else {
    unlist(record$Requirements, use.names = FALSE)
  }
  trimmed <- record[intersect(KEEP, names(record))]
  # Always present, even when empty, so the shape is uniform across records.
  trimmed$Requirements <- as.list(requirements)
  trimmed
})

jsonlite::write_json(lock, lock_path, auto_unbox = TRUE, pretty = TRUE, null = "null")

after <- length(unlist(lock$Packages, use.names = FALSE))
addresses_after <- sum(grepl("@", unlist(lock$Packages, use.names = FALSE)))

message(sprintf(
  "renv.lock sanitised: %d packages, %d values -> %d, email-bearing values %d -> %d (%.0f KB)",
  length(lock$Packages), before, after, addresses_before, addresses_after,
  file.size(lock_path) / 1024
))

if (addresses_after > 0) {
  stop("addresses survived the trim; check the KEEP list", call. = FALSE)
}
