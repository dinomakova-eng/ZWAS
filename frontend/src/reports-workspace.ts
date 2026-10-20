import './reports-workspace.css';
import {getApiData, prefetchAnalytics} from './data-client';
import {navigateApp} from './navigation';

type Asset = {id: number; name: string; region: string; district: string; source_folder: string; source_id: string; latest_power_output?: number};
type DailyReading = {turbine_id: number; date: string; records: number; wind_speed?: number; power_output?: number; temperature?: number; humidity?: number; air_pressure?: number; air_density?: number; availability_pct?: number; capacity_factor_pct?: number; data_quality_pct?: number; energy_produced_mwh?: number; estimated_revenue_usd?: number};
type MetricKey = 'reporting' | 'records' | 'wind' | 'minWind' | 'maxWind' | 'availability' | 'quality' | 'temperature' | 'humidity' | 'pressure' | 'density' | 'latest' | 'energy' | 'power' | 'capacity' | 'revenue';
type PointResult = Asset & {reporting: number; records: number; wind: number; minWind: number; maxWind: number; availability: number; quality: number; temperature: number; humidity: number; pressure: number; density: number; latest: string; energy: number; power: number; capacity: number; revenue: number};

const reportGroups = [
  ['Measured Wind Summary', ['Reporting Wind Points', 'Telemetry Records', 'Average Wind Speed', 'Minimum Wind Speed', 'Maximum Wind Speed', 'Data Availability']],
  ['Environmental Summary', ['Average Temperature', 'Average Humidity', 'Average Air Pressure', 'Average Air Density', 'Latest Source Record']],
  ['Derived Assessment Measures', ['Estimated Energy', 'Current Estimated Power', 'Assessment Capacity Factor', 'Estimated Revenue']],
  ['Analysis Library', ['Wind Resource Analysis', 'Site Comparison', 'Environmental Conditions', 'Data Quality and Coverage', 'Measured-data Forecast']],
] as const;

