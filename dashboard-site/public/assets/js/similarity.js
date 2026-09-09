/* similarity.js -- the clickable similarity map.
 *
 * The analysis is entirely upstream. analysis/python/11_keyword_similarity.py
 * and 12_description_similarity.py compute the similarity matrices, the
 * projections, the clusters and the neighbour lists, and write the
 * justification text alongside them. This file draws the result and lets the
 * reader pick which one to look at.
 *
 * COLOUR, AND WHY SO LITTLE OF IT
 * -------------------------------
 * The obvious thing to do with a scatter of 1,300 points and ten clusters is
 * to give each cluster a hue. That is wrong twice over.
 *
 * It fails the palette gates: on a scatter every pair of series can end up
 * adjacent, and under that all-pairs test only the first three slots of this
 * palette clear the colour-blind and normal-vision separation floors. Ten hues
 * would be indistinguishable to a substantial fraction of readers, and past
 * about seven classes adjacent ones blur for everybody.
 *
 * It also does not answer any question a reader has. "Which cluster is this
 * point in" is answered by clicking it. "Where do the nsaph datasets sit" is
 * answered far better by lighting up nsaph and greying everything else.
 *
 * So: one colour by default, and selecting groups highlights at most three at
 * a time against a muted field. Identity is never carried by colour alone --
 * the legend is labelled, the tooltip names the group, and the detail panel
 * spells it out.
 */

import {
  initPage, loadJSON, fmt, buildTable, escapeHTML, renderProse, showError, link,
} from './core.js';
import { mount, baseOption, palette } from './charts.js';

initPage();

const MAX_HIGHLIGHTS = 3;

const state = {
  dimension: 'keyword',
  method: null,
  projection: 'tsne',
  colour: 'none',
  highlights: [],   // group keys currently painted, in slot order
  selected: null,   // index into the current bundle's ids
};

let DATASETS = new Map();
let bundles = {};
let scatter = null;

const bundleFile = (dimension) => `similarity-${dimension}.json`;

function currentBundle() { return bundles[state.dimension]; }
function currentMethod() { return currentBundle().methods[state.method]; }

/* ---------------------------------------------------------------------- */
/* Grouping                                                                */
/* ---------------------------------------------------------------------- */
const GROUPINGS = {
  none: null,
  cluster: {
    label: 'Cluster',
    of: (index) => `Cluster ${currentMethod().clusters[index] + 1}`,
  },
  sub: {
    label: 'Subcollection',
    of: (index) => {
      const row = DATASETS.get(currentBundle().ids[index]);
      return row ? (row.subName || row.sub) : 'Unknown';
    },
  },
  origin: {
    label: 'Origin',
    of: (index) => {
      const row = DATASETS.get(currentBundle().ids[index]);
      return row && row.harvested ? 'Harvested' : 'Deposited locally';
    },
  },
};

