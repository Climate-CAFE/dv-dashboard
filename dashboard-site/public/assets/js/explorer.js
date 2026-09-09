/* explorer.js -- filter the collection, re-aggregate every summary.
 *
 * WHAT THIS FILE IS ALLOWED TO DO
 * ------------------------------
 * Filter rows, count them, sum columns, sort. That is the whole list.
 *
 * Everything that required a decision -- which datasets are in scope, what
 * counts as an author, how a keyword is normalised, which collection a linked
 * dataset belongs to -- was decided in analysis/R/01-datasets.R and is baked
 * into datasets.json. If a number here disagrees with the Overview under an
 * empty filter, this file has a bug, because the Overview is the reference.
 * tests/test_explorer_parity.py asserts they agree.
 */

import {
  initPage, loadJSON, fmt, buildTable, escapeHTML, link, showError,
  countBy, sortedEntries, median,
} from './core.js';
import { mount, horizontalBar, verticalBar } from './charts.js';

initPage();

const state = {
  q: '',
  origin: 'all',
  route: 'all',
  yearMin: null,
  yearMax: null,
  subs: new Set(),      // empty means "all"
  strat: 'sub',
  sort: 'views',
};

let ALL = [];
let SUBS = [];
let charts = {};

/* ---------------------------------------------------------------------- */
/* Filtering                                                               */
/* ---------------------------------------------------------------------- */
function matches(row) {
  if (state.origin === 'local' && row.harvested) return false;
  if (state.origin === 'harvested' && !row.harvested) return false;
  if (state.route !== 'all' && row.membership !== state.route) return false;
  if (state.subs.size && !state.subs.has(row.sub)) return false;
  if (state.yearMin !== null && (row.year === null || row.year < state.yearMin)) return false;
  if (state.yearMax !== null && (row.year === null || row.year > state.yearMax)) return false;
  if (state.q) {
    if (!row._haystack.includes(state.q)) return false;
  }
  return true;
}

function filtered() {
  return ALL.filter(matches);
}

/* ---------------------------------------------------------------------- */
/* Stratifiers -- the six SETUP.md asks for, plus origin                    */
/* ---------------------------------------------------------------------- */
const STRATIFIERS = {
  sub: {
    label: 'Subcollection',
    key: (row) => row.subName || row.sub,
    note: 'One row per subcollection. A dataset belongs to exactly one, so these rows partition the slice.',
  },
  auth: {
    label: 'Author',
    key: (row) => row.auth,
    multi: true,
    note: 'One row per parsed author. Descriptor labels such as "Federal Agency" were removed before counting; a dataset with four authors contributes to four rows.',
  },
  kw: {
    label: 'Keyword',
    key: (row) => row.kw,
    multi: true,
    note: 'One row per normalised keyword: whitespace collapsed and case-folded, placeholders dropped. A dataset contributes to one row per keyword it carries.',
  },
  tstart: {
    label: 'Data date range',
    key: (row) => (row.tStart === null || row.tStart === undefined
      ? null
      : `${Math.floor(row.tStart / 10) * 10}s`),
    note: 'The decade in which the data’s coverage starts, from the citation block’s timePeriodCovered. This is when the data is about, not when it was deposited. Only part of the collection declares it; the excluded count is shown below the table.',
  },
  year: {
    label: 'Deposit year',
    key: (row) => (row.year === null || row.year === undefined ? null : String(row.year)),
    note: 'The year the dataset was published to Harvard Dataverse. Harvested datasets carry no publication date and are excluded.',
  },
  affil: {
    label: 'Contributor affiliation',
    key: (row) => row.affil,
    multi: true,
    note: 'Author affiliation, as free text the depositor typed. It is an institution rather than a place, and it comes from the citation metadata block, which Harvard Dataverse’s API serves for only part of this collection.',
  },
  country: {
    label: 'Geographic coverage',
    key: (row) => row.countries,
    multi: true,
    note: 'Countries the dataset declares it covers. Global products list every country individually, so a row counts datasets that name a place, not how much data is about it.',
  },
  subj: {
    label: 'Subject',
    key: (row) => row.subj,
    multi: true,
    note: 'Dataverse subject facet. "N/A" is the placeholder assigned to records arriving without a subject, which is most harvested metadata.',
  },
};

