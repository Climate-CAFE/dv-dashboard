/* charts.js -- the chart layer.
 *
 * Every chart here follows the same rules, which is why they are set once in
 * this file rather than per chart:
 *
 *   - Colour is read from the CSS custom properties, so the palette is defined
 *     in one place and the dark steps are a selected set rather than an
 *     automatic inversion.
 *   - A single-series chart uses slot 1 for every mark. A value ramp on
 *     nominal categories would double-encode bar length as hue and burn the
 *     only free channel.
 *   - Two or more series always get a legend.
 *   - Gridlines and axes are solid hairlines, one shade off the surface.
 *   - No chart has two y-axes. Ever. Two measures of different scale become
 *     two charts.
 *   - Every chart is registered with a table view, so no value is reachable
 *     only through a tooltip.
 */

import { fmt, buildTable } from './core.js';

const registry = [];

export function palette() {
  const style = getComputedStyle(document.documentElement);
  const read = (name) => style.getPropertyValue(name).trim();
  return {
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => read(`--series-${i}`)),
    sequential: ['--seq-100', '--seq-250', '--seq-350', '--seq-450', '--seq-550', '--seq-650', '--seq-700'].map(read),
    surface: read('--surface'),
    text: read('--text-primary'),
    secondary: read('--text-secondary'),
    muted: read('--text-muted'),
    grid: read('--grid'),
    axis: read('--axis'),
    mutedMark: read('--muted-mark'),
    status: {
      good: read('--status-good'),
      warning: read('--status-warning'),
      serious: read('--status-serious'),
      critical: read('--status-critical'),
    },
  };
}

/** Shared axis, grid and tooltip chrome. */
export function baseOption(colors = palette()) {
  return {
    backgroundColor: 'transparent',
    animationDuration: 220,
    textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: colors.secondary },
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      confine: true,
      backgroundColor: colors.surface,
      borderColor: colors.axis,
      borderWidth: 1,
      padding: [8, 11],
      extraCssText: 'box-shadow: 0 2px 10px rgba(0,0,0,0.10); border-radius: 6px;',
      textStyle: { color: colors.text, fontSize: 12.5 },
    },
    legend: {
      type: 'scroll',
      icon: 'roundRect',
      itemWidth: 11,
      itemHeight: 11,
      itemGap: 14,
      textStyle: { color: colors.secondary, fontSize: 12 },
      inactiveColor: colors.mutedMark,
    },
  };
}

export function axis(colors, options = {}) {
  return {
    axisLine: { show: true, lineStyle: { color: colors.axis, width: 1 } },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: { color: colors.muted, fontSize: 11.5 },
    nameTextStyle: { color: colors.muted, fontSize: 11.5 },
    ...options,
  };
}

export function valueAxis(colors, options = {}) {
  return {
    type: 'value',
    axisLine: { show: false },
    axisTick: { show: false },
    // Solid hairline gridlines. Dashing reads as "threshold" when it is a grid.
    splitLine: { show: true, lineStyle: { color: colors.grid, width: 1, type: 'solid' } },
    axisLabel: { color: colors.muted, fontSize: 11.5, formatter: (v) => fmt.compact(v) },
    nameTextStyle: { color: colors.muted, fontSize: 11.5 },
    ...options,
  };
}

/**
 * Mount a chart into a card and register its table twin.
 *
 * @param {string} selector  the .chart element
 * @param {function} build   (colors) => echarts option
 * @param {object} table     { columns, rows } for the accessible twin
 */
export function mount(selector, build, table) {
  const element = typeof selector === 'string' ? document.querySelector(selector) : selector;
  if (!element) return null;
  const chart = echarts.init(element, null, { renderer: 'canvas' });

  const entry = {
    element,
    chart,
    build,
    /* Re-invoke the builder against the current palette. Called on first
     * paint, on a theme flip, and whenever the data behind the chart
     * changes -- the builder closes over its data, so swapping the builder
     * is how a filtered chart updates. */
    render() { this.chart.setOption(this.build(palette()), true); },
    /* Swap in a new builder (and table twin) and repaint. */
    update(nextBuild, nextTable) {
      this.build = nextBuild;
      this.render();
      if (nextTable && this.tableView) {
        this.tableView.innerHTML = '';
        this.tableView.appendChild(buildTable(nextTable.columns, nextTable.rows));
      }
    },
  };
  entry.render();
  registry.push(entry);

  if (table) attachTableView(element, table, table.label, entry);
  return entry;
}

