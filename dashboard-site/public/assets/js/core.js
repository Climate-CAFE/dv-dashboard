/* core.js -- shared behaviour for every page.
 *
 * The site does three things with data: load it, format it, and re-aggregate
 * it under a filter. It computes no statistics of its own. Everything shown
 * here is produced by a script under analysis/, which can be run and audited
 * without the site running at all.
 */

export const CAFE = {
  collectionUrl: 'https://dataverse.harvard.edu/dataverse.xhtml?alias=CAFE',
  repoUrl: 'https://github.com/climate-cafe/dv-dashboard',
};

/* ---------------------------------------------------------------------- */
/* Theme                                                                    */
/* ---------------------------------------------------------------------- */
const THEME_KEY = 'cafe-dash-theme';

export function initTheme() {
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch { /* private mode */ }
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.setAttribute('data-theme', stored);
  }
  const button = document.querySelector('[data-theme-toggle]');
  if (!button) return;
  const label = () => {
    const explicit = document.documentElement.getAttribute('data-theme');
    const dark = explicit
      ? explicit === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    button.textContent = dark ? 'Light' : 'Dark';
    button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  };
  label();
  button.addEventListener('click', () => {
    const explicit = document.documentElement.getAttribute('data-theme');
    const dark = explicit
      ? explicit === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
    label();
    window.dispatchEvent(new CustomEvent('cafe:themechange'));
  });
}

/* ---------------------------------------------------------------------- */
/* Navigation                                                               */
/* ---------------------------------------------------------------------- */
export function markCurrentNav() {
  const here = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav a').forEach((link) => {
    const target = link.getAttribute('href');
    if (target === here || (here === '' && target === 'index.html')) {
      link.setAttribute('aria-current', 'page');
    }
  });
}

/* ---------------------------------------------------------------------- */
/* Data                                                                     */
/* ---------------------------------------------------------------------- */
const cache = new Map();

export async function loadJSON(name) {
  if (cache.has(name)) return cache.get(name);
  const promise = fetch(`data/${name}`, { cache: 'no-cache' }).then((response) => {
    if (!response.ok) {
      throw new Error(`${name}: HTTP ${response.status}. Has the pipeline been run?`);
    }
    return response.json();
  });
  cache.set(name, promise);
  return promise;
}

export function showError(container, error) {
  const target = typeof container === 'string' ? document.querySelector(container) : container;
  if (!target) return;
  target.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'error';
  box.textContent = `Could not load this page's data: ${error.message}`;
  target.appendChild(box);
  console.error(error);
}

/* ---------------------------------------------------------------------- */
/* Formatting                                                               */
/* ---------------------------------------------------------------------- */
const numberFormat = new Intl.NumberFormat('en-US');

export const fmt = {
  int(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    return numberFormat.format(Math.round(value));
  },
  num(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    return value.toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  },
  pct(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    return `${(value * 100).toFixed(digits)}%`;
  },
  bytes(value) {
    if (!value || Number.isNaN(value)) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const scaled = value / 1024 ** power;
    return `${scaled.toFixed(scaled >= 100 || power === 0 ? 0 : 1)} ${units[power]}`;
  },
  /* Compact axis labels: 12000 -> 12k. Axis ticks only, never a stat value. */
  compact(value) {
    const abs = Math.abs(value);
    if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
    return String(value);
  },
  date(value) {
    if (!value) return '—';
    return value.slice(0, 10);
  },
  truncate(text, length = 70) {
    if (!text) return '';
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
  },
};

export function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* Minimal inline markdown for the method justifications the analysis scripts
 * emit: bold, italic, code, paragraphs and ordered lists. Deliberately not a
 * full parser -- the input is written by this project, not by users. */
export function renderProse(markdown) {
  const escaped = escapeHTML(markdown);
  const blocks = escaped.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const inline = (text) => text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*]+?)\*(?=[\s.,;:)]|$)/g, '$1<em>$2</em>')
        .replace(/`([^`]+?)`/g, '<code>$1</code>');
      const lines = block.split('\n');
      if (/^\d+\.\s/.test(lines[0])) {
        const items = lines
          .map((line) => line.replace(/^\d+\.\s*/, ''))
          .map((line) => `<li>${inline(line)}</li>`)
          .join('');
        return `<ol>${items}</ol>`;
      }
      if (/^[-*]\s/.test(lines[0])) {
        const items = lines
          .map((line) => line.replace(/^[-*]\s*/, ''))
          .map((line) => `<li>${inline(line)}</li>`)
          .join('');
        return `<ul>${items}</ul>`;
      }
      const text = inline(lines.join(' '));
      const heading = text.match(/^<strong>(.+?)<\/strong>\s*(.*)$/);
      if (heading && heading[1].length < 90 && heading[2]) {
        return `<h4>${heading[1]}</h4><p>${heading[2]}</p>`;
      }
      return `<p>${text}</p>`;
    })
    .join('');
}

/* ---------------------------------------------------------------------- */
/* Tables                                                                   */
/* ---------------------------------------------------------------------- */

/**
 * Build a data table. Every chart on this site has one of these as its
 * accessible twin: no value is reachable only through a tooltip.
 *
 * columns: [{ key, label, align, format }]
 */
export function buildTable(columns, rows) {
  const table = document.createElement('table');
  table.className = 'data';

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  columns.forEach((column) => {
    const th = document.createElement('th');
    th.textContent = column.label;
    if (column.align === 'right') th.className = 'num';
    th.scope = 'col';
    headRow.appendChild(th);
  });
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    columns.forEach((column) => {
      const td = document.createElement('td');
      const value = typeof column.key === 'function' ? column.key(row) : row[column.key];
      const rendered = column.format ? column.format(value, row) : value;
      if (rendered instanceof Node) {
        td.appendChild(rendered);
      } else {
        td.textContent = rendered === null || rendered === undefined || rendered === ''
          ? '—'
          : String(rendered);
      }
      if (column.align === 'right') td.className = 'num';
      if (column.wrap) td.classList.add('wrap');
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
  table.appendChild(body);
  return table;
}

export function link(href, text) {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.textContent = text;
  anchor.rel = 'noopener';
  anchor.target = '_blank';
  return anchor;
}

/* ---------------------------------------------------------------------- */
/* Aggregation helpers -- counting and summing, nothing more                */
/* ---------------------------------------------------------------------- */
export function countBy(rows, keyFn) {
  const counts = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (key === null || key === undefined) return;
    const keys = Array.isArray(key) ? key : [key];
    keys.forEach((k) => counts.set(k, (counts.get(k) || 0) + 1));
  });
  return counts;
}

export function sumBy(rows, keyFn, valueFn) {
  const totals = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (key === null || key === undefined) return;
    totals.set(key, (totals.get(key) || 0) + (valueFn(row) || 0));
  });
  return totals;
}

export function sortedEntries(map, limit = Infinity) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

export function median(values) {
  const clean = values.filter((v) => v !== null && v !== undefined && !Number.isNaN(v)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

export function initPage() {
  initTheme();
  markCurrentNav();
}
