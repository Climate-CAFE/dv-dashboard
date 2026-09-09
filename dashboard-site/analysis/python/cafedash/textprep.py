"""Text preparation for the description-similarity analysis.

Dataset abstracts on Harvard Dataverse are stored as HTML and written by many
different depositors, so they arrive with markup, link boilerplate and citation
furniture mixed into the prose. What survives this module is the part that
actually describes the dataset.

Every transformation here is deliberate and reversible in the sense that it is
listed in the justification the site prints beneath the plot: a reader can see
exactly what the model was shown.
"""

from __future__ import annotations

import html
import re

# Order matters: tags come out before entities, so an entity inside an
# attribute cannot survive as text.
_TAG_RE = re.compile(r"<[^>]+>")
_URL_RE = re.compile(r"https?://\S+|www\.\S+")
_DOI_RE = re.compile(r"\b(?:doi:|10\.\d{4,9}/)\S+", re.IGNORECASE)
_REDACTION_RE = re.compile(r"\[email removed\]")
_NUMBER_RE = re.compile(r"\b\d[\d,.]*\b")
_WS_RE = re.compile(r"\s+")

# Boilerplate that appears across depositors and carries no information about
# what a dataset is about. Kept short on purpose: an aggressive domain stoplist
# would strip the vocabulary the analysis is supposed to discriminate on.
# "climate", "health", "exposure" and similar are NOT here, even though they
# are common, because their distribution across datasets is exactly the signal.
BOILERPLATE_STOPWORDS: frozenset[str] = frozenset(
    {
        "dataset",
        "datasets",
        "data",
        "dataverse",
        "file",
        "files",
        "available",
        "please",
        "contact",
        "download",
        "downloaded",
        "click",
        "link",
        "links",
        "website",
        "web",
        "page",
        "readme",
        "doi",
        "https",
        "http",
        "www",
        "org",
        "com",
        "html",
        "pdf",
        "csv",
        "zip",
        "et",
        "al",
        "cite",
        "citation",
        "cited",
        "copyright",
        "license",
        "licensed",
        "terms",
        "conditions",
        "disclaimer",
        "version",
        "updated",
        "update",
    }
)


def strip_markup(text: str) -> str:
    """Remove HTML tags and decode entities, keeping the text between them."""
    if not text:
        return ""
    # Entities are decoded twice: some records are double-escaped
    # ("&amp;lt;p&amp;gt;"), a common artefact of metadata passing through two
    # serialisation layers on its way into the database.
    decoded = html.unescape(html.unescape(text))
    return _TAG_RE.sub(" ", decoded)


def clean_description(text: str) -> str:
    """Reduce one abstract to the prose a similarity model should see.

    Drops markup, URLs, DOIs, the address redactions this pipeline inserts, and
    bare numbers. Numbers go because abstracts are full of incidental figures
    (grid resolutions, record counts, years) that would otherwise let two
    unrelated datasets match on "1000" or "2015". Years still reach the
    analysis through the temporal-coverage field, which is a better source.
    """
    text = strip_markup(text)
    text = _REDACTION_RE.sub(" ", text)
    text = _URL_RE.sub(" ", text)
    text = _DOI_RE.sub(" ", text)
    text = _NUMBER_RE.sub(" ", text)
    return _WS_RE.sub(" ", text).strip()


def build_document(title: str, description: str, keywords: list[str] | None = None) -> str:
    """Assemble the text used for one dataset.

    The title is included because it is the most curated sentence a dataset
    has, and several harvested records have abstracts that are little more than
    a restated title. Keywords are *not* included by default: keyword structure
    is a separate similarity dimension on this site, and folding it into the
    description would make the two dimensions agree by construction rather than
    on the evidence.
    """
    parts = [clean_description(title), clean_description(description)]
    if keywords:
        parts.extend(clean_description(k) for k in keywords)
    return " ".join(part for part in parts if part).strip()


def english_stopwords() -> list[str]:
    """sklearn's English list plus the boilerplate above, as a sorted list."""
    from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS

    return sorted(set(ENGLISH_STOP_WORDS) | BOILERPLATE_STOPWORDS)