function stratify(rows, definition) {
  const groups = new Map();
  let missing = 0;
  rows.forEach((row) => {
    const value = definition.key(row);
    const keys = definition.multi ? (value || []) : (value === null || value === undefined ? [] : [value]);
    if (!keys.length) { missing += 1; return; }
    keys.forEach((key) => {
      let group = groups.get(key);
      if (!group) {
        group = { key, datasets: 0, files: 0, bytes: 0, views: 0, downloads: 0, cites: 0, harvested: 0, _views: [] };
        groups.set(key, group);
      }
      group.datasets += 1;
      group.files += row.files || 0;
      group.bytes += row.bytes || 0;
      group.views += row.views || 0;
      group.downloads += row.downloads || 0;
      group.cites += row.cites || 0;
      group.harvested += row.harvested ? 1 : 0;
      group._views.push(row.views || 0);
    });
  });
  const list = [...groups.values()].map((group) => ({
    ...group,
    medianViews: median(group._views),
  }));
  list.sort((a, b) => b.datasets - a.datasets || String(a.key).localeCompare(String(b.key)));
  return { rows: list, missing };
}

/* ---------------------------------------------------------------------- */
/* Rendering                                                               */
/* ---------------------------------------------------------------------- */
function tile(container, label, value, sub) {
  const element = document.createElement('div');
  element.className = 'stat';
  element.innerHTML = `
    <div class="stat-label">${escapeHTML(label)}</div>
    <div class="stat-value">${escapeHTML(value)}</div>
    ${sub ? `<div class="stat-sub">${escapeHTML(sub)}</div>` : ''}`;
  container.appendChild(element);
}

function renderTiles(rows) {
  const container = document.getElementById('tiles');
  container.innerHTML = '';
  const files = rows.reduce((sum, r) => sum + (r.files || 0), 0);
  const bytes = rows.reduce((sum, r) => sum + (r.bytes || 0), 0);
  const views = rows.reduce((sum, r) => sum + (r.views || 0), 0);
  const downloads = rows.reduce((sum, r) => sum + (r.downloads || 0), 0);
  tile(container, 'Datasets', fmt.int(rows.length), `${fmt.int(ALL.length - rows.length)} filtered out`);
  tile(container, 'Files', fmt.int(files), `median ${fmt.int(median(rows.map((r) => r.files || 0)))} per dataset`);
  // Median size is taken over datasets that actually hold a file. Over the
  // whole slice the median is a few hundred bytes, because most datasets in
  // this collection are harvested records that point at files held elsewhere,
  // and that number describes the metadata rather than the data.
  const withFiles = rows.filter((r) => (r.bytes || 0) > 0);
  tile(container, 'Data volume', fmt.bytes(bytes),
    `median ${fmt.bytes(median(withFiles.map((r) => r.bytes)))} across ${fmt.int(withFiles.length)} with files`);
  tile(container, 'Views', fmt.int(views), `${fmt.int(downloads)} download events`);
}

function renderSummary(rows) {
  const harvested = rows.filter((r) => r.harvested).length;
  const linked = rows.filter((r) => r.linked).length;
  const subs = new Set(rows.map((r) => r.sub)).size;
  document.getElementById('summary').innerHTML = `
    <span><strong>${fmt.int(rows.length)}</strong> of ${fmt.int(ALL.length)} datasets</span>
    <span><strong>${fmt.int(subs)}</strong> subcollections</span>
    <span><strong>${fmt.int(harvested)}</strong> harvested</span>
    <span><strong>${fmt.int(linked)}</strong> linked in</span>`;
}

function renderCharts(rows) {
  const subCounts = sortedEntries(countBy(rows, (r) => r.subName || r.sub), 16);
  const kwCounts = sortedEntries(countBy(rows, (r) => r.kw), 18);
  const authCounts = sortedEntries(countBy(rows, (r) => r.auth), 18);
  const yearCounts = [...countBy(rows.filter((r) => r.year), (r) => String(r.year)).entries()]
    .sort((a, b) => a[0].localeCompare(b[0]));

  const pairs = (entries, keyLabel) => ({
    columns: [
      { key: 'name', label: keyLabel, wrap: true },
      { key: 'value', label: 'Datasets', align: 'right', format: fmt.int },
    ],
    rows: entries.map(([name, value]) => ({ name, value })),
  });

  const specs = [
    ['sub', horizontalBar({ categories: subCounts.map((e) => e[0]), values: subCounts.map((e) => e[1]) }),
      pairs(subCounts, 'Subcollection'), '#chart-sub'],
    ['year', verticalBar({ categories: yearCounts.map((e) => e[0]), values: yearCounts.map((e) => e[1]) }),
      pairs(yearCounts, 'Year'), '#chart-year'],
    ['kw', horizontalBar({ categories: kwCounts.map((e) => e[0]), values: kwCounts.map((e) => e[1]) }),
      pairs(kwCounts, 'Keyword'), '#chart-kw'],
    ['auth', horizontalBar({
      categories: authCounts.map((e) => fmt.truncate(e[0], 46)),
      values: authCounts.map((e) => e[1]),
    }), pairs(authCounts, 'Author'), '#chart-auth'],
  ];

  specs.forEach(([key, builder, table, selector]) => {
    if (charts[key]) {
      charts[key].update(builder, table);
    } else {
      charts[key] = mount(selector, builder, table);
    }
  });
}