/** Add the "Table" toggle and its hidden table to a chart's card. */
export function attachTableView(chartElement, table, label = 'Table', entry = null) {
  const card = chartElement.closest('.card');
  if (!card) return;
  let actions = card.querySelector('.chart-actions');
  if (!actions) {
    const header = card.querySelector('header') || card;
    actions = document.createElement('div');
    actions.className = 'chart-actions';
    header.appendChild(actions);
  }

  const view = document.createElement('div');
  view.className = 'table-view';
  view.appendChild(buildTable(table.columns, table.rows));
  chartElement.insertAdjacentElement('afterend', view);
  if (entry) entry.tableView = view;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip';
  button.textContent = label;
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', () => {
    const open = view.classList.toggle('is-open');
    button.setAttribute('aria-pressed', String(open));
    chartElement.style.display = open ? 'none' : '';
    if (!open) {
      const entry = registry.find((r) => r.element === chartElement);
      if (entry) entry.chart.resize();
    }
  });
  actions.appendChild(button);
}

/* Redraw everything on theme change and resize: the palette is read from CSS,
 * so a theme flip has to rebuild the options rather than recolour in place. */
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => registry.forEach((entry) => entry.chart.resize()), 120);
});
window.addEventListener('cafe:themechange', () => {
  registry.forEach((entry) => entry.render());
});

/* ====================================================================== */
/* Chart builders                                                          */
/* ====================================================================== */

/**
 * Horizontal bar chart, one series, slot 1 for every bar.
 * Rounded 4px on the data end only, anchored to the baseline.
 */
export function horizontalBar({ categories, values, valueName = 'Datasets', formatter = fmt.int, colorIndex = 0 }) {
  return (colors) => ({
    ...baseOption(colors),
    grid: { left: 8, right: 46, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      ...baseOption(colors).tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,0.10)' } },
      formatter: (params) => {
        const p = params[0];
        return `<strong>${p.name}</strong><br>${valueName}: ${formatter(p.value)}`;
      },
    },
    // No axis name: the card header states the measure, and an axis name at the
    // plot edge gets clipped by the container.
    xAxis: valueAxis(colors),
    yAxis: axis(colors, {
      type: 'category',
      data: categories,
      inverse: true,
      axisLabel: { color: colors.secondary, fontSize: 11.5, width: 190, overflow: 'truncate' },
    }),
    series: [{
      type: 'bar',
      data: values,
      barMaxWidth: 15,
      // 2px surface gap between adjacent bars, not a border around them.
      itemStyle: { color: colors.series[colorIndex], borderRadius: [0, 4, 4, 0] },
      emphasis: { itemStyle: { opacity: 0.85 } },
    }],
  });
}

/** Vertical bar chart, one series. */
export function verticalBar({ categories, values, valueName = 'Datasets', formatter = fmt.int, rotate = 0 }) {
  return (colors) => ({
    ...baseOption(colors),
    grid: { left: 8, right: 12, top: 16, bottom: rotate ? 24 : 8, containLabel: true },
    tooltip: {
      ...baseOption(colors).tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,0.10)' } },
      formatter: (params) => {
        const p = params[0];
        return `<strong>${p.name}</strong><br>${valueName}: ${formatter(p.value)}`;
      },
    },
    xAxis: axis(colors, {
      type: 'category',
      data: categories,
      axisLabel: { color: colors.muted, fontSize: 11.5, rotate, hideOverlap: true },
    }),
    yAxis: valueAxis(colors),
    series: [{
      type: 'bar',
      data: values,
      barMaxWidth: 26,
      itemStyle: { color: colors.series[0], borderRadius: [4, 4, 0, 0] },
      emphasis: { itemStyle: { opacity: 0.85 } },
    }],
  });
}

