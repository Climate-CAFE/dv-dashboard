/* methods.js -- fills the provenance page from the data it describes.
 *
 * The prose on methods.html is written by hand, but every count in it is read
 * from the generated files. A methods page that quotes a stale number is worse
 * than none, so the numbers are not typed twice.
 */

import { initPage, loadJSON, fmt, buildTable, showError } from './core.js';

initPage();

/* One row per script: what it reads, what it writes, and what it decides.
 * Kept here rather than generated, because "what this script decides" is a
 * claim about intent that no file can report about itself. */
const PIPELINE = [
  {
    step: '10',
    script: 'analysis/python/10_fetch_public_metadata.py',
    language: 'Python',
    reads: 'Harvard Dataverse public Search API',
    writes: 'cache/, analysis/derived/public-metadata.tsv',
    decides: 'Re-acquires descriptions, author lists, affiliations and time coverage. '
      + 'Drops contact and email-typed fields; redacts free-text addresses.',
  },
  {
    step: '01',
    script: 'analysis/R/01-datasets.R',
    language: 'R',
    reads: 'extracts 2.15, 2.10, 2.9, 2.14a, 2.11a, 2.12, 4.2d, 3.2, 2.8c; public-metadata.tsv',
    writes: 'analysis/derived/*.tsv, public/data/datasets.json, scope.json',
    decides: 'Scope (drafts out, harvested in). Subcollection for linked datasets. '
      + 'Author and keyword parsing. Drops depositor usernames.',
  },
  {
    step: '02',
    script: 'analysis/R/02-overview.R',
    language: 'R',
    reads: 'datasets.tsv; extracts 4.1a, 3.3, 4.3',
    writes: 'public/data/overview.json',
    decides: 'The unfiltered reference figures. Separates the N/A subject placeholder.',
  },
  {
    step: '03',
    script: 'analysis/R/03-authors.R',
    language: 'R',
    reads: 'dataset-authors.tsv, dataset-affiliations.tsv, datasets.tsv',
    writes: 'public/data/authors.json',
    decides: 'Per-author aggregates, co-authorship pairs, affiliation counts.',
  },
  {
    step: '04',
    script: 'analysis/R/04-keywords.R',
    language: 'R',
    reads: 'dataset-keywords.tsv, datasets.tsv; extract 4.1b',
    writes: 'public/data/keywords.json',
    decides: 'Display spelling. Distinctive keywords by lift. Co-occurrence. '
      + 'Cross-checks counts against the extract census.',
  },
  {
    step: '05',
    script: 'analysis/R/05-collections.R',
    language: 'R',
    reads: 'extract 3.2, datasets.tsv',
    writes: 'public/data/collections.json',
    decides: 'The hierarchy and its cumulative roll-up. Refuses to write if the root '
      + 'total does not equal the scoped dataset count.',
  },
  {
    step: '06',
    script: 'analysis/R/06-temporal.R',
    language: 'R',
    reads: 'datasets.tsv; extracts 2.11b, 2.6b, 2.7',
    writes: 'public/data/temporal.json',
    decides: 'Keeps deposit date and data coverage date strictly apart.',
  },
  {
    step: '07',
    script: 'analysis/R/07-geography.R',
    language: 'R',
    reads: 'dataset-geography.tsv, dataset-affiliations.tsv; extracts 4.2a, 4.2b, 4.2e',
    writes: 'public/data/geography.json',
    decides: 'Keeps three geographies apart. Suppresses per-dataset country cells below five.',
  },
  {
    step: '08',
    script: 'analysis/R/08-files-usage.R',
    language: 'R',
    reads: 'datasets.tsv; extracts 2.1, 2.2, 2.2b, 2.4b, 2.10b, 2.12b, 2.14b, 2.5b',
    writes: 'public/data/files-usage.json',
    decides: 'Content-type families. Never combines views and downloads.',
  },
  {
    step: '11',
    script: 'analysis/python/11_keyword_similarity.py',
    language: 'Python',
    reads: 'dataset-keywords.tsv, datasets.tsv',
    writes: 'public/data/similarity-keyword.json',
    decides: 'Jaccard, TF-IDF cosine and a PPMI+SVD keyword embedding. Projections, '
      + 'clusters, neighbours, and the justification text shown on the page.',
  },
  {
    step: '12',
    script: 'analysis/python/12_description_similarity.py',
    language: 'Python',
    reads: 'cache/descriptions.tsv, datasets.tsv',
    writes: 'public/data/similarity-description.json',
    decides: 'TF-IDF cosine, LSA and an NMF topic model over cleaned description text.',
  },
];

