import './business-intelligence.css';
import './analytics-enhancements.css';
import './analysis-hub-sizing.css';
import './bi-report-export.css';
import {getApiData} from './data-client';
import {navigateApp} from './navigation';

const API = '/api';
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const average = (values: number[]) => values.length ? sum(values) / values.length : 0;
const safe = (value: unknown) => Number(value || 0);
const fmt = (value: number, digits = 2) => new Intl.NumberFormat('en-US', {maximumFractionDigits: digits}).format(value);
const html = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]!));
const csvCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;

type Asset = {
  id: number;
  name: string;
  province: string;
  region: string;
  district: string;
  source_folder: string;
  source_id: string;
  last_reading_at: string;
  lat: number;
  lon: number;
};

type Reading = {
  turbine_id: number;
  date: string;
  records: number;
  wind_speed?: number;
  wind_speed_min?: number;
  wind_speed_max?: number;
  wind_direction?: number;
  temperature?: number;
  humidity?: number;
  air_pressure?: number;
  air_density?: number;
  availability_pct?: number;
  data_quality_pct?: number;
};

type PointMetric = Asset & {
  wind: number;
  minWind: number;
  maxWind: number;
  direction: number;
  temperature: number;
  humidity: number;
  pressure: number;
  density: number;
  quality: number;
  availability: number;
  records: number;
};

type RegionCollection = {features?: Array<{properties?: {province?: string}; geometry?: {type?: string; coordinates?: any}}>};

const weightedAverage = (rows: Reading[], field: keyof Reading) => {
  const available = rows.filter(row => row[field] != null);
  const weight = sum(available.map(row => row.records));
  return weight ? sum(available.map(row => safe(row[field]) * row.records)) / weight : 0;
};
const weightedDirection = (rows: Reading[]) => {
  const available = rows.filter(row => row.wind_direction != null);
  const sine = sum(available.map(row => Math.sin(Number(row.wind_direction) * Math.PI / 180) * row.records));
  const cosine = sum(available.map(row => Math.cos(Number(row.wind_direction) * Math.PI / 180) * row.records));
  return available.length ? (Math.atan2(sine, cosine) * 180 / Math.PI + 360) % 360 : 0;
};
const directionDifference = (left: number, right: number) => ((left - right + 540) % 360) - 180;

const templates = [
  ['Measured Wind', [['wind', 'Wind resource summary'], ['wind', 'Site wind ranking'], ['minWind', 'Minimum wind conditions'], ['maxWind', 'Maximum wind conditions'], ['direction', 'Wind direction summary']]],
  ['Environment', [['temperature', 'Temperature conditions'], ['humidity', 'Humidity conditions'], ['pressure', 'Air-pressure conditions'], ['density', 'Air-density conditions']]],
  ['Data Governance', [['quality', 'Data quality'], ['availability', 'Logger availability'], ['records', 'Source-record coverage']]],
] as const;

const labels: Record<string, [string, string]> = {
  wind: ['Average wind speed', 'm/s'], minWind: ['Minimum wind speed', 'm/s'], maxWind: ['Maximum wind speed', 'm/s'], direction: ['Average wind direction', '°'], temperature: ['Average temperature', '°C'],
  humidity: ['Average humidity', '%'], pressure: ['Average air pressure', 'hPa'], density: ['Average air density', 'kg/m³'], quality: ['Data quality', '%'],
  availability: ['Logger availability', '%'], records: ['Source records', 'records'],
};

const interpretations: Record<string, string> = {
  wind: 'Higher wind-speed sites offer the strongest measured resource in the selected period; confirm long-term suitability with mast coverage and site studies.',
  minWind: 'Minimum wind speed shows the lowest measured condition in the selected source window.',
  maxWind: 'Maximum wind speed shows the highest measured condition in the selected source window.',
  direction: 'Wind direction is measured clockwise from north and helps describe the prevailing site flow.',
  temperature: 'Temperature provides environmental context for the measured wind conditions.',
  humidity: 'Humidity is environmental context used with temperature and pressure when calculating moist-air density.',
  pressure: 'Air pressure provides environmental context for comparing wind observations across sites.',
  density: 'Air density combines pressure, temperature, and humidity into a consistent environmental measure.',
  quality: 'Data quality represents completeness and validity of logger records in the active reporting scope.',
  availability: 'Availability shows how consistently each logger supplied valid measurements in the selected window.',
  records: 'Record coverage identifies which sites and time windows contribute the strongest evidence base.',
};