function renderStratified(rows) {
  const definition = STRATIFIERS[state.strat];
  const { rows: groups, missing } = stratify(rows, definition);

  const note = document.getElementById('strat-note');
  note.textContent = missing
    ? `${definition.note} ${fmt.int(missing)} of ${fmt.int(rows.length)} datasets in this slice have no value for this stratifier and are not counted in any row.`
    : definition.note;

  const container = document.getElementById('strat-table');
  container.innerHTML = '';
  container.appendChild(buildTable([
    { key: 'key', label: definition.label, wrap: true },
    { key: 'datasets', label: 'Datasets', align: 'right', format: fmt.int },
    { key: 'harvested', label: 'Harvested', align: 'right', format: fmt.int },
    { key: 'files', label: 'Files', align: 'right', format: fmt.int },
    { key: 'bytes', label: 'Size', align: 'right', format: fmt.bytes },
    { key: 'views', label: 'Views', align: 'right', format: fmt.int },
    { key: 'medianViews', label: 'Median views', align: 'right', format: (v) => fmt.int(v) },
    { key: 'downloads', label: 'Downloads', align: 'right', format: fmt.int },
    { key: 'cites', label: 'Citations', align: 'right', format: fmt.int },
  ], groups.slice(0, 400)));

  if (groups.length > 400) {
    const more = document.createElement('p');
    more.className = 'coverage-note';
    more.textContent = `Showing the 400 largest of ${fmt.int(groups.length)} groups.`;
    container.appendChild(more);
  }
}

const SORTS = {
  views: (a, b) => (b.views || 0) - (a.views || 0),
  downloads: (a, b) => (b.downloads || 0) - (a.downloads || 0),
  bytes: (a, b) => (b.bytes || 0) - (a.bytes || 0),
  files: (a, b) => (b.files || 0) - (a.files || 0),
  year: (a, b) => (b.year || 0) - (a.year || 0),
  title: (a, b) => a.title.localeCompare(b.title),
};

function renderDatasetTable(rows) {
  const sorted = [...rows].sort(SORTS[state.sort]);
  const shown = sorted.slice(0, 300);
  document.getElementById('table-note').textContent =
    `${fmt.int(rows.length)} datasets match. Showing the first ${fmt.int(shown.length)}; `
    + 'each title links to the dataset on Harvard Dataverse.';

  const container = document.getElementById('dataset-table');
  container.innerHTML = '';
  container.appendChild(buildTable([
    { key: 'title', label: 'Dataset', wrap: true, format: (value, row) => link(row.url, value) },
    { key: 'subName', label: 'Subcollection', wrap: true },
    {
      key: (row) => (row.harvested ? 'Harvested' : 'Deposited'),
      label: 'Origin',
    },
    { key: 'year', label: 'Published', align: 'right' },
    {
      key: (row) => (row.tStart ? `${row.tStart}–${row.tEnd ?? ''}` : null),
      label: 'Data range',
    },
    { key: 'files', label: 'Files', align: 'right', format: fmt.int },
    { key: 'bytes', label: 'Size', align: 'right', format: fmt.bytes },
    { key: 'views', label: 'Views', align: 'right', format: fmt.int },
    { key: 'downloads', label: 'Downloads', align: 'right', format: fmt.int },
    { key: (row) => row.kw.length, label: 'Keywords', align: 'right', format: fmt.int },
  ], shown));
}

function renderAll() {
  const rows = filtered();
  renderSummary(rows);
  renderTiles(rows);
  renderCharts(rows);
  renderStratified(rows);
  renderDatasetTable(rows);
  updateSubState();
}

function updateSubState() {
  const pill = document.getElementById('sub-state');
  pill.textContent = state.subs.size === 0 ? 'all' : `${state.subs.size} of ${SUBS.length}`;
}

/* ---------------------------------------------------------------------- */
/* Controls                                                                */
/* ---------------------------------------------------------------------- */
function bindToggleGroup(containerId, attribute, field) {
  const container = document.getElementById(containerId);
  container.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-' + attribute + ']');
    if (!button) return;
    state[field] = button.dataset[attribute];
    container.querySelectorAll('button').forEach((other) => {
      other.setAttribute('aria-pressed', String(other === button));
    });
    renderAll();
  });
}