const reportDefinitions: Record<string, {metric: MetricKey; description: string; source: string}> = {
  'Reporting Wind Points': {metric: 'reporting', description: 'Wind measurement points contributing records to the selected source window.', source: 'Imported logger coverage'},
  'Telemetry Records': {metric: 'records', description: 'Imported telemetry samples represented by the selected wind points and time window.', source: 'Imported logger records'},
  'Average Wind Speed': {metric: 'wind', description: 'Record-weighted mean wind speed for the active reporting scope.', source: 'Measured wind telemetry'},
  'Minimum Wind Speed': {metric: 'minWind', description: 'Lowest daily mean wind speed observed within the active reporting scope.', source: 'Measured daily aggregates'},
  'Maximum Wind Speed': {metric: 'maxWind', description: 'Highest daily mean wind speed observed within the active reporting scope.', source: 'Measured daily aggregates'},
  'Data Availability': {metric: 'availability', description: 'Record-weighted logger availability for the selected source window.', source: 'Logger availability channel'},
  'Average Temperature': {metric: 'temperature', description: 'Record-weighted ambient temperature across the selected wind points.', source: 'Measured environmental telemetry'},
  'Average Humidity': {metric: 'humidity', description: 'Record-weighted relative humidity across the selected wind points.', source: 'Measured environmental telemetry'},
  'Average Air Pressure': {metric: 'pressure', description: 'Record-weighted air pressure across the selected wind points.', source: 'Measured environmental telemetry'},
  'Average Air Density': {metric: 'density', description: 'Record-weighted moist-air density calculated from pressure, temperature, and relative humidity.', source: 'Calculated environmental telemetry'},
  'Latest Source Record': {metric: 'latest', description: 'Most recent logger date represented by the active filters.', source: 'Imported source timestamps'},
  'Estimated Energy': {metric: 'energy', description: 'Estimated energy accumulated during the selected source window.', source: 'Wind energy formula'},
  'Current Estimated Power': {metric: 'power', description: 'Combined latest estimated power for the selected wind points.', source: 'Wind energy formula'},
  'Assessment Capacity Factor': {metric: 'capacity', description: 'Record-weighted assessment capacity factor for the selected source window.', source: 'Derived assessment measure'},
  'Estimated Revenue': {metric: 'revenue', description: 'Estimated revenue associated with derived energy in the selected source window.', source: 'Derived assessment measure'},
  'Wind Resource Analysis': {metric: 'wind', description: 'Comparison of measured average wind resource across the selected wind points.', source: 'Measured wind telemetry'},
  'Site Comparison': {metric: 'wind', description: 'Side-by-side measured wind comparison for sites in the active scope.', source: 'Measured wind telemetry'},
  'Environmental Conditions': {metric: 'density', description: 'Site-level density conditions with temperature, humidity, and pressure context.', source: 'Measured and calculated environmental telemetry'},
  'Data Quality and Coverage': {metric: 'quality', description: 'Site-level quality, record volume, and latest-source coverage.', source: 'Imported logger coverage'},
  'Measured-data Forecast': {metric: 'wind', description: 'Per-site regression forecasts validated against a statistical baseline with automatic fallback.', source: 'Validated regression and baseline selection'},
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const safe = (value: unknown) => Number(value || 0);
const average = (rows: DailyReading[], field: keyof DailyReading) => {
  const available = rows.filter(row => row[field] != null);
  const records = sum(available.map(row => row.records));
  return records ? sum(available.map(row => safe(row[field]) * row.records)) / records : 0;
};
const number = (value: number, digits = 2) => new Intl.NumberFormat('en-US', {maximumFractionDigits: digits}).format(value);
const metricUnit = (metric: MetricKey) => ({wind: 'm/s', minWind: 'm/s', maxWind: 'm/s', availability: '%', quality: '%', temperature: '°C', humidity: '%', pressure: 'hPa', density: 'kg/m3', energy: 'MWh', power: 'MW', capacity: '%', revenue: 'USD', records: 'records', reporting: 'points', latest: ''}[metric]);
const formatMetric = (metric: MetricKey, value: number | string) => {
  if (metric === 'latest') return String(value || '—');
  if (metric === 'revenue') return `$${number(Number(value))}`;
  if (metric === 'records') return Number(value).toLocaleString();
  if (metric === 'reporting') return `${number(Number(value), 0)} point${Number(value) === 1 ? '' : 's'}`;
  return `${number(Number(value), metric === 'density' ? 4 : metric === 'energy' || metric === 'power' ? 3 : 2)} ${metricUnit(metric)}`.trim();
};

const dispose = () => {
  if (window.location.pathname === '/reports') return;
  document.body.classList.remove('report-modal-open');
  document.querySelectorAll<HTMLElement>('.reports-fallback').forEach(fallback => {
    fallback.hidden = false;
    fallback.classList.remove('reports-fallback');
  });
};

const enhance = async () => {
  if (window.location.pathname !== '/reports') return;
  let host = document.querySelector<HTMLElement>('.workspace .reports-host');
  if (!host) {
    const fallback = document.querySelector<HTMLElement>('.workspace .content:not(.analytics-host):not(.admin-host):not(.prediction-host)');
    const workspace = document.querySelector<HTMLElement>('.workspace');
    if (!fallback || !workspace) return;
    fallback.hidden = true;
    fallback.classList.add('reports-fallback');
    host = document.createElement('main');
    host.className = 'content reports-host';
    workspace.append(host);
  }
  if (host.dataset.loading || host.dataset.enhanced) return;
  host.dataset.loading = 'true';
  try {
    const auth = JSON.parse(localStorage.getItem('zetdc-auth') || '{}');
    const [assets, dailyRows, liveAssets, liveDailyRows] = await Promise.all([
      getApiData<Asset[]>('/turbines', auth.t),
      getApiData<DailyReading[]>('/analytics/daily?days=90', auth.t),
      getApiData<Asset[]>('/turbines?source=live', auth.t).catch(() => [] as Asset[]),
      getApiData<DailyReading[]>('/analytics/daily?days=90&source=live', auth.t).catch(() => [] as DailyReading[]),
    ]);
    if (window.location.pathname !== '/reports') return;

    const state = {region: 'All regions', point: 'All wind points', days: 1, source: 'zetdc', report: ''};
    const regions = [...new Set(assets.map(point => point.region))].sort();
    const sourceRows = () => state.source === 'live' ? liveDailyRows : dailyRows;
    const sourceAssets = () => state.source === 'live' && liveAssets.length ? liveAssets : assets;
    const sourceLabel = () => state.source === 'live' ? 'Live Wind Maps Data' : state.source === 'difference' ? 'Live minus ZETDC Wind Mast data' : 'ZETDC Wind Mast data';
    const pointsInRegion = () => assets.filter(point => state.region === 'All regions' || point.region === state.region);
    const selectedPoints = () => pointsInRegion().filter(point => state.point === 'All wind points' || String(point.id) === state.point);
    const rowsFor = (point: Asset, rows = sourceRows()) => rows.filter(row => row.turbine_id === point.id).slice(-state.days);
    const buildPointResult = (point: Asset, rows: DailyReading[], latestPower?: number): PointResult => {
      const winds = rows.map(row => safe(row.wind_speed));
      return {...point, reporting: rows.length ? 1 : 0, records: sum(rows.map(row => row.records)), wind: average(rows, 'wind_speed'), minWind: winds.length ? Math.min(...winds) : 0, maxWind: winds.length ? Math.max(...winds) : 0, availability: average(rows, 'availability_pct'), quality: average(rows, 'data_quality_pct'), temperature: average(rows, 'temperature'), humidity: average(rows, 'humidity'), pressure: average(rows, 'air_pressure'), density: average(rows, 'air_density'), latest: rows[rows.length - 1]?.date || '—', energy: sum(rows.map(row => safe(row.energy_produced_mwh))), power: safe(latestPower ?? point.latest_power_output) / 1000, capacity: average(rows, 'capacity_factor_pct'), revenue: sum(rows.map(row => safe(row.estimated_revenue_usd)))};
    };
    const pointResults = (): PointResult[] => selectedPoints().map(point => {
      if (state.source !== 'difference') {
        const sourcePoint = sourceAssets().find(item => item.id === point.id) || point;
        return buildPointResult(sourcePoint, rowsFor(point), sourcePoint.latest_power_output);
      }
      const mast = buildPointResult(point, rowsFor(point, dailyRows), point.latest_power_output);
      const livePoint = liveAssets.find(item => item.id === point.id) || point;
      const live = buildPointResult(livePoint, rowsFor(point, liveDailyRows), livePoint.latest_power_output);
      return {...point, reporting: Math.max(mast.reporting, live.reporting), records: live.records - mast.records, wind: live.wind - mast.wind, minWind: live.minWind - mast.minWind, maxWind: live.maxWind - mast.maxWind, availability: live.availability - mast.availability, quality: live.quality - mast.quality, temperature: live.temperature - mast.temperature, humidity: live.humidity - mast.humidity, pressure: live.pressure - mast.pressure, density: live.density - mast.density, latest: live.latest, energy: live.energy - mast.energy, power: live.power - mast.power, capacity: live.capacity - mast.capacity, revenue: live.revenue - mast.revenue};
    });
    const allRows = () => selectedPoints().flatMap(point => rowsFor(point));
    const summary = () => {
      const points = pointResults();
      const rows = allRows();
      const winds = rows.map(row => safe(row.wind_speed));
      const dates = rows.map(row => row.date).sort();
      const latest = dates[dates.length - 1] || '—';
      if (state.source === 'difference') return {points, values: {reporting: sum(points.map(point => point.reporting)), records: sum(points.map(point => point.records)), wind: sum(points.map(point => point.wind)) / Math.max(points.length, 1), minWind: sum(points.map(point => point.minWind)) / Math.max(points.length, 1), maxWind: sum(points.map(point => point.maxWind)) / Math.max(points.length, 1), availability: sum(points.map(point => point.availability)) / Math.max(points.length, 1), quality: sum(points.map(point => point.quality)) / Math.max(points.length, 1), temperature: sum(points.map(point => point.temperature)) / Math.max(points.length, 1), humidity: sum(points.map(point => point.humidity)) / Math.max(points.length, 1), pressure: sum(points.map(point => point.pressure)) / Math.max(points.length, 1), density: sum(points.map(point => point.density)) / Math.max(points.length, 1), latest, energy: sum(points.map(point => point.energy)), power: sum(points.map(point => point.power)), capacity: sum(points.map(point => point.capacity)) / Math.max(points.length, 1), revenue: sum(points.map(point => point.revenue))} as Record<MetricKey, number | string>};
      return {points, values: {reporting: sum(points.map(point => point.reporting)), records: sum(rows.map(row => row.records)), wind: average(rows, 'wind_speed'), minWind: winds.length ? Math.min(...winds) : 0, maxWind: winds.length ? Math.max(...winds) : 0, availability: average(rows, 'availability_pct'), quality: average(rows, 'data_quality_pct'), temperature: average(rows, 'temperature'), humidity: average(rows, 'humidity'), pressure: average(rows, 'air_pressure'), density: average(rows, 'air_density'), latest, energy: sum(rows.map(row => safe(row.energy_produced_mwh))), power: sum(points.map(point => point.power)), capacity: average(rows, 'capacity_factor_pct'), revenue: sum(rows.map(row => safe(row.estimated_revenue_usd)))} as Record<MetricKey, number | string>};
    };
    const reportValue = (name: string, result: ReturnType<typeof summary>) => {
      const metric = reportDefinitions[name]?.metric || 'wind';
      if (name === 'Reporting Wind Points') return `${result.values.reporting} / ${selectedPoints().length}`;
      return formatMetric(metric, result.values[metric]);
    };
    const scopeName = () => state.point === 'All wind points' ? state.region : assets.find(point => String(point.id) === state.point)?.name || state.region;

    const detail = (name: string, result: ReturnType<typeof summary>) => {
      const definition = reportDefinitions[name];
      const metric = definition.metric;
      const chartMetric: MetricKey = metric === 'latest' ? 'records' : metric;
      const ranked = [...result.points].sort((a, b) => safe(b[chartMetric]) - safe(a[chartMetric]));
      const max = Math.max(...ranked.map(point => Math.abs(safe(point[chartMetric]))), 1);
      const leader = ranked[0];
      return `<div class="default-report-modal" data-report-modal role="dialog" aria-modal="true" aria-labelledby="default-report-dialog-title" tabindex="-1"><section class="default-report-expanded" aria-live="polite"><header class="default-report-heading"><div><button class="report-detail-back" data-report-back>← Default Reports</button><p class="eyebrow">DETAILED DEFAULT REPORT</p><h2 id="default-report-dialog-title">${name}</h2><p>${definition.description}</p></div><div class="report-detail-heading-actions"><div class="report-detail-source"><small>Report source</small><strong>${sourceLabel()}</strong><span>${scopeName()} · latest ${state.days} day${state.days === 1 ? '' : 's'} per point</span></div><button type="button" class="report-detail-close" data-report-back aria-label="Close detailed report">×</button></div></header><section class="report-detail-kpis"><article><small>Selected report result</small><strong>${reportValue(name, result)}</strong><span>${scopeName()}</span></article><article><small>Reporting wind points</small><strong>${result.values.reporting} / ${selectedPoints().length}</strong><span>points with source records</span></article><article><small>Telemetry records</small><strong>${Number(result.values.records).toLocaleString()}</strong><span>records in filtered window</span></article><article><small>Latest source record</small><strong>${result.values.latest}</strong><span>most recent date in scope</span></article></section><section class="report-detail-grid"><article class="report-detail-chart"><header><div><p class="eyebrow">SITE BREAKDOWN</p><h3>${name} by wind point</h3></div><span>${ranked.length} filtered point${ranked.length === 1 ? '' : 's'}</span></header><div class="report-detail-bars">${ranked.length ? ranked.map(point => `<div class="report-detail-bar"><span title="${point.name}">${point.name}</span><i><em style="width:${Math.max(3, Math.abs(safe(point[chartMetric])) / max * 100)}%"></em></i><b>${formatMetric(metric, point[metric])}</b></div>`).join('') : '<p class="report-detail-empty">No source records match the active filters.</p>'}</div></article><aside class="report-detail-insight"><p class="eyebrow">REPORT CONTEXT</p><h3>${leader ? `${leader.name} leads this view` : 'No matching source data'}</h3><p>${leader ? `${leader.name} has the highest site result in the filtered breakdown at ${formatMetric(metric, leader[metric])}.` : 'Change the filters to include a wind point with source records.'}</p><dl><div><dt>Region</dt><dd>${state.region}</dd></div><div><dt>Wind point</dt><dd>${state.point === 'All wind points' ? 'All in scope' : scopeName()}</dd></div><div><dt>Source window</dt><dd>Latest ${state.days} day${state.days === 1 ? '' : 's'} per point</dd></div></dl></aside></section><section class="report-detail-table"><header><div><p class="eyebrow">SOURCE DETAIL</p><h3>Filtered wind-point results</h3></div><span>Updates with every filter change</span></header><div><table><thead><tr><th>Wind point</th><th>Region / district</th><th>${name}</th><th>Records</th><th>Latest record</th></tr></thead><tbody>${ranked.map(point => `<tr><td><strong>${point.name}</strong><small>${point.source_folder} · ${point.source_id}</small></td><td>${point.region}<small>${point.district}</small></td><td><b>${formatMetric(metric, point[metric])}</b></td><td>${point.records.toLocaleString()}</td><td>${point.latest}</td></tr>`).join('')}</tbody></table></div></section></section></div>`;
    };

    const draw = () => {
      const result = summary();
      const availablePoints = pointsInRegion();
      host!.classList.remove('loading');
      host!.removeAttribute('aria-busy');
      const filters = `<section class="filters report-scope-filters"><label>Data source<select data-report-filter="source"><option value="zetdc" ${state.source === 'zetdc' ? 'selected' : ''}>ZETDC Wind Mast data</option><option value="live" ${state.source === 'live' ? 'selected' : ''}>Live Wind Maps Data</option><option value="difference" ${state.source === 'difference' ? 'selected' : ''}>Live minus ZETDC</option></select></label><label>ZETDC region<select data-report-filter="region"><option>All regions</option>${regions.map(region => `<option ${state.region === region ? 'selected' : ''}>${region}</option>`).join('')}</select></label><label>Wind point<select data-report-filter="point"><option>All wind points</option>${availablePoints.map(point => `<option value="${point.id}" ${state.point === String(point.id) ? 'selected' : ''}>${point.name}</option>`).join('')}</select></label><label>Latest source window<select data-report-filter="days">${[1, 7, 30, 90].map(days => `<option value="${days}" ${state.days === days ? 'selected' : ''}>${days} day${days === 1 ? '' : 's'}</option>`).join('')}</select></label><div class="report-region-context"><small>${sourceLabel()}</small><strong>${scopeName()}</strong><span>${result.values.reporting} reporting points · ${Number(result.values.records).toLocaleString()} records</span></div></section>`;
      host!.innerHTML = `<div class="page-title"><h1>Reports</h1><p class="eyebrow">MEASURED-DATA REPORTING</p><p>Select a default report to inspect its full, filter-aware wind-point breakdown.</p></div><nav class="report-tabs"><button class="active">Default Reports</button><button data-report-route="analytics">Advanced Analytics</button><button data-report-route="compare">Compare Sites</button></nav>${state.report ? '' : filters}${state.report ? detail(state.report, result) : `<section class="default-reports">${reportGroups.map(([group, reports]) => `<div><h3>${group}</h3><div class="default-report-grid">${reports.map(name => { const definition = reportDefinitions[name]; return `<article class="default-report-card" data-report-open="${name}" role="button" tabindex="0" aria-label="Open ${name} report"><strong>${name}</strong><span>${definition.source} · ${scopeName()}</span><b>${reportValue(name, result)}</b><button type="button" data-report-open="${name}">View detailed report</button></article>`; }).join('')}</div></div>`).join('')}</section>`}`;
      host!.dataset.enhanced = 'true';
      bind();
    };
    const closeReport = () => {
      state.report = '';
      document.body.classList.remove('report-modal-open');
      draw();
    };
    const openReport = (name: string) => {
      state.report = name;
      document.body.classList.add('report-modal-open');
      draw();
      requestAnimationFrame(() => host!.querySelector<HTMLButtonElement>('.report-detail-close')?.focus());
    };
    const bind = () => {
      host!.querySelectorAll<HTMLSelectElement>('[data-report-filter]').forEach(select => select.onchange = () => {
        const filter = select.dataset.reportFilter;
        if (filter === 'days') state.days = Number(select.value);
        if (filter === 'source') state.source = select.value;
        if (filter === 'region') { state.region = select.value; state.point = 'All wind points'; }
        if (filter === 'point') state.point = select.value;
        draw();
      });
      host!.querySelectorAll<HTMLButtonElement>('[data-report-route]').forEach(button => {
        const path = button.dataset.reportRoute === 'compare' ? '/reports/compare' : '/reports/analytics';
        button.onmouseenter = () => { prefetchAnalytics(auth.t).catch(() => undefined); };
        button.onfocus = () => { prefetchAnalytics(auth.t).catch(() => undefined); };
        button.onclick = () => navigateApp(path);
      });
      host!.querySelectorAll<HTMLButtonElement>('[data-report-back]').forEach(button => button.addEventListener('click', closeReport));
      const modal = host!.querySelector<HTMLElement>('[data-report-modal]');
      modal?.addEventListener('click', event => { if (event.target === modal) closeReport(); });
      modal?.addEventListener('keydown', event => { if (event.key === 'Escape') closeReport(); });
      host!.querySelectorAll<HTMLElement>('[data-report-open]').forEach(item => {
        item.onclick = event => { event.stopPropagation(); openReport(item.dataset.reportOpen || ''); };
        item.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openReport(item.dataset.reportOpen || ''); } };
      });
    };
    draw();
  } finally {
    delete host.dataset.loading;
  }
};

document.addEventListener('click', event => { const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]'); if (link && new URL(link.href, window.location.href).pathname !== '/reports') dispose(); }, true);
window.addEventListener('popstate', dispose);
window.addEventListener('zetdc:route-ready', () => { dispose(); enhance().catch(() => undefined); });
setInterval(() => { dispose(); enhance().catch(() => undefined); }, 5000);

export {};