const metricDigits = (metric: string) => metric === 'density' ? 4 : metric === 'records' ? 0 : metric === 'direction' ? 1 : 2;
const fileSlug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const download = (contents: BlobPart, type: string, name: string) => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([contents], {type}));
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
};

const enhance = async () => {
  if (window.location.pathname !== '/reports/analytics') return;
  const host = document.querySelector<HTMLElement>('.workspace .content.analytics-host');
  const auth = JSON.parse(localStorage.getItem('zetdc-auth') || '{}');
  if (!host || !auth.t || host.dataset.loading || host.dataset.enhanced) return;
  host.dataset.loading = 'true';

  try {
    const headers = {Authorization: `Bearer ${auth.t}`};
    const [assets, sourceRows, liveAssets, liveSourceRows, regions] = await Promise.all([
      getApiData<Asset[]>('/turbines', auth.t),
      getApiData<Reading[]>('/analytics/daily?days=90', auth.t),
      getApiData<Asset[]>('/turbines?source=live', auth.t).catch(() => [] as Asset[]),
      getApiData<Reading[]>('/analytics/daily?days=90&source=live', auth.t).catch(() => [] as Reading[]),
      fetch('/gis/zetdc-regions.geojson').then(response => response.ok ? response.json() : {features: []}).catch(() => ({features: []})),
    ]) as [Asset[], Reading[], Asset[], Reading[], RegionCollection];
    if (window.location.pathname !== '/reports/analytics') return;

    const points = assets;
    const readings = sourceRows;
    const state = {
      metric: 'wind', template: 'Wind resource summary', province: 'All provinces', point: 'All wind points',
      source: 'zetdc', days: 30, visualization: 'Column chart', exportFormat: 'pdf', dark: false,
    };
    const activeReadings = () => state.source === 'live' ? liveSourceRows : sourceRows;
    const sourceLabel = () => state.source === 'live' ? 'Live Wind Maps Data' : state.source === 'difference' ? 'Live minus ZETDC Wind Mast data' : 'ZETDC Wind Mast data';
    const selectedPoints = () => points.filter(point => (state.province === 'All provinces' || point.province === state.province) && (state.point === 'All wind points' || String(point.id) === state.point));
    const rowsForSource = (point: Asset, rows: Reading[]) => rows.filter(reading => reading.turbine_id === point.id).slice(-state.days);
    const rowsFor = (point: Asset) => rowsForSource(point, activeReadings());
    const pointMetrics = (): PointMetric[] => selectedPoints().map(point => {
      const rows = rowsFor(point);
      const diff = (field: keyof Reading) => weightedAverage(rowsForSource(point, liveSourceRows), field) - weightedAverage(rowsForSource(point, sourceRows), field);
      if (state.source === 'difference') return {
        ...point,
        wind: diff('wind_speed'), minWind: diff('wind_speed_min'), maxWind: diff('wind_speed_max'), direction: directionDifference(weightedDirection(rowsForSource(point, liveSourceRows)), weightedDirection(rowsForSource(point, sourceRows))), temperature: diff('temperature'), humidity: diff('humidity'),
        pressure: diff('air_pressure'), density: diff('air_density'),
        quality: diff('data_quality_pct'), availability: diff('availability_pct'),
        records: sum(rowsForSource(point, liveSourceRows).map(row => row.records)) - sum(rowsForSource(point, sourceRows).map(row => row.records)),
      };
      return {
        ...point,
        wind: weightedAverage(rows, 'wind_speed'), minWind: rows.length ? Math.min(...rows.map(row => safe(row.wind_speed_min ?? row.wind_speed))) : 0, maxWind: rows.length ? Math.max(...rows.map(row => safe(row.wind_speed_max ?? row.wind_speed))) : 0, direction: weightedDirection(rows), temperature: weightedAverage(rows, 'temperature'),
        humidity: weightedAverage(rows, 'humidity'), pressure: weightedAverage(rows, 'air_pressure'), density: weightedAverage(rows, 'air_density'),
        quality: weightedAverage(rows, 'data_quality_pct'),
        availability: weightedAverage(rows, 'availability_pct'), records: sum(rows.map(row => row.records)),
      };
    });
    const metricValue = (row: PointMetric) => safe(row[state.metric as keyof PointMetric]);
    const unit = () => labels[state.metric]?.[1] || '';
    const formatted = (value: number) => `${fmt(value, metricDigits(state.metric))} ${unit()}`.trim();
    const scopeLabel = () => state.point === 'All wind points'
      ? `${state.province} · ${selectedPoints().length} wind point${selectedPoints().length === 1 ? '' : 's'}`
      : points.find(point => String(point.id) === state.point)?.name || 'Selected wind point';

    const mapMarkup = (rows: PointMetric[]) => {
      const width = 540;
      const height = 330;
      const minLon = 25.15;
      const maxLon = 33.15;
      const minLat = -22.55;
      const maxLat = -15.55;
      const project = (lon: number, lat: number) => [((lon - minLon) / (maxLon - minLon)) * width, ((maxLat - lat) / (maxLat - minLat)) * height];
      const ringPath = (ring: any[]) => ring.filter((_, index) => index % 8 === 0 || index === ring.length - 1).map((coordinate, index) => {
        const [x, y] = project(Number(coordinate[0]), Number(coordinate[1]));
        return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ') + ' Z';
      const regionPaths = (regions.features || []).map(feature => {
        const geometry = feature.geometry || {};
        const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates || [] : [geometry.coordinates || []];
        const path = polygons.flatMap((polygon: any[]) => polygon.map(ringPath)).join(' ');
        return `<path d="${path}" data-region="${html(feature.properties?.province || '')}"><title>${html(feature.properties?.province || 'ZETDC region')}</title></path>`;
      }).join('');
      const values = rows.map(metricValue);
      const minimum = values.length ? Math.min(...values) : 0;
      const maximum = values.length ? Math.max(...values) : 0;
      const spread = maximum - minimum || 1;
      const palette = ['#d9eef7', '#82d0e8', '#30a9cf', '#087fc3', '#083f78'];
      const mapRows = rows.filter(row => Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lon)));
      const markers = mapRows.map((row, index) => {
        const [x, y] = project(Number(row.lon), Number(row.lat));
        const score = (metricValue(row) - minimum) / spread;
        const colour = palette[Math.min(palette.length - 1, Math.max(0, Math.round(score * (palette.length - 1))))];
        const radius = 7 + score * 6;
        const side: 'left' | 'right' = x > width * .62 ? 'left' : x < width * .38 ? 'right' : index % 2 ? 'left' : 'right';
        return {row, x, y, score, colour, radius, side, labelY: y};
      });
      const arrangeLabels = (side: 'left' | 'right') => {
        const group = markers.filter(marker => marker.side === side).sort((first, second) => first.y - second.y);
        const gap = 25;
        const top = 18;
        const bottom = height - 22;
        let cursor = top;
        group.forEach(marker => {
          marker.labelY = Math.max(marker.y, cursor);
          cursor = marker.labelY + gap;
        });
        if (group.length && group[group.length - 1].labelY > bottom) {
          group[group.length - 1].labelY = bottom;
          for (let index = group.length - 2; index >= 0; index -= 1) {
            group[index].labelY = Math.min(group[index].labelY, group[index + 1].labelY - gap);
          }
        }
        if (group.length && group[0].labelY < top) {
          const shift = top - group[0].labelY;
          group.forEach(marker => { marker.labelY += shift; });
        }
      };
      arrangeLabels('left');
      arrangeLabels('right');
      const markerMarkup = markers.map(marker => {
        const {row, x, y, colour, radius, side, labelY} = marker;
        const labelX = x + (side === 'left' ? -(radius + 10) : radius + 10);
        const anchor = side === 'left' ? 'end' : 'start';
        const lineEnd = labelX + (side === 'left' ? 4 : -4);
        return `<g class="bi-fleet-marker" data-point="${row.id}" data-map-point tabindex="0" role="button" aria-label="${html(row.name)}, ${html(formatted(metricValue(row)))}"><line class="marker-leader" x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${lineEnd.toFixed(1)}" y2="${(labelY - 3).toFixed(1)}"/><circle class="marker-bubble" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(1)}" fill="${colour}"/><circle class="marker-core" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.2"/><text x="${labelX.toFixed(1)}" y="${(labelY - 4).toFixed(1)}" text-anchor="${anchor}">${html(row.name)}</text><text class="marker-value" x="${labelX.toFixed(1)}" y="${(labelY + 8).toFixed(1)}" text-anchor="${anchor}">${html(formatted(metricValue(row)))}</text><title>${html(row.name)} · ${html(labels[state.metric]?.[0])}: ${html(formatted(metricValue(row)))}</title></g>`;
      }).join('');
      return `<section class="bi-fleet-map-panel"><header><div><p class="eyebrow">FILTER-AWARE FLEET MAP</p><h2>${html(labels[state.metric]?.[0])} across Zimbabwe</h2><span>${html(scopeLabel())}</span></div><div class="bi-map-range"><small>Metric range</small><b>${html(formatted(minimum))} — ${html(formatted(maximum))}</b></div></header><div class="bi-fleet-map"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Fleet map showing ${html(labels[state.metric]?.[0])} at selected wind points"><g class="bi-region-shapes">${regionPaths}</g><g>${markerMarkup}</g></svg><div class="bi-map-legend"><span>Lower</span>${palette.map(colour => `<i style="background:${colour}"></i>`).join('')}<span>Higher</span></div></div><footer><b>Map measure:</b> ${html(labels[state.metric]?.[0])} (${html(unit())}) · marker labels show filtered site values.</footer></section>`;
    };

    const exportCsv = (rows: PointMetric[], generatedAt: string) => {
      const metadata = [
        ['ZETDC Wind Assessment System', state.template], ['Generated', generatedAt], ['Data source', sourceLabel()],
        ['Scope', scopeLabel()], ['Window', `Latest ${state.days} source day${state.days === 1 ? '' : 's'} per point`],
        ['Selected metric', `${labels[state.metric]?.[0]} (${unit()})`],
      ];
      const columns = ['Wind point', 'Province', 'ZETDC region', 'District', 'Latitude', 'Longitude', 'Folder', 'Logger', labels[state.metric]?.[0], 'Unit', 'Average wind speed (m/s)', 'Minimum wind speed (m/s)', 'Maximum wind speed (m/s)', 'Wind direction (degrees)', 'Temperature (°C)', 'Humidity (%)', 'Air pressure (hPa)', 'Air density (kg/m3)', 'Availability (%)', 'Data quality (%)', 'Records'];
      const data = rows.map(row => [row.name, row.province, row.region, row.district, row.lat, row.lon, row.source_folder, row.source_id, metricValue(row), unit(), row.wind, row.minWind, row.maxWind, row.direction, row.temperature, row.humidity, row.pressure, row.density, row.availability, row.quality, row.records]);
      const csv = '\ufeff' + [...metadata.map(row => row.map(csvCell).join(',')), '', columns.map(csvCell).join(','), ...data.map(row => row.map(csvCell).join(','))].join('\r\n');
      download(csv, 'text/csv;charset=utf-8', `${fileSlug(state.template)}-${new Date().toISOString().slice(0, 10)}.csv`);
    };

    const exportPdf = async (button: HTMLButtonElement) => {
      const pages = [...host!.querySelectorAll<HTMLElement>('.bi-pdf-page')];
      if (pages.length !== 2) throw new Error('The report pages are not ready to export.');
      const originalLabel = button.textContent || 'Export report';
      button.disabled = true;
      button.textContent = 'Creating PDF…';
      document.body.classList.add('bi-pdf-capture');
      try {
        const [{default: html2canvas}, {jsPDF}] = await Promise.all([import('html2canvas'), import('jspdf')]);
        await document.fonts?.ready;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const pdf = new jsPDF({orientation: 'landscape', unit: 'mm', format: 'a4', compress: true});
        for (let index = 0; index < pages.length; index += 1) {
          if (index) pdf.addPage('a4', 'landscape');
          const canvas = await html2canvas(pages[index], {
            backgroundColor: '#ffffff',
            scale: 1.6,
            useCORS: true,
            logging: false,
            windowWidth: 1120,
          });
          const pageWidth = pdf.internal.pageSize.getWidth();
          const pageHeight = pdf.internal.pageSize.getHeight();
          const margin = 7;
          const ratio = Math.min((pageWidth - margin * 2) / canvas.width, (pageHeight - margin * 2) / canvas.height);
          const imageWidth = canvas.width * ratio;
          const imageHeight = canvas.height * ratio;
          pdf.addImage(canvas.toDataURL('image/jpeg', .94), 'JPEG', (pageWidth - imageWidth) / 2, margin, imageWidth, imageHeight, undefined, 'FAST');
        }
        pdf.save(`${fileSlug(state.template)}-${new Date().toISOString().slice(0, 10)}.pdf`);
      } catch (error) {
        console.error('PDF export failed', error);
        alert('The PDF could not be created. Please try the export again.');
      } finally {
        document.body.classList.remove('bi-pdf-capture');
        button.disabled = false;
        button.textContent = originalLabel;
      }
    };

    const draw = () => {
      const rows = pointMetrics();
      const allSourceRows = selectedPoints().flatMap(rowsFor);
      let quality = weightedAverage(allSourceRows, 'data_quality_pct');
      let sourceRecordCount = sum(allSourceRows.map(row => row.records));
      if (state.source === 'difference') {
        quality = average(rows.map(row => row.quality));
        sourceRecordCount = sum(rows.map(row => row.records));
      }
      const ranked = [...rows].sort((a, b) => metricValue(b) - metricValue(a));
      const max = Math.max(...ranked.map(row => Math.abs(metricValue(row))), 1);
      const leader = ranked[0];
      const lowest = ranked[ranked.length - 1];
      const meanMetric = average(rows.map(metricValue));
      const provinces = [...new Set(points.map(point => point.province))].sort();
      const visualizationOptions = ['Column chart', 'Horizontal bars', 'Line chart', 'Area chart', 'Donut chart', 'Gauge', 'Data table'];
      const chartRows = state.visualization === 'Line chart' || state.visualization === 'Area chart' ? rows : ranked;
      const pointCoordinates = chartRows.map((row, index) => ({row, x: chartRows.length === 1 ? 200 : index / Math.max(chartRows.length - 1, 1) * 400, y: 94 - Math.abs(metricValue(row)) / max * 82}));
      const linePoints = pointCoordinates.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
      const totalMetric = sum(ranked.map(metricValue));
      const gaugeScore = Math.max(0, Math.min(100, Math.abs(meanMetric) / max * 100));
      const donutPalette = ['#087fc3', '#59c7ef', '#e6b547', '#39a978', '#8a6bc6', '#e77a58', '#4d9dca', '#d66a95'];
      const positiveTotal = sum(ranked.map(row => Math.abs(metricValue(row))));
      let donutPosition = 0;
      const donutSegments = ranked.map((row, index) => {
        const share = positiveTotal ? Math.abs(metricValue(row)) / positiveTotal * 100 : 100 / Math.max(ranked.length, 1);
        const start = donutPosition; donutPosition += share;
        return `${donutPalette[index % donutPalette.length]} ${start.toFixed(2)}% ${donutPosition.toFixed(2)}%`;
      }).join(', ');
      const visualizationMarkup = (() => {
        if (!rows.length) return '<p class="bi-empty">No data matches the active filters.</p>';
        if (state.visualization === 'Horizontal bars') return `<div class="bi-alt-visual bi-horizontal-visual">${ranked.map(row => `<button type="button" data-point="${row.id}" title="${html(row.name)}: ${html(formatted(metricValue(row)))}"><b>${html(row.name)}</b><i><em style="width:${Math.max(3, Math.abs(metricValue(row)) / max * 100)}%"></em></i><span>${html(formatted(metricValue(row)))}</span></button>`).join('')}</div>`;
        if (state.visualization === 'Line chart' || state.visualization === 'Area chart') {
          const area = state.visualization === 'Area chart' ? `<polygon points="0,100 ${linePoints} 400,100"></polygon>` : '';
          return `<div class="bi-alt-visual bi-line-visual ${state.visualization === 'Area chart' ? 'bi-area-visual' : ''}"><svg viewBox="0 0 400 100" preserveAspectRatio="none" role="img" aria-label="${html(labels[state.metric]?.[0])} by wind point">${area}<polyline points="${linePoints}" fill="none"></polyline>${pointCoordinates.map(point => `<circle data-point="${point.row.id}" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="2.2"><title>${html(point.row.name)}: ${html(formatted(metricValue(point.row)))}</title></circle>`).join('')}</svg><div class="bi-line-labels">${chartRows.map(row => `<span title="${html(row.name)}">${html(row.name)}</span>`).join('')}</div></div>`;
        }
        if (state.visualization === 'Donut chart') return `<div class="bi-alt-visual bi-donut-visual"><i style="background:conic-gradient(${donutSegments || '#dfeaf0 0 100%'})" aria-hidden="true"></i><div><b>${html(formatted(totalMetric))}</b><span>Total across selected wind points</span></div><ol>${ranked.map((row, index) => `<li><span><i style="background:${donutPalette[index % donutPalette.length]}"></i>${html(row.name)}</span><b>${positiveTotal ? (Math.abs(metricValue(row)) / positiveTotal * 100).toFixed(1) : '0.0'}%</b></li>`).join('')}</ol></div>`;
        if (state.visualization === 'Gauge') return `<div class="bi-alt-visual bi-gauge-visual"><i style="--score-angle:${(gaugeScore * 1.8).toFixed(1)}deg" aria-hidden="true"></i><div><b>${html(formatted(meanMetric))}</b><span>Selected-point average · ${gaugeScore.toFixed(0)}% of leading magnitude</span></div></div>`;
        if (state.visualization === 'Data table') return `<div class="bi-alt-visual bi-data-visual"><table><thead><tr><th>Wind point</th><th>${html(labels[state.metric]?.[0])}</th><th>Records</th></tr></thead><tbody>${ranked.map(row => `<tr data-point="${row.id}"><td>${html(row.name)}</td><td>${html(formatted(metricValue(row)))}</td><td>${row.records.toLocaleString()}</td></tr>`).join('')}</tbody></table></div>`;
        return `<div class="bi-chart-y"><span>${html(formatted(max))}</span><span>${html(formatted(max / 2))}</span><span>0</span></div><div class="bi-bars">${ranked.map(row => `<button title="${html(row.name)}: ${html(formatted(metricValue(row)))}" data-point="${row.id}"><i style="height:${Math.max(8, Math.abs(metricValue(row)) / max * 100)}%"></i><b>${html(row.name)}</b><span>${html(formatted(metricValue(row)))}</span></button>`).join('')}</div>`;
      })();
      const generatedAt = new Intl.DateTimeFormat('en-ZW', {dateStyle: 'medium', timeStyle: 'short'}).format(new Date());
      const coverage = rows.filter(row => row.records !== 0).length;

      host!.classList.remove('loading');
      host!.innerHTML = `<section class="bi-workspace ${state.dark ? 'bi-dark' : ''}">
        <aside class="bi-report-nav"><div class="bi-nav-title"><div><p class="eyebrow">MEASURED DATA</p><h1>Analysis hub</h1></div></div><button class="bi-new-report" data-action="back">← Reports</button><div class="bi-report-groups">${templates.map(([group, reports]) => `<section><p>${group}</p>${reports.map(([metric, name]) => `<button class="${state.template === name ? 'active' : ''}" data-template="${name}" data-metric="${metric}">${name}</button>`).join('')}</section>`).join('')}</div><footer><span class="bi-live-dot"></span> Eight folders connected<br><small>${readings.length.toLocaleString()} site-days · ${sum(readings.map(row => row.records)).toLocaleString()} records</small></footer></aside>
        <main class="bi-main"><header class="bi-topbar"><div><p class="eyebrow">WIND RESOURCE INTELLIGENCE</p><h1>${html(state.template)}</h1><p>Power BI-style, filter-aware reporting from measured wind and environmental source data.</p></div><div class="bi-top-actions"><button data-action="theme">${state.dark ? '☀ Light' : '◐ Dark'}</button><button data-action="save">Save</button><div class="bi-export-control"><label><span>Export format</span><select data-export-format><option value="pdf" ${state.exportFormat === 'pdf' ? 'selected' : ''}>PDF report</option><option value="csv" ${state.exportFormat === 'csv' ? 'selected' : ''}>CSV data</option></select></label><button data-action="export">Export report</button></div></div></header>
        <section class="bi-filter-bar"><label>Data source<select data-state="source"><option value="zetdc" ${state.source === 'zetdc' ? 'selected' : ''}>ZETDC Wind Mast data</option><option value="live" ${state.source === 'live' ? 'selected' : ''}>Live Wind Maps Data</option><option value="difference" ${state.source === 'difference' ? 'selected' : ''}>Live minus ZETDC</option></select></label><label>Province<select data-state="province"><option>All provinces</option>${provinces.map(province => `<option ${state.province === province ? 'selected' : ''}>${html(province)}</option>`).join('')}</select></label><label>Wind point<select data-state="point"><option>All wind points</option>${points.filter(point => state.province === 'All provinces' || point.province === state.province).map(point => `<option value="${point.id}" ${state.point === String(point.id) ? 'selected' : ''}>${html(point.name)}</option>`).join('')}</select></label><label>Latest source window<select data-state="days">${[1, 7, 30, 90].map(days => `<option value="${days}" ${state.days === days ? 'selected' : ''}>${days} day${days === 1 ? '' : 's'}</option>`).join('')}</select></label><label>Measure<select data-state="metric">${Object.entries(labels).map(([key, [name]]) => `<option value="${key}" ${state.metric === key ? 'selected' : ''}>${html(name)}</option>`).join('')}</select></label><label>Visualization<select data-state="visualization">${visualizationOptions.map(option => `<option ${state.visualization === option ? 'selected' : ''}>${option}</option>`).join('')}</select></label></section>
        <div class="bi-filter-context"><span>Active context:</span><b>${html(sourceLabel())} · ${html(scopeLabel())} · latest ${state.days} days per point</b><i>${sourceRecordCount.toLocaleString()} records</i></div>
        <div class="bi-report-content"><section class="bi-pdf-page bi-pdf-page-one"><header class="bi-export-header"><div><img src="/zesa-logo.png" alt="ZESA"/><div><p>ZIMBABWE ELECTRICITY SUPPLY AUTHORITY</p><h1>${html(state.template)}</h1><span>Wind Assessment System · Advanced Analytics Report</span></div></div><dl><div><dt>Generated</dt><dd>${html(generatedAt)}</dd></div><div><dt>Source</dt><dd>${html(sourceLabel())}</dd></div><div><dt>Scope</dt><dd>${html(scopeLabel())}</dd></div><div><dt>Window</dt><dd>Latest ${state.days} source days per point</dd></div></dl></header>
          <section class="bi-powerbi-grid"><section class="bi-canvas" data-visualization="${state.visualization}"><header><div><p class="eyebrow">${state.visualization.toUpperCase()}</p><h2>${html(labels[state.metric]?.[0])} by wind point</h2><span>Latest ${state.days} source days per point · ${fmt(quality)}% average quality</span></div></header><div class="bi-chart">${visualizationMarkup}</div><footer><span>Dimension: wind point</span><span>Measure: ${html(labels[state.metric]?.[0])} (${html(unit())})</span><span>${html(sourceLabel())}</span></footer></section>${mapMarkup(rows)}</section></section>
          <section class="bi-pdf-page bi-pdf-page-two"><section class="bi-bottom-grid"><section class="bi-table-panel"><header><div><p class="eyebrow">FILTERED SITE DETAIL</p><h2>Wind-point results and source coverage</h2></div><span>${rows.length} selected point${rows.length === 1 ? '' : 's'}</span></header><div class="bi-table-wrap"><table><thead><tr><th>Wind point</th><th>Province / region</th><th>${html(labels[state.metric]?.[0])}</th><th>Average wind</th><th>Wind range</th><th>Direction</th><th>Quality</th><th>Records</th></tr></thead><tbody>${ranked.map(row => `<tr data-point="${row.id}"><td><b>${html(row.name)}</b><small>${html(row.source_folder)} · ${html(row.source_id)}</small></td><td>${html(row.province)}<small>${html(row.region)} · ${html(row.district)}</small></td><td><b>${html(formatted(metricValue(row)))}</b></td><td>${fmt(row.wind)} m/s</td><td>${fmt(row.minWind)}–${fmt(row.maxWind)} m/s</td><td>${fmt(row.direction, 1)}°</td><td>${fmt(row.quality)}%</td><td>${row.records.toLocaleString()}</td></tr>`).join('')}</tbody></table></div></section>
            <aside class="bi-insight-panel"><div class="bi-panel-body"><p class="eyebrow">REPORT INSIGHTS</p><h2>${html(state.template)}</h2><div class="bi-insight-highlight"><small>Leading wind point</small><strong>${leader ? html(leader.name) : 'No matching data'}</strong><span>${leader ? html(formatted(metricValue(leader))) : '—'}</span></div><p>${leader && lowest ? `${html(leader.name)} has the highest filtered value. ${html(lowest.name)} has the lowest at ${html(formatted(metricValue(lowest)))}; the selected-point average is ${html(formatted(meanMetric))}.` : 'Adjust the filters to include source records.'}</p><h3>Interpretation</h3><p>${html(interpretations[state.metric] || 'Values reflect the active filters and source window.')}</p><h3>Coverage and provenance</h3><ul><li>${coverage} of ${rows.length} selected points contribute records.</li><li>${sourceRecordCount.toLocaleString()} source records are represented.</li><li>Data source: ${html(sourceLabel())}.</li><li>${state.source === 'difference' ? 'Values show live-source results minus mast results; negative values mean the live result is lower.' : 'Map markers and visuals use the same selected metric and filter scope.'}</li></ul></div></aside></section>
          <section class="bi-report-notes"><article><p class="eyebrow">METHODOLOGY</p><h2>How to read this report</h2><p>The selected metric is aggregated per wind point over the latest ${state.days} available source day${state.days === 1 ? '' : 's'}. Fleet averages are weighted by record count, while minimum and maximum wind values retain their source extrema.</p></article><article><p class="eyebrow">REPORT DEFINITION</p><dl><div><dt>Template</dt><dd>${html(state.template)}</dd></div><div><dt>Visualization</dt><dd>${html(state.visualization)}</dd></div><div><dt>Map measure</dt><dd>${html(labels[state.metric]?.[0])}</dd></div><div><dt>Generated</dt><dd>${html(generatedAt)}</dd></div></dl></article></section>
          <footer class="bi-report-footer"><span>ZETDC Wind Assessment System</span><span>Internal analytical report · screening and operational assessment use</span><span>${html(generatedAt)}</span></footer></section>
        </div></main></section>`;

      host!.dataset.enhanced = 'true';
      bind(rows, generatedAt);
    };

    const bind = (currentRows: PointMetric[], generatedAt: string) => {
      host!.querySelectorAll<HTMLButtonElement>('[data-template]').forEach(button => button.onclick = () => {
        state.template = button.dataset.template || state.template;
        state.metric = button.dataset.metric || state.metric;
        draw();
      });
      host!.querySelectorAll<HTMLSelectElement>('[data-state]').forEach(select => select.onchange = () => {
        const key = select.dataset.state!;
        (state as any)[key] = key === 'days' ? Number(select.value) : select.value;
        if (key === 'province') state.point = 'All wind points';
        draw();
      });
      const exportSelect = host!.querySelector<HTMLSelectElement>('[data-export-format]');
      if (exportSelect) exportSelect.onchange = () => { state.exportFormat = exportSelect.value; };
      host!.querySelectorAll<HTMLElement>('[data-point]').forEach(item => item.onclick = () => {
        state.point = item.dataset.point || 'All wind points';
        draw();
      });
      host!.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => button.onclick = async () => {
        const action = button.dataset.action;
        if (action === 'back') navigateApp('/reports');
        if (action === 'theme') { state.dark = !state.dark; draw(); }
        if (action === 'save') {
          await fetch(`${API}/reports`, {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify({title: `Advanced analytics — ${state.template}`, config: {source: state.source, province: state.province, point: state.point, days: state.days, metric: state.metric, visualization: state.visualization, includes_fleet_map: true}})});
          alert('Filter-aware analytics report saved.');
        }
        if (action === 'export') {
          if (state.exportFormat === 'csv') exportCsv(currentRows, generatedAt);
          else await exportPdf(button);
        }
      });
    };

    draw();
  } finally {
    delete host.dataset.loading;
  }
};

window.addEventListener('zetdc:route-ready', () => { enhance().catch(() => undefined); });

export {};