function buildSubChecklist() {
  const counts = countBy(ALL, (r) => r.sub);
  SUBS = [...new Set(ALL.map((r) => r.sub))]
    .map((alias) => ({
      alias,
      name: (ALL.find((r) => r.sub === alias) || {}).subName || alias,
      count: counts.get(alias) || 0,
    }))
    .sort((a, b) => b.count - a.count);

  const list = document.getElementById('sub-checklist');
  list.innerHTML = '';
  SUBS.forEach((sub) => {
    const label = document.createElement('label');
    label.innerHTML = `
      <input type="checkbox" value="${escapeHTML(sub.alias)}">
      <span>${escapeHTML(sub.name)}</span>
      <span class="count">${fmt.int(sub.count)}</span>`;
    list.appendChild(label);
  });

  list.addEventListener('change', () => {
    state.subs = new Set(
      [...list.querySelectorAll('input:checked')].map((input) => input.value),
    );
    renderAll();
  });

  const setAll = (checked) => {
    list.querySelectorAll('input').forEach((input) => { input.checked = checked; });
    state.subs = checked ? new Set(SUBS.map((s) => s.alias)) : new Set();
    renderAll();
  };
  document.getElementById('sub-all').addEventListener('click', () => setAll(true));
  document.getElementById('sub-none').addEventListener('click', () => setAll(false));
  document.getElementById('sub-invert').addEventListener('click', () => {
    list.querySelectorAll('input').forEach((input) => { input.checked = !input.checked; });
    state.subs = new Set([...list.querySelectorAll('input:checked')].map((i) => i.value));
    renderAll();
  });
}

function buildYearSelects() {
  const years = [...new Set(ALL.map((r) => r.year).filter(Boolean))].sort((a, b) => a - b);
  const min = document.getElementById('year-min');
  const max = document.getElementById('year-max');
  years.forEach((year) => {
    min.insertAdjacentHTML('beforeend', `<option value="${year}">${year}</option>`);
    max.insertAdjacentHTML('beforeend', `<option value="${year}">${year}</option>`);
  });
  min.addEventListener('change', () => {
    state.yearMin = min.value ? Number(min.value) : null;
    renderAll();
  });
  max.addEventListener('change', () => {
    state.yearMax = max.value ? Number(max.value) : null;
    renderAll();
  });
}

function buildStratToggles() {
  const container = document.getElementById('strat-toggles');
  Object.entries(STRATIFIERS).forEach(([key, definition]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = definition.label;
    button.setAttribute('aria-pressed', String(key === state.strat));
    button.addEventListener('click', () => {
      state.strat = key;
      container.querySelectorAll('button').forEach((other) => {
        other.setAttribute('aria-pressed', String(other === button));
      });
      renderStratified(filtered());
    });
    container.appendChild(button);
  });
}

/* ---------------------------------------------------------------------- */
async function main() {
  const [datasets, scope] = await Promise.all([
    loadJSON('datasets.json'),
    loadJSON('scope.json'),
  ]);

  ALL = datasets.map((row) => ({
    ...row,
    _haystack: [row.title, ...(row.kw || []), ...(row.auth || []), row.sub, row.subName]
      .join(' ')
      .toLowerCase(),
  }));

  buildSubChecklist();
  buildYearSelects();
  buildStratToggles();
  bindToggleGroup('origin-toggles', 'origin', 'origin');
  bindToggleGroup('route-toggles', 'route', 'route');

  let searchTimer = null;
  document.getElementById('q').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = event.target.value.trim().toLowerCase();
      renderAll();
    }, 160);
  });

  document.getElementById('sort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    renderDatasetTable(filtered());
  });

  document.getElementById('reset').addEventListener('click', () => {
    state.q = '';
    state.origin = 'all';
    state.route = 'all';
    state.yearMin = null;
    state.yearMax = null;
    state.subs = new Set();
    document.getElementById('q').value = '';
    document.getElementById('year-min').value = '';
    document.getElementById('year-max').value = '';
    document.querySelectorAll('#sub-checklist input').forEach((i) => { i.checked = false; });
    document.querySelectorAll('#origin-toggles button, #route-toggles button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.origin === 'all' || b.dataset.route === 'all'));
    });
    renderAll();
  });

  document.getElementById('filters').addEventListener('submit', (e) => e.preventDefault());

  renderAll();

  document.getElementById('footer-provenance').textContent =
    `Extract taken ${scope.extract_date}; ${fmt.int(scope.scope.discoverable)} published datasets, `
    + `${fmt.int(scope.scope.drafts_excluded)} drafts excluded.`;
}

main().catch((error) => showError('#main', error));