/** Stacked bars. Slots assigned in fixed order; 2px surface gap between fills. */
export function stackedBar({ categories, series, valueName = 'Datasets', horizontal = false, formatter = fmt.int }) {
  return (colors) => {
    const categoryAxis = axis(colors, {
      type: 'category',
      data: categories,
      inverse: horizontal,
      axisLabel: {
        color: colors.secondary, fontSize: 11.5,
        width: horizontal ? 190 : undefined,
        overflow: horizontal ? 'truncate' : undefined,
        hideOverlap: true,
      },
    });
    const measure = valueAxis(colors);
    return {
      ...baseOption(colors),
      grid: { left: 8, right: horizontal ? 46 : 12, top: 34, bottom: 8, containLabel: true },
      legend: { ...baseOption(colors).legend, top: 0, left: 0 },
      tooltip: {
        ...baseOption(colors).tooltip,
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,0.10)' } },
        formatter: (params) => {
          const lines = params
            .filter((p) => p.value)
            .map((p) => `${p.marker} ${p.seriesName}: <strong>${formatter(p.value)}</strong>`);
          return `<strong>${params[0].name}</strong><br>${lines.join('<br>')}`;
        },
      },
      xAxis: horizontal ? measure : categoryAxis,
      yAxis: horizontal ? categoryAxis : measure,
      series: series.map((s, index) => ({
        name: s.name,
        type: 'bar',
        stack: 'total',
        data: s.values,
        barMaxWidth: horizontal ? 15 : 26,
        itemStyle: {
          color: colors.series[index % colors.series.length],
          // The 2px gap between stacked segments, drawn as a surface-coloured
          // border rather than an outline around each mark.
          borderColor: colors.surface,
          borderWidth: 1,
        },
      })),
    };
  };
}

/** Line chart with a crosshair. 2px strokes, >=8px markers, no area fill by default. */
export function lineChart({ categories, series, valueName = 'Count', formatter = fmt.int, showSymbol = false }) {
  return (colors) => ({
    ...baseOption(colors),
    grid: { left: 8, right: 16, top: series.length > 1 ? 34 : 16, bottom: 8, containLabel: true },
    legend: series.length > 1
      ? { ...baseOption(colors).legend, top: 0, left: 0 }
      : { show: false },
    tooltip: {
      ...baseOption(colors).tooltip,
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: colors.axis, width: 1 } },
      formatter: (params) => {
        const lines = params.map((p) => `${p.marker} ${p.seriesName}: <strong>${formatter(p.value)}</strong>`);
        return `<strong>${params[0].axisValueLabel}</strong><br>${lines.join('<br>')}`;
      },
    },
    xAxis: axis(colors, {
      type: 'category',
      data: categories,
      boundaryGap: false,
      axisLabel: { color: colors.muted, fontSize: 11.5, hideOverlap: true },
    }),
    yAxis: valueAxis(colors),
    series: series.map((s, index) => ({
      name: s.name,
      type: 'line',
      data: s.values,
      smooth: false,
      showSymbol,
      symbolSize: 8,
      lineStyle: { width: 2, color: colors.series[index % colors.series.length] },
      itemStyle: { color: colors.series[index % colors.series.length], borderColor: colors.surface, borderWidth: 2 },
      areaStyle: s.area ? { opacity: 0.10, color: colors.series[index % colors.series.length] } : undefined,
    })),
  });
}

/**
 * Ordinal sequential ramp: one hue, light to dark, for ordered categories such
 * as hierarchy depth. On light surfaces the ramp starts at step 250 so the
 * lightest step still clears 2:1 against the surface.
 */
export function ordinalRamp(colors, count) {
  const steps = colors.sequential.slice(1); // drop step 100
  if (count <= 1) return [steps[Math.floor(steps.length / 2)]];
  return Array.from({ length: count }, (_, i) => {
    const position = (i / (count - 1)) * (steps.length - 1);
    return steps[Math.round(position)];
  });
}

export { registry };
