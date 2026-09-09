/* overview.js -- the unfiltered top-level view.
 *
 * Every number here comes from public/data/overview.json, written by
 * analysis/R/02-overview.R. Nothing on this page is computed in the browser,
 * which is what makes the Explorer's unfiltered totals a check on this page
 * rather than a restatement of it.
 */

import { initPage, loadJSON, fmt, buildTable, escapeHTML, showError } from './core.js';
import { mount, horizontalBar, verticalBar, stackedBar, baseOption, axis, valueAxis } from './charts.js';

initPage();

function tile(container, label, value, sub) {
  const element = document.createElement('div');
  element.className = 'stat';
  element.innerHTML = `
    <div class="stat-label">${escapeHTML(label)}</div>
    <div class="stat-value">${escapeHTML(value)}</div>
    ${sub ? `<div class="stat-sub">${escapeHTML(sub)}</div>` : ''}`;
  container.appendChild(element);
}

async function main() {
  const [overview, scope, keywords, authors] = await Promise.all([
    loadJSON('overview.json'),
    loadJSON('scope.json'),
    loadJSON('keywords.json'),
    loadJSON('authors.json'),
  ]);

  const h = overview.headline;

  /* ---- Scope callout: the draft exclusion, stated once and prominently -- */
  document.getElementById('scope-callout').innerHTML = `
    <div class="callout">
      <strong>${fmt.int(scope.scope.discoverable)} published datasets</strong> are in scope:
      ${fmt.int(scope.scope.published_locally)} deposited to Harvard Dataverse and
      ${fmt.int(scope.scope.harvested)} harvested from other repositories.
      A further <strong>${fmt.int(scope.scope.drafts_excluded)} drafts</strong> exist in the
      collection and are excluded from every figure on this site.
      Harvested datasets carry no publication date but are fully visible to users, so
      &ldquo;has a publication date&rdquo; is not the test for whether a dataset is live &mdash;
      it would silently drop 39% of the collection.
    </div>`;

  /* ---- Stat tiles: the number is the chart ---------------------------- */
  const tiles = document.getElementById('tiles');
  tile(tiles, 'Datasets', fmt.int(h.datasets), `across ${h.subcollections} subcollections`);
  tile(tiles, 'Files', fmt.int(h.files), 'in the latest released versions');
  tile(tiles, 'Data volume', h.bytes_pretty, `median dataset ${fmt.bytes(overview.numeric.bytes.median)}`);
  tile(tiles, 'Share of Harvard Dataverse', fmt.pct(h.share_of_repository, 2),
    `of ${fmt.int(h.repository_datasets)} datasets repository-wide`);

  const tiles2 = document.getElementById('tiles-2');
  tile(tiles2, 'Distinct authors', fmt.int(h.authors), 'after removing descriptor labels');
  tile(tiles2, 'Distinct keywords', fmt.int(h.keywords), `${fmt.int(overview.numeric.keywords_per_dataset.total)} assignments`);
  tile(tiles2, 'Views', fmt.int(h.views_total), `${fmt.int(h.views_unique)} unique`);
  tile(tiles2, 'Downloads', fmt.int(h.downloads), `${fmt.int(h.unique_downloaders)} unique downloaders`);

  /* ---- Subcollections -------------------------------------------------- */
  document.getElementById('subcollection-count').textContent = String(overview.by_subcollection.length);
  const subTop = overview.by_subcollection.slice(0, 18);
  mount('#chart-subcollections',
    horizontalBar({
      categories: subTop.map((r) => r.subcollection_name || r.subcollection),
      values: subTop.map((r) => r.datasets),
    }),
    {
      columns: [
        { key: 'subcollection_name', label: 'Subcollection', wrap: true },
        { key: 'subcollection', label: 'Alias' },
        { key: 'datasets', label: 'Datasets', align: 'right', format: fmt.int },
        { key: 'harvested', label: 'Harvested', align: 'right', format: fmt.int },
        { key: 'files', label: 'Files', align: 'right', format: fmt.int },
        { key: 'bytes', label: 'Size', align: 'right', format: fmt.bytes },
        { key: 'views', label: 'Views', align: 'right', format: fmt.int },
      ],
      rows: overview.by_subcollection,
    });

  /* ---- Origin and membership: two-slice comparisons, so bars not pies -- */
  mount('#chart-origin',
    horizontalBar({
      categories: overview.by_origin.map((r) => r.harvested),
      values: overview.by_origin.map((r) => r.datasets),
    }),
    {
      columns: [
        { key: 'harvested', label: 'Origin' },
        { key: 'datasets', label: 'Datasets', align: 'right', format: fmt.int },
      ],
      rows: overview.by_origin,
    });

  mount('#chart-membership',
    horizontalBar({
      categories: overview.by_membership.map((r) => r.label),
      values: overview.by_membership.map((r) => r.datasets),
      colorIndex: 2,
    }),
    {
      columns: [
        { key: 'label', label: 'Route into CAFE', wrap: true },
        { key: 'membership', label: 'Code' },
        { key: 'datasets', label: 'Datasets', align: 'right', format: fmt.int },
      ],
      rows: overview.by_membership,
    });

  /* ---- Subjects -------------------------------------------------------- */
  const summary = overview.subject_summary;
  document.getElementById('subject-note').innerHTML = `
    Dataverse assigns the placeholder <code>${escapeHTML(summary.placeholder)}</code> to records
    arriving without a subject, which is nearly every harvested record:
    <strong>${fmt.int(summary.placeholder_datasets)}</strong> datasets, or
    ${fmt.pct(summary.placeholder_datasets / summary.datasets_total, 0)} of the collection.
    It is not a subject, so it is left out of the chart rather than drawn as the
    second-largest bar.`;

  const realSubjects = overview.by_subject.filter((r) => r.subject !== summary.placeholder);
  mount('#chart-subjects',
    horizontalBar({
      categories: realSubjects.map((r) => r.subject),
      values: realSubjects.map((r) => r.datasets),
    }),
    {
      columns: [
        { key: 'subject', label: 'Subject', wrap: true },
        { key: 'datasets', label: 'Datasets', align: 'right', format: fmt.int },
      ],
      rows: overview.by_subject,
    });

  /* ---- Years ----------------------------------------------------------- */
  document.getElementById('year-note').textContent =
    `${fmt.int(overview.year_coverage.with_publication_date)} datasets have a local publication `
    + `date. The ${fmt.int(overview.year_coverage.without)} harvested datasets do not and cannot appear here.`;

  mount('#chart-years',
    verticalBar({
      categories: overview.by_year.map((r) => String(r.year)),
      values: overview.by_year.map((r) => r.datasets),
      valueName: 'Datasets',
    }),
    {
      columns: [
        { key: 'year', label: 'Year' },
        { key: 'datasets', label: 'Datasets', align: 'right', format: fmt.int },
      ],
      rows: overview.by_year,
    });

  /* ---- Section notes -------------------------------------------------- */
  /* Written from the data rather than typed into the HTML: a hardcoded figure
   * in prose is the first thing to go stale after a refresh, and nothing would
   * catch it. */
  const files = overview.numeric.files;
  const bytes = overview.numeric.bytes;
  document.getElementById('shape-note').textContent =
    'Four distributions that a mean would hide. Dataset size and file count are both '
    + `extremely skewed: the median dataset holds ${fmt.int(files.median)} `
    + `file${files.median === 1 ? '' : 's'}, while the largest holds ${fmt.int(files.max)}, `
    + `and the largest by volume is ${fmt.bytes(bytes.max)} on its own.`;

  document.getElementById('numeric-note').textContent =
    'The five-number summary behind the histograms above. Byte totals cover only the '
    + `${fmt.int(bytes.n)} datasets with a recorded size in their latest released version; `
    + `the other ${fmt.int(h.datasets - bytes.n)} hold no files there, most of them `
    + 'harvested records that point at files held in another repository.';

  /* ---- Histograms: ordered bins, so a vertical bar per bin ------------- */
  const histograms = [
    ['#chart-hist-size', overview.histograms.size, 'Size'],
    ['#chart-hist-files', overview.histograms.files, 'Files'],
    ['#chart-hist-keywords', overview.histograms.keywords, 'Keywords'],
    ['#chart-hist-authors', overview.histograms.authors, 'Authors'],
  ];
  histograms.forEach(([selector, data, label]) => {
    mount(selector,
      verticalBar({
        categories: data.map((r) => r.bin),
        values: data.map((r) => r.datasets),
        valueName: 'Datasets',
        rotate: 40,
      }),
      {
        columns: [
          { key: 'bin', label },
          { key: 'datasets', label: 'Datasets', align: 'right', format: fmt.int },
        ],
        rows: data,
      });
  });

  /* ---- Numeric summary table ------------------------------------------ */
  const measureLabels = {
    files: 'Files per dataset',
    bytes: 'Bytes per dataset',
    views: 'Views per dataset',
    downloads: 'Download events per dataset',
    citations: 'External citations per dataset',
    keywords_per_dataset: 'Keywords per dataset',
    authors_per_dataset: 'Authors per dataset',
  };
  const numericRows = Object.entries(overview.numeric).map(([key, value]) => ({
    measure: measureLabels[key] || key,
    isBytes: key === 'bytes',
    ...value,
  }));
  const shape = (value, row) => (row.isBytes ? fmt.bytes(value) : fmt.num(value, value % 1 ? 1 : 0));
  document.getElementById('numeric-table').appendChild(buildTable([
    { key: 'measure', label: 'Measure' },
    { key: 'n', label: 'n', align: 'right', format: fmt.int },
    { key: 'min', label: 'Min', align: 'right', format: shape },
    { key: 'q25', label: '25th', align: 'right', format: shape },
    { key: 'median', label: 'Median', align: 'right', format: shape },
    { key: 'q75', label: '75th', align: 'right', format: shape },
    { key: 'max', label: 'Max', align: 'right', format: shape },
    { key: 'mean', label: 'Mean', align: 'right', format: shape },
    { key: 'total', label: 'Total', align: 'right', format: shape },
  ], numericRows));

  /* ---- Keywords and authors ------------------------------------------- */
  const topKeywords = keywords.by_keyword.slice(0, 20);
  mount('#chart-keywords',
    horizontalBar({
      categories: topKeywords.map((r) => r.display || r.keyword),
      values: topKeywords.map((r) => r.datasets),
    }),
    {
      columns: [
        { key: 'display', label: 'Keyword', wrap: true },
        { key: 'datasets', label: 'Datasets', align: 'right', format: fmt.int },
        { key: 'subcollections', label: 'Subcollections', align: 'right', format: fmt.int },
      ],
      rows: keywords.by_keyword.slice(0, 200),
    });

  const topAuthors = authors.by_author.slice(0, 20);
  mount('#chart-authors',
    horizontalBar({
      categories: topAuthors.map((r) => fmt.truncate(r.author, 46)),
      values: topAuthors.map((r) => r.datasets),
    }),
    {
      columns: [
        { key: 'author', label: 'Author', wrap: true },
        { key: 'datasets', label: 'Datasets', align: 'right', format: fmt.int },
        { key: 'subcollections', label: 'Subcollections', align: 'right', format: fmt.int },
        { key: 'views', label: 'Views', align: 'right', format: fmt.int },
      ],
      rows: authors.by_author.slice(0, 200),
    });

  document.getElementById('footer-provenance').textContent =
    `Extract taken ${scope.extract_date}; dashboard built ${scope.generated.slice(0, 10)}. `
    + `${fmt.int(scope.scope.in_scope_total)} datasets in CAFE scope, `
    + `${fmt.int(scope.scope.discoverable)} published and analysed.`;
}

main().catch((error) => showError('#main', error));