const LIMITATIONS = [
  ['Affiliation and time coverage are partial.',
    'Both come from the citation metadata block, which the API serves for 55% of the '
    + 'collection because it fails on every harvested record. Panels using them print '
    + 'their denominator. A future run against a fresh extract that includes 1.4 would '
    + 'close this gap without the API.'],
  ['Deposit timelines cover deposited datasets only.',
    'Harvested datasets have no local publication date. They are counted everywhere '
    + 'else, but they cannot appear on a timeline.'],
  ['Sizes describe published content, not stored content.',
    'Latest released version only. Draft-only datasets occupy storage and are excluded; '
    + 'superseded versions are not counted.'],
  ['Cluster colouring is uninformative for most similarity methods.',
    'On keyword Jaccard and TF-IDF, most pairs of datasets score exactly zero, so the '
    + 'distances are nearly all equal and no clustering can find structure in them. The '
    + 'similarity page measures this and says so rather than colouring a plot that would '
    + 'imply groups that are not there. The topic model is the one method whose clusters '
    + 'are worth reading.'],
  ['Description similarity uses lexical and latent-semantic methods, not a neural embedding.',
    'A sentence-transformer would match meaning better. It would also add a gigabyte of '
    + 'dependencies and a downloaded model checkpoint that is not in this repository, '
    + 'which would end the property that any reviewer can rerun any step from a clean '
    + 'clone. The three methods here disagree in informative ways; a single opaque '
    + 'embedding gives one answer with no handle on why. A fourth method returning a '
    + 'similarity matrix drops into the same module if the team decides otherwise.'],
  ['Geographic coverage counts declarations, not extent.',
    'A global product lists every country individually, so a country bar counts datasets '
    + 'that name a place rather than how much data is about it.'],
  ['External citation counts are very low.',
    'DataCite Event Data records 21 citations across the whole collection. That reflects '
    + 'what is registered there, not what has been cited. SETUP.md anticipates this: '
    + 'usage and citation data from outside Dataverse is listed as a future addition.'],
  ['The extract is a snapshot.',
    'Taken on 2026-09-08. The collection has grown since. A collection excluded by '
    + 'requirement does not yet exist in this copy, so that exclusion is currently a '
    + 'no-op and will change the counts once the database copy is refreshed.'],
];

async function main() {
  const [scope, overview, authors] = await Promise.all([
    loadJSON('scope.json'),
    loadJSON('overview.json'),
    loadJSON('authors.json'),
  ]);

  const s = scope.scope;
  const coverage = scope.coverage;

  document.getElementById('harvested-share').textContent = fmt.pct(s.harvested / s.discoverable, 0);
  document.getElementById('dated-count').textContent = fmt.int(s.published_locally);
  document.getElementById('live-count').textContent = fmt.int(s.discoverable);
  document.getElementById('extract-date').textContent = scope.extract_date;
  document.getElementById('na-share').textContent =
    fmt.pct(overview.subject_summary.placeholder_datasets / overview.subject_summary.datasets_total, 0);

  const dropped = authors.summary.author_mentions;
  document.getElementById('dropped-labels').textContent =
    `${fmt.int(dropped)} author mentions survive across `
    + `${fmt.int(authors.summary.datasets_with_authors)} datasets, resolving to `
    + `${fmt.int(authors.summary.distinct_authors)} distinct authors.`;

  /* Scope table */
  document.getElementById('scope-table').appendChild(buildTable([
    { key: 'label', label: 'Category', wrap: true },
    { key: 'value', label: 'Datasets', align: 'right', format: fmt.int },
  ], [
    { label: 'In CAFE scope, all states', value: s.in_scope_total },
    { label: 'Published locally', value: s.published_locally },
    { label: 'Harvested from another repository', value: s.harvested },
    { label: 'Live and analysed on this site', value: s.discoverable },
    { label: 'Drafts, excluded from every figure', value: s.drafts_excluded },
    { label: 'Live, but with an unreleased draft version alongside', value: s.with_unreleased_draft_version },
    { label: 'Collections in the CAFE subtree', value: scope.collections_in_tree },
    { label: 'Subcollections holding at least one live dataset', value: scope.subcollections },
  ]));

  /* Coverage table */
  const coverageRows = [
    ['Title, subcollection, files, size, usage', coverage.total, 'SQL extract'],
    ['Description', coverage.description, 'Search API'],
    ['Authors', coverage.authors, 'Search API'],
    ['Keywords', coverage.keywords, 'SQL extract 2.14a'],
    ['Declared geographic coverage', coverage.geography, 'SQL extract 4.2d'],
    ['Citation metadata block', coverage.citation_block, 'Search API'],
    ['Author affiliation', coverage.affiliations, 'Search API, citation block'],
    ['Time period covered', coverage.time_period, 'Search API, citation block'],
  ].map(([field, n, source]) => ({ field, n, source, share: n / coverage.total }));

  document.getElementById('coverage-table').appendChild(buildTable([
    { key: 'field', label: 'Field', wrap: true },
    { key: 'source', label: 'Source', wrap: true },
    { key: 'n', label: 'Datasets', align: 'right', format: fmt.int },
    { key: 'share', label: 'Coverage', align: 'right', format: (v) => fmt.pct(v, 0) },
  ], coverageRows));

  /* Pipeline table */
  document.getElementById('pipeline-table').appendChild(buildTable([
    { key: 'step', label: '#', align: 'right' },
    { key: 'script', label: 'Script', wrap: true },
    { key: 'language', label: 'Language' },
    { key: 'reads', label: 'Reads', wrap: true },
    { key: 'writes', label: 'Writes', wrap: true },
    { key: 'decides', label: 'What it decides', wrap: true },
  ], PIPELINE));

  /* Limitations */
  document.getElementById('limitations').innerHTML = LIMITATIONS
    .map(([heading, body]) => `<h4>${heading}</h4><p>${body}</p>`)
    .join('');

  document.getElementById('footer-provenance').textContent =
    `Extract taken ${scope.extract_date}; site data generated ${scope.generated.slice(0, 10)}.`;
}

main().catch((error) => showError('#main', error));