function groupCounts() {
  const grouping = GROUPINGS[state.colour];
  if (!grouping) return [];
  const counts = new Map();
  currentBundle().ids.forEach((_, index) => {
    const key = grouping.of(index);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/* ---------------------------------------------------------------------- */
/* Scatter                                                                 */
/* ---------------------------------------------------------------------- */
function buildScatter() {
  const bundle = currentBundle();
  const method = currentMethod();
  const coords = method.coords[state.projection];
  const grouping = GROUPINGS[state.colour];

  const point = (index) => {
    const row = DATASETS.get(bundle.ids[index]) || {};
    return {
      value: coords[index],
      index,
      name: row.title || bundle.ids[index],
      sub: row.subName || row.sub || '',
      group: grouping ? grouping.of(index) : null,
    };
  };

  const highlighted = new Set(state.highlights);
  const buckets = new Map(state.highlights.map((key) => [key, []]));
  const rest = [];

  coords.forEach((_, index) => {
    const item = point(index);
    if (grouping && highlighted.has(item.group)) buckets.get(item.group).push(item);
    else rest.push(item);
  });

  return (colors) => {
    const series = [];

    if (rest.length) {
      series.push({
        name: state.highlights.length ? 'Everything else' : 'Datasets',
        type: 'scatter',
        data: rest,
        symbolSize: 7,
        large: true,
        largeThreshold: 400,
        itemStyle: {
          color: state.highlights.length ? colors.mutedMark : colors.series[0],
          opacity: state.highlights.length ? 0.35 : 0.6,
        },
        emphasis: { itemStyle: { opacity: 1 } },
        z: 1,
      });
    }

    state.highlights.forEach((key, slot) => {
      series.push({
        name: key,
        type: 'scatter',
        data: buckets.get(key) || [],
        symbolSize: 9,
        itemStyle: {
          color: colors.series[slot],
          // A 2px surface ring keeps overlapping markers readable.
          borderColor: colors.surface,
          borderWidth: 2,
          opacity: 0.95,
        },
        z: 3,
      });
    });

    if (state.selected !== null && coords[state.selected]) {
      const row = DATASETS.get(bundle.ids[state.selected]) || {};
      series.push({
        name: 'Selected',
        type: 'effectScatter',
        data: [{ value: coords[state.selected], index: state.selected, name: row.title || '' }],
        symbolSize: 15,
        rippleEffect: { scale: 2.4, brushType: 'stroke' },
        itemStyle: { color: colors.status.critical, borderColor: colors.surface, borderWidth: 2 },
        z: 6,
      });

      // Draw the nearest neighbours as spokes, so "similar to this" is visible
      // on the plot and not only in the side panel.
      const neighbours = method.neighbours[state.selected] || [];
      series.push({
        name: 'Nearest neighbours',
        type: 'lines',
        coordinateSystem: 'cartesian2d',
        data: neighbours.slice(0, 8).map((n) => ({
          coords: [coords[state.selected], coords[n.i]],
        })),
        lineStyle: { color: colors.status.critical, width: 1, opacity: 0.5, curveness: 0.15 },
        z: 5,
        silent: true,
      });
    }

    return {
      ...baseOption(colors),
      grid: { left: 12, right: 12, top: 12, bottom: 12, containLabel: false },
      legend: { show: false },
      tooltip: {
        ...baseOption(colors).tooltip,
        trigger: 'item',
        formatter: (params) => {
          const d = params.data;
          if (d.index === undefined) return '';
          const parts = [`<strong>${escapeHTML(fmt.truncate(d.name, 64))}</strong>`];
          if (d.sub) parts.push(`<span style="color:${colors.muted}">${escapeHTML(d.sub)}</span>`);
          if (d.group) parts.push(escapeHTML(d.group));
          parts.push(`<span style="color:${colors.muted}">Click to pin</span>`);
          return parts.join('<br>');
        },
      },
      // The axes of a t-SNE or MDS layout carry no units, so they are hidden
      // rather than labelled with numbers a reader might try to interpret.
      xAxis: { show: false, type: 'value', scale: true },
      yAxis: { show: false, type: 'value', scale: true },
      series,
    };
  };
}

/* ---------------------------------------------------------------------- */
/* Detail panel                                                            */
/* ---------------------------------------------------------------------- */
function renderDetail() {
  const container = document.getElementById('detail');
  const bundle = currentBundle();
  const method = currentMethod();

  if (state.selected === null) {
    container.innerHTML = '<p class="detail-empty">Click a point, or search above, to see '
      + 'the dataset and its nearest neighbours under the selected method.</p>';
    return;
  }

  const id = bundle.ids[state.selected];
  const row = DATASETS.get(id) || {};
  const neighbours = (method.neighbours[state.selected] || []).slice(0, 8);

  container.innerHTML = '';

  const heading = document.createElement('h3');
  heading.appendChild(link(row.url || '#', row.title || id));
  container.appendChild(heading);

  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = [
    row.subName || row.sub,
    row.harvested ? 'harvested' : 'deposited locally',
    row.year ? `published ${row.year}` : null,
    `cluster ${method.clusters[state.selected] + 1}`,
  ].filter(Boolean).join(' · ');
  container.appendChild(meta);

  if (row.snippet) {
    const snippet = document.createElement('p');
    snippet.style.cssText = 'font-size:0.82rem;color:var(--text-secondary)';
    snippet.textContent = fmt.truncate(row.snippet, 260);
    container.appendChild(snippet);
  }

  // What put this dataset where it is, under this method.
  const evidence = state.dimension === 'keyword'
    ? (bundle.datasetKeywords || [])[state.selected]
    : (method.datasetTerms || [])[state.selected];
  if (evidence && evidence.length) {
    const label = document.createElement('p');
    label.className = 'meta';
    label.style.marginTop = '10px';
    label.textContent = state.dimension === 'keyword'
      ? 'Its most distinctive keywords'
      : 'Terms this method weighted most';
    container.appendChild(label);

    const tags = document.createElement('div');
    tags.className = 'tag-row';
    evidence.slice(0, 8).forEach((value) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = value;
      tags.appendChild(tag);
    });
    container.appendChild(tags);
  }

  const neighbourLabel = document.createElement('p');
  neighbourLabel.className = 'meta';
  neighbourLabel.style.marginTop = '12px';
  neighbourLabel.textContent = `Nearest under ${method.label.toLowerCase()}`;
  container.appendChild(neighbourLabel);

  const list = document.createElement('ol');
  neighbours.forEach((neighbour) => {
    const neighbourRow = DATASETS.get(bundle.ids[neighbour.i]) || {};
    const item = document.createElement('li');
    const anchor = document.createElement('a');
    anchor.href = '#';
    anchor.textContent = fmt.truncate(neighbourRow.title || bundle.ids[neighbour.i], 62);
    anchor.addEventListener('click', (event) => {
      event.preventDefault();
      select(neighbour.i);
    });
    item.appendChild(anchor);
    const score = document.createElement('div');
    score.className = 'score';
    score.textContent = `similarity ${neighbour.s.toFixed(3)} · ${neighbourRow.subName || ''}`;
    item.appendChild(score);
    list.appendChild(item);
  });
  container.appendChild(list);
}

function select(index) {
  state.selected = index;
  redraw();
  renderDetail();
}

/* ---------------------------------------------------------------------- */
/* Legend                                                                  */
/* ---------------------------------------------------------------------- */
function renderLegend() {
  const container = document.getElementById('scatter-legend');
  container.innerHTML = '';
  const grouping = GROUPINGS[state.colour];
  if (!grouping) {
    container.innerHTML = '<span style="font-size:0.78rem;color:var(--text-muted)">'
      + 'One colour for every dataset. Choose a grouping above to light up to three groups '
      + 'at a time.</span>';
    return;
  }

  const caption = document.createElement('span');
  caption.style.cssText = 'font-size:0.78rem;color:var(--text-muted);width:100%';
  caption.textContent = `${grouping.label}: select up to ${MAX_HIGHLIGHTS} to highlight. `
    + 'Beyond three, the colours stop being reliably distinguishable, so the oldest '
    + 'selection drops off.';
  container.appendChild(caption);

  // Warn when the clusters are not worth colouring by.
  const diagnostics = currentMethod().diagnostics;
  if (state.colour === 'cluster' && diagnostics.clustering_informative === false) {
    const warning = document.createElement('span');
    warning.style.cssText = 'font-size:0.78rem;color:var(--status-serious);width:100%';
    warning.textContent = 'Under this method '
      + `${fmt.pct(diagnostics.largest_cluster_share, 0)} of datasets fall into a single `
      + 'cluster, because most pairs of datasets score zero against each other and the '
      + 'distances are nearly all equal. The clustering is not telling you anything here; '
      + 'colour by subcollection instead, or switch to a method that grades similarity '
      + 'more finely.';
    container.appendChild(warning);
  }

  const colors = palette();
  groupCounts().forEach(([key, count]) => {
    const slot = state.highlights.indexOf(key);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'legend-item';
    button.setAttribute('aria-pressed', String(slot >= 0));
    button.innerHTML = `
      <span class="swatch" style="background:${slot >= 0 ? colors.series[slot] : 'var(--muted-mark)'}"></span>
      <span>${escapeHTML(fmt.truncate(key, 34))}</span>
      <span class="count">${fmt.int(count)}</span>`;
    button.addEventListener('click', () => {
      const at = state.highlights.indexOf(key);
      if (at >= 0) state.highlights.splice(at, 1);
      else {
        state.highlights.push(key);
        if (state.highlights.length > MAX_HIGHLIGHTS) state.highlights.shift();
      }
      redraw();
      renderLegend();
    });
    container.appendChild(button);
  });
}

/* ---------------------------------------------------------------------- */
/* Method panels                                                           */
/* ---------------------------------------------------------------------- */
function renderJustification() {
  document.getElementById('justification').innerHTML =
    renderProse(currentMethod().justification);
}

function renderTerms() {
  const method = currentMethod();
  const section = document.getElementById('terms-section');
  const table = document.getElementById('terms-table');
  table.innerHTML = '';

  if (!method.terms || !method.terms.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const isTopics = method.terms[0].topic !== undefined;
  document.getElementById('terms-heading').textContent =
    isTopics ? 'The topics this model found' : 'The strongest latent components';
  document.getElementById('terms-note').textContent = isTopics
    ? 'Each topic is a set of terms that tend to appear together. Non-negative matrix '
      + 'factorisation constrains every loading to be positive, which is what makes a '
      + 'topic readable as a list rather than a mix of present and absent terms. '
      + '"Datasets" counts those whose strongest topic is this one.'
    : 'Latent semantic analysis produces signed components, so each one has two ends and '
      + 'the terms below describe only the heaviest loadings. They are for orientation, '
      + 'not interpretation; the topic model is the one to read.';

  table.appendChild(buildTable(
    isTopics
      ? [
        { key: 'topic', label: 'Topic', align: 'right' },
        { key: 'terms', label: 'Heaviest terms', wrap: true, format: (v) => v.join(', ') },
        { key: 'datasets', label: 'Datasets', align: 'right', format: fmt.int },
        { key: 'share', label: 'Share of weight', align: 'right', format: (v) => fmt.pct(v, 1) },
      ]
      : [
        { key: 'component', label: 'Component', align: 'right' },
        { key: 'terms', label: 'Heaviest terms', wrap: true, format: (v) => v.join(', ') },
        {
          key: 'explained_variance',
          label: 'Variance explained',
          align: 'right',
          format: (v) => fmt.pct(v, 2),
        },
      ],
    method.terms,
  ));
}

function renderDiagnostics() {
  const bundle = currentBundle();
  const method = currentMethod();
  const rows = [];
  const push = (name, value) => rows.push({ name, value });

  push('Datasets placed', fmt.int(bundle.n));
  push('Datasets excluded', `${fmt.int(bundle.excluded.n)} — ${bundle.excluded.reason}`);
  Object.entries(method.params).forEach(([key, value]) => {
    push(`Parameter: ${key}`, Array.isArray(value) ? value.join('–') : String(value));
  });
  Object.entries(method.diagnostics).forEach(([key, value]) => {
    if (key === 'components') return;
    let shown;
    if (Array.isArray(value)) shown = value.join(', ');
    else if (typeof value === 'number') shown = Number.isInteger(value) ? fmt.int(value) : fmt.num(value, 4);
    else shown = String(value);
    push(key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), shown);
  });

  const container = document.getElementById('diagnostics-table');
  container.innerHTML = '';
  container.appendChild(buildTable([
    { key: 'name', label: 'Property' },
    { key: 'value', label: 'Value', wrap: true },
  ], rows));
}

/* ---------------------------------------------------------------------- */
function redraw() {
  const builder = buildScatter();
  if (!scatter) {
    scatter = mount('#chart-scatter', builder, null);
    scatter.chart.on('click', (params) => {
      if (params.data && params.data.index !== undefined) select(params.data.index);
    });
  } else {
    scatter.update(builder, null);
  }
}

function renderMethodSelect() {
  const bundle = currentBundle();
  const select_ = document.getElementById('method');
  select_.innerHTML = '';
  bundle.methodOrder.forEach((key) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = bundle.methods[key].label;
    select_.appendChild(option);
  });
  if (!bundle.methods[state.method]) state.method = bundle.methodOrder[0];
  select_.value = state.method;
}

function renderTitleList() {
  const bundle = currentBundle();
  const list = document.getElementById('title-list');
  list.innerHTML = '';
  bundle.ids.forEach((id) => {
    const row = DATASETS.get(id);
    if (!row) return;
    const option = document.createElement('option');
    option.value = row.title;
    list.appendChild(option);
  });
}

function renderAll() {
  const bundle = currentBundle();
  const method = currentMethod();

  document.getElementById('plot-title').textContent = `${bundle.label}: ${method.label}`;
  document.getElementById('plot-note').textContent = bundle.description;
  document.getElementById('controls-summary').innerHTML =
    `<span><strong>${fmt.int(bundle.n)}</strong> datasets placed</span>`
    + `<span><strong>${fmt.int(bundle.excluded.n)}</strong> excluded (${escapeHTML(bundle.excluded.reason)})</span>`
    + (bundle.vocabulary ? `<span><strong>${fmt.int(bundle.vocabulary)}</strong> ${state.dimension === 'keyword' ? 'keywords' : 'terms'} in the vocabulary</span>` : '');

  redraw();
  renderLegend();
  renderDetail();
  renderJustification();
  renderTerms();
  renderDiagnostics();
}

async function switchDimension(dimension) {
  if (!bundles[dimension]) {
    bundles[dimension] = await loadJSON(bundleFile(dimension));
  }
  state.dimension = dimension;
  state.method = null;
  state.selected = null;
  state.highlights = [];
  renderMethodSelect();
  renderTitleList();
  renderAll();
}

async function main() {
  const [datasets, scope] = await Promise.all([
    loadJSON('datasets.json'),
    loadJSON('scope.json'),
  ]);
  datasets.forEach((row) => DATASETS.set(row.id, row));

  await switchDimension('keyword');

  document.getElementById('dimension').addEventListener('change', (event) => {
    switchDimension(event.target.value).catch((error) => showError('#main', error));
  });
  document.getElementById('method').addEventListener('change', (event) => {
    state.method = event.target.value;
    state.selected = null;
    renderAll();
  });
  document.getElementById('projection').addEventListener('change', (event) => {
    state.projection = event.target.value;
    redraw();
  });
  document.getElementById('colour').addEventListener('change', (event) => {
    state.colour = event.target.value;
    state.highlights = [];
    redraw();
    renderLegend();
  });

  document.getElementById('find').addEventListener('change', (event) => {
    const query = event.target.value.trim().toLowerCase();
    if (!query) return;
    const bundle = currentBundle();
    const index = bundle.ids.findIndex((id) => {
      const row = DATASETS.get(id);
      return row && row.title.toLowerCase().includes(query);
    });
    if (index >= 0) select(index);
  });

  document.getElementById('controls').addEventListener('submit', (e) => e.preventDefault());
  window.addEventListener('cafe:themechange', renderLegend);

  document.getElementById('footer-provenance').textContent =
    `Keyword similarity is computed from extract 2.14a; description similarity from `
    + `descriptions re-fetched from Harvard Dataverse's public API on ${scope.extract_date}. `
    + 'Both are deterministic and need no model download.';
}

main().catch((error) => showError('#main', error));
