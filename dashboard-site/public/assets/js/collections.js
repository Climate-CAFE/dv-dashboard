/* collections.js -- the collection hierarchy, scaled by holdings.
 *
 * SETUP.md asks for "a general representation of the size of each
 * subcollection and its relationship to the parent CAFE collection ... derived
 * from a dendrogram or similar tree diagram, and show the subcollections in a
 * way that scales with their sizes proportionally."
 *
 * Two things follow from "proportionally" that are easy to get wrong:
 *
 *   Node AREA is proportional to the measure, so the radius goes as its square
 *   root. Scaling the radius linearly would make a collection with four times
 *   the datasets look sixteen times bigger.
 *
 *   Colour encodes DEPTH, not size. Size is already carried by area, and a
 *   value ramp over nominal categories would spend the only free channel
 *   restating it. Depth is genuinely ordinal, so it gets the one-hue ordinal
 *   ramp.
 *
 * The roll-up itself -- every node's cumulative holdings -- is computed in
 * analysis/R/05-collections.R, which checks that the root total equals the
 * scoped dataset count before writing anything.
 */

import { initPage, loadJSON, fmt, buildTable, escapeHTML, showError } from './core.js';
import { mount, baseOption, palette, ordinalRamp } from './charts.js';

initPage();

const state = { measure: 'datasets', basis: 'cumulative', empty: 'show' };

const MEASURES = {
  datasets: { label: 'Datasets', format: fmt.int },
  files: { label: 'Files', format: fmt.int },
  bytes: { label: 'Size', format: fmt.bytes },
  views: { label: 'Views', format: fmt.int },
};

const BASIS_NOTES = {
  cumulative: 'Each collection counts itself plus everything in its descendants, so the '
    + 'CAFE node carries the whole collection. This shows the shape of the hierarchy.',
  direct: 'Each collection counts only what sits directly inside it. This shows where '
    + 'content actually lives, and it is the honest view: several intermediate '
    + 'collections in this tree hold nothing themselves and exist to group others.',
};

let DATA = null;
let SCOPE = null;
let MAX_DEPTH = 0;
let trees = {};

const valueOf = (node) => node[state.basis][state.measure] || 0;

function prune(node) {
  const children = (node.children || []).map(prune).filter(Boolean);
  const own = valueOf(node);
  const total = node.cumulative[state.measure] || 0;
  if (state.empty === 'hide' && own === 0 && total === 0) return null;
  return { ...node, children };
}

/* ---------------------------------------------------------------------- */
/* Dendrogram                                                              */
/* ---------------------------------------------------------------------- */
function toTreeSeries(node, maxValue) {
  const value = valueOf(node);
  return {
    name: node.name,
    alias: node.alias,
    depth: node.depth,
    value,
    cumulative: node.cumulative[state.measure] || 0,
    direct: node.direct[state.measure] || 0,
    datasets: node.cumulative.datasets,
    description: node.description,
    // Area proportional to value: radius goes as the square root. The floor of
    // 5px keeps an empty collection visible as a node rather than a dot.
    symbolSize: maxValue > 0 ? 5 + 34 * Math.sqrt(value / maxValue) : 6,
    children: (node.children || []).map((child) => toTreeSeries(child, maxValue)),
  };
}

function collectMax(node, out = []) {
  out.push(valueOf(node));
  (node.children || []).forEach((child) => collectMax(child, out));
  return out;
}

/* ECharts gives every leaf an equal share of the plot height. With 56 nodes in
 * a 560px box that is 10px per label against an 11.5px font, so the labels
 * collide. Size the container to the tree instead of cropping the tree to the
 * container. */
function countLeaves(node) {
  const children = node.children || [];
  return children.length ? children.reduce((sum, c) => sum + countLeaves(c), 0) : 1;
}

function sizeTreeContainer(root) {
  const element = document.getElementById('chart-tree');
  const height = Math.max(560, countLeaves(root) * 19 + 60);
  element.style.height = `${height}px`;
}

function buildDendrogram(root) {
  const maxValue = Math.max(...collectMax(root), 1);
  const series = toTreeSeries(root, maxValue);
  const measure = MEASURES[state.measure];

  return (colors) => {
    const ramp = ordinalRamp(colors, MAX_DEPTH + 1);
    const paint = (node) => {
      node.itemStyle = {
        color: node.value > 0 ? ramp[Math.min(node.depth, ramp.length - 1)] : colors.mutedMark,
        borderColor: colors.surface,
        borderWidth: 2,
      };
      node.label = {
        color: colors.secondary,
        fontSize: 11.5,
        // The root sits at the left edge with every branch leaving to its
        // right, so a right-positioned label lands on top of the edges.
        position: node.alias === 'CAFE' ? 'top' : 'right',
        distance: 6,
        formatter: (params) => (
          params.data.value > 0
            ? `${fmt.truncate(params.name, 34)}  ${measure.format(params.data.value)}`
            : fmt.truncate(params.name, 34)
        ),
      };
      (node.children || []).forEach(paint);
      return node;
    };

    return {
      ...baseOption(colors),
      tooltip: {
        ...baseOption(colors).tooltip,
        trigger: 'item',
        formatter: (params) => {
          const d = params.data;
          return `<strong>${escapeHTML(d.name)}</strong><br>`
            + `<span style="color:${colors.muted}">${escapeHTML(d.alias)} &middot; depth ${d.depth}</span><br>`
            + `This collection only: <strong>${measure.format(d.direct)}</strong><br>`
            + `Including descendants: <strong>${measure.format(d.cumulative)}</strong>`;
        },
      },
      series: [{
        type: 'tree',
        data: [paint(structuredClone(series))],
        left: 16,
        right: 220,
        top: 20,
        bottom: 20,
        layout: 'orthogonal',
        orient: 'LR',
        edgeShape: 'curve',
        roam: true,
        initialTreeDepth: -1,
        symbol: 'circle',
        expandAndCollapse: true,
        animationDuration: 300,
        lineStyle: { color: colors.axis, width: 1, curveness: 0.5 },
        emphasis: { focus: 'descendant' },
        leaves: { label: { position: 'right', distance: 6 } },
      }],
    };
  };
}

/* ---------------------------------------------------------------------- */
/* Treemap                                                                 */
/* ---------------------------------------------------------------------- */
function toTreemap(node) {
  const children = (node.children || []).map(toTreemap).filter((c) => c.value > 0);
  // A parent's own datasets are not inside any child, so they need a node of
  // their own or the treemap silently loses them. ECharts sums children when
  // they are present, so the parent's direct holdings become a sibling leaf.
  const direct = node.direct[state.measure] || 0;
  if (children.length && direct > 0) {
    children.push({
      name: `${node.name} (directly)`,
      alias: node.alias,
      depth: node.depth + 1,
      value: direct,
      isDirect: true,
    });
  }
  return {
    name: node.name,
    alias: node.alias,
    depth: node.depth,
    value: children.length ? undefined : direct,
    children: children.length ? children : undefined,
  };
}

function buildTreemap(root) {
  const measure = MEASURES[state.measure];
  const data = toTreemap(root);

  return (colors) => {
    const ramp = ordinalRamp(colors, MAX_DEPTH + 1);
    return {
      ...baseOption(colors),
      tooltip: {
        ...baseOption(colors).tooltip,
        formatter: (params) => `<strong>${escapeHTML(params.name)}</strong><br>`
          + `${measure.label}: <strong>${measure.format(params.value)}</strong>`,
      },
      series: [{
        type: 'treemap',
        data: data.children || [data],
        roam: false,
        nodeClick: 'zoomToNode',
        // Two levels at once: one level is a flat set of rectangles in a
        // single hue, which shows the sizes but none of the nesting the
        // diagram exists to show.
        leafDepth: 2,
        breadcrumb: {
          show: true,
          height: 22,
          bottom: 2,
          // Without this ECharts draws an empty placeholder box at the root.
          emptyItemWidth: 0,
          itemStyle: { color: colors.surface, borderColor: colors.axis, textStyle: { color: colors.secondary } },
        },
        // A 2px surface gap between fills, not a border around each mark.
        itemStyle: { borderColor: colors.surface, borderWidth: 2, gapWidth: 2 },
        levels: [0, 1, 2, 3, 4, 5].map((level) => ({
          itemStyle: {
            borderColor: colors.surface,
            borderWidth: level === 0 ? 0 : 2,
            gapWidth: 2,
            color: ramp[Math.min(level + 2, ramp.length - 1)],
          },
          upperLabel: { show: level > 0, height: 18, color: colors.text, fontSize: 11 },
        })),
        label: {
          show: true,
          // Only render a label when it fits; a clipped label is worse than none.
          formatter: (params) => `${fmt.truncate(params.name, 26)}\n${measure.format(params.value)}`,
          fontSize: 11,
          color: '#fff',
          overflow: 'truncate',
          minMargin: 4,
        },
      }],
    };
  };
}

/* ---------------------------------------------------------------------- */
function tableSpec() {
  const measure = MEASURES[state.measure];
  return {
    columns: [
      { key: 'name', label: 'Collection', wrap: true },
      { key: 'alias', label: 'Alias' },
      { key: 'depth', label: 'Depth', align: 'right' },
      { key: 'direct_datasets', label: 'Datasets here', align: 'right', format: fmt.int },
      { key: 'cumulative_datasets', label: 'With descendants', align: 'right', format: fmt.int },
      { key: 'direct_harvested', label: 'Harvested', align: 'right', format: fmt.int },
      { key: 'cumulative_files', label: 'Files', align: 'right', format: fmt.int },
      { key: 'cumulative_bytes', label: 'Size', align: 'right', format: fmt.bytes },
      { key: 'cumulative_views', label: 'Views', align: 'right', format: fmt.int },
      { key: 'drafts_in_collection', label: 'Drafts excluded', align: 'right', format: fmt.int },
    ],
    rows: DATA.flat,
    label: `Table (${measure.label})`,
  };
}

function renderLegend(colors) {
  const container = document.getElementById('depth-legend');
  const ramp = ordinalRamp(colors, MAX_DEPTH + 1);
  const depths = [...new Set(DATA.flat.map((row) => row.depth))].sort((a, b) => a - b);
  container.innerHTML = '';
  const caption = document.createElement('span');
  caption.style.cssText = 'font-size:0.78rem;color:var(--text-muted);margin-right:4px';
  caption.textContent = 'Depth below the repository root:';
  container.appendChild(caption);
  depths.forEach((depth) => {
    const item = document.createElement('span');
    item.className = 'legend-item';
    item.innerHTML = `<span class="swatch" style="background:${ramp[Math.min(depth, ramp.length - 1)]}"></span>${depth}`;
    container.appendChild(item);
  });
  const empty = document.createElement('span');
  empty.className = 'legend-item';
  empty.innerHTML = `<span class="swatch" style="background:${colors.mutedMark}"></span>no holdings`;
  container.appendChild(empty);
}

function render() {
  const root = prune(DATA.tree) || DATA.tree;
  const measure = MEASURES[state.measure];

  document.getElementById('basis-note').innerHTML =
    `<strong>${escapeHTML(measure.label)}, ${state.basis === 'cumulative' ? 'including descendants' : 'this collection only'}.</strong> `
    + escapeHTML(BASIS_NOTES[state.basis]);

  const nonEmpty = DATA.flat.filter((row) => row[`direct_${state.measure}`] > 0).length;
  document.getElementById('controls-summary').innerHTML =
    `<span><strong>${fmt.int(DATA.flat.length)}</strong> collections</span>`
    + `<span><strong>${fmt.int(nonEmpty)}</strong> hold ${escapeHTML(measure.label.toLowerCase())} directly</span>`
    + `<span><strong>${fmt.int(DATA.summary.datasets)}</strong> datasets in the tree</span>`;

  sizeTreeContainer(root);

  if (!trees.tree) {
    trees.tree = mount('#chart-tree', buildDendrogram(root), tableSpec());
    trees.treemap = mount('#chart-treemap', buildTreemap(root), null);
  } else {
    trees.tree.update(buildDendrogram(root), tableSpec());
    trees.treemap.update(buildTreemap(root), null);
    trees.tree.chart.resize();
  }

  renderLegend(palette());

  // The drafts column can fall short of the collection-wide total, because it
  // is derived from a per-collection count that only covers datasets a CAFE
  // collection OWNS. A draft that is merely linked into CAFE has no owning
  // CAFE collection to be counted against. Stating the gap beats leaving a
  // reader to find that the column does not sum.
  const draftsInTree = DATA.flat.reduce((sum, row) => sum + (row.drafts_in_collection || 0), 0);
  const draftsTotal = SCOPE.scope.drafts_excluded;
  const unattributed = draftsTotal - draftsInTree;
  document.getElementById('table-note').textContent =
    `All ${DATA.flat.length} collections in the CAFE subtree. "Drafts excluded" counts the `
    + 'unpublished datasets each collection owns, which this site leaves out of every other '
    + `figure. The column sums to ${fmt.int(draftsInTree)} of the `
    + `${fmt.int(draftsTotal)} drafts in scope`
    + (unattributed
      ? `; the remaining ${fmt.int(unattributed)} `
        + `${unattributed === 1 ? 'is a draft that is' : 'are drafts that are'} linked into `
        + 'CAFE rather than owned by a collection in it, so no row can carry '
        + `${unattributed === 1 ? 'it' : 'them'}.`
      : '.');

  const container = document.getElementById('collections-table');
  container.innerHTML = '';
  const spec = tableSpec();
  container.appendChild(buildTable(spec.columns, spec.rows));
}

function bindToggles(id, attribute, field) {
  const container = document.getElementById(id);
  container.addEventListener('click', (event) => {
    const button = event.target.closest(`button[data-${attribute}]`);
    if (!button) return;
    state[field] = button.dataset[attribute];
    container.querySelectorAll('button').forEach((other) => {
      other.setAttribute('aria-pressed', String(other === button));
    });
    render();
  });
}

async function main() {
  const [collections, scope] = await Promise.all([
    loadJSON('collections.json'),
    loadJSON('scope.json'),
  ]);
  DATA = collections;
  SCOPE = scope;
  MAX_DEPTH = Math.max(...DATA.flat.map((row) => row.depth));

  document.getElementById('collection-count').textContent = String(DATA.flat.length);
  document.getElementById('max-depth').textContent = String(DATA.summary.max_depth + 1);

  bindToggles('measure-toggles', 'measure', 'measure');
  bindToggles('basis-toggles', 'basis', 'basis');
  bindToggles('empty-toggles', 'empty', 'empty');
  document.getElementById('controls').addEventListener('submit', (e) => e.preventDefault());

  render();
  window.addEventListener('cafe:themechange', () => renderLegend(palette()));

  document.getElementById('footer-provenance').textContent =
    `Extract taken ${scope.extract_date}. Sizes exclude the `
    + `${fmt.int(scope.scope.drafts_excluded)} draft datasets in the collection.`;
}

main().catch((error) => showError('#main', error));
