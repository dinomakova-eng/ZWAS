import './comparison-workspace.css';
import {getApiData} from './data-client';
import {navigateApp} from './navigation';

const API = '/api';
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const average = (values: number[]) => values.length ? sum(values) / values.length : 0;
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
const safe = (value: unknown) => Number(value || 0);
const format = (value: number, digits = 2) => new Intl.NumberFormat('en-US', {maximumFractionDigits: digits}).format(value);

type Point = {id: number | string; name: string; province: string; region: string; district?: string; locality?: string; source_folder?: string; source_id?: string; members?: number[]};
type Reading = {turbine_id: number; date: string; records: number; availability_pct?: number; data_quality_pct?: number; wind_speed?: number; wind_speed_min?: number; wind_speed_max?: number; wind_direction?: number; temperature?: number; humidity?: number; air_pressure?: number; air_density?: number};

const metrics = [
  ['wind', 'Average measured wind', 'm/s'], ['temperature', 'Average temperature', '°C'], ['humidity', 'Average humidity', '%'],
  ['minimum', 'Minimum measured wind', 'm/s'], ['maximum', 'Maximum measured wind', 'm/s'], ['direction', 'Average wind direction', '°'],
  ['pressure', 'Average air pressure', 'hPa'], ['density', 'Average air density', 'kg/m3'],
  ['availability', 'Data availability', '%'], ['quality', 'Data quality', '%'], ['records', 'Source records', 'records'],
] as const;

const dispose = () => {
  if (window.location.pathname === '/reports/compare') return;
};

const enhance = async () => {
  if (window.location.pathname !== '/reports/compare') return;
  const host = document.querySelector<HTMLElement>('.workspace .comparison-host');
  if (!host || host.dataset.loading || host.dataset.enhanced) return;
  host.dataset.loading = 'true';
  try {
    const auth = JSON.parse(localStorage.getItem('zetdc-auth') || '{}');
    const headers = {Authorization: `Bearer ${auth.t}`};
    const [assets, sourceRows, liveRows] = await Promise.all([
      getApiData<Point[]>('/turbines', auth.t),
      getApiData<Reading[]>('/analytics/daily?days=90', auth.t),
      getApiData<Reading[]>('/analytics/daily?days=90&source=live', auth.t).catch(() => [] as Reading[]),
    ]);
    if (window.location.pathname !== '/reports/compare') return;
    const points: Point[] = assets;
    const readings: Reading[] = sourceRows;
    const regionNames = [...new Set(points.map(point => point.region))].sort();
    const regions: Point[] = regionNames.map(region => {
      const members = points.filter(point => point.region === region);
      return {id: `region:${region}`, name: region, province: 'ZETDC region', region, district: `${members.length} wind points`, members: members.map(point => Number(point.id))};
    });
    const state = {type: 'Wind point versus wind point', primary: String(points[0]?.id || ''), comparison: String(points[1]?.id || ''), metric: 'wind', source: 'zetdc', period: 30, theme: false};
    const sourceLabel = () => state.source === 'live' ? 'Live Wind Maps Data' : state.source === 'difference' ? 'Live minus Wind Masts' : 'Wind Masts';
    const choices = () => state.type === 'Region versus region' ? regions : points;
    const periodRows = (memberIds: number[]) => memberIds.flatMap(id => {
      const rows = (state.source === 'live' ? liveRows : readings).filter(reading => reading.turbine_id === id);
      return rows.slice(-state.period);
    });
    const valueFor = (point: Point) => {
      const rows = periodRows(point.members || [Number(point.id)]);
      const diffRows = (source: Reading[]) => (point.members || [Number(point.id)]).flatMap(id => source.filter(reading => reading.turbine_id === id).slice(-state.period));
      if (state.source === 'difference') {
        const live = diffRows(liveRows);
        const mast = diffRows(readings);
        const values = {
          wind: weightedAverage(live, 'wind_speed') - weightedAverage(mast, 'wind_speed'),
          minimum: weightedAverage(live, 'wind_speed_min') - weightedAverage(mast, 'wind_speed_min'),
          maximum: weightedAverage(live, 'wind_speed_max') - weightedAverage(mast, 'wind_speed_max'),
          direction: directionDifference(weightedDirection(live), weightedDirection(mast)),
          temperature: weightedAverage(live, 'temperature') - weightedAverage(mast, 'temperature'),
          humidity: weightedAverage(live, 'humidity') - weightedAverage(mast, 'humidity'),
          pressure: weightedAverage(live, 'air_pressure') - weightedAverage(mast, 'air_pressure'),
          density: weightedAverage(live, 'air_density') - weightedAverage(mast, 'air_density'),
          availability: weightedAverage(live, 'availability_pct') - weightedAverage(mast, 'availability_pct'),
          quality: weightedAverage(live, 'data_quality_pct') - weightedAverage(mast, 'data_quality_pct'),
          records: sum(live.map(row => row.records)) - sum(mast.map(row => row.records)),
        };
        return {...values, value: values[state.metric as keyof typeof values]};
      }
      const values = {
        wind: weightedAverage(rows, 'wind_speed'),
        minimum: rows.length ? Math.min(...rows.map(row => safe(row.wind_speed_min ?? row.wind_speed))) : 0,
        maximum: rows.length ? Math.max(...rows.map(row => safe(row.wind_speed_max ?? row.wind_speed))) : 0,
        direction: weightedDirection(rows),
        temperature: weightedAverage(rows, 'temperature'),
        humidity: weightedAverage(rows, 'humidity'),
        pressure: weightedAverage(rows, 'air_pressure'),
        density: weightedAverage(rows, 'air_density'),
        availability: weightedAverage(rows, 'availability_pct'),
        quality: weightedAverage(rows, 'data_quality_pct'),
        records: sum(rows.map(row => row.records)),
      };
      return {...values, value: values[state.metric as keyof typeof values]};
    };
    const unit = () => metrics.find(([key]) => key === state.metric)?.[2] || '';
    const label = () => metrics.find(([key]) => key === state.metric)?.[1] || '';
    const shown = (value: number) => `${format(value, state.metric === 'density' ? 4 : 2)} ${unit()}`;

    const draw = () => {
      const available = choices();
      const primary = available.find(point => String(point.id) === state.primary) || available[0];
      const comparison = available.find(point => String(point.id) === state.comparison) || available[1] || primary;
      if (!primary || !comparison) return;
      state.primary = String(primary.id);
      state.comparison = String(comparison.id);
      const first = valueFor(primary), second = valueFor(comparison);
      const variance = second.value - first.value;
      const percentage = first.value ? variance / Math.abs(first.value) * 100 : 0;
      const max = Math.max(Math.abs(first.value), Math.abs(second.value), 1);
      host!.classList.remove('loading');
      const profile = (point: Point, data: ReturnType<typeof valueFor>, role: string) => `<article class="compare-profile"><header><span>${role}</span><b class="operational">measured</b></header><h3>${point.name}</h3><p>${point.region} · ${point.district || point.locality || 'Zimbabwe'}</p><dl><div><dt>Selected metric</dt><dd>${shown(data.value)}</dd></div><div><dt>Average wind</dt><dd>${format(data.wind)} m/s</dd></div><div><dt>Wind range</dt><dd>${format(data.minimum)}–${format(data.maximum)} m/s</dd></div><div><dt>Wind direction</dt><dd>${format(data.direction, 1)}°</dd></div><div><dt>Air density</dt><dd>${format(data.density, 4)} kg/m3</dd></div><div><dt>Temperature</dt><dd>${format(data.temperature)} °C</dd></div><div><dt>Data availability</dt><dd>${format(data.availability)}%</dd></div><div><dt>Data quality</dt><dd>${format(data.quality)}%</dd></div><div><dt>Records</dt><dd>${data.records.toLocaleString()}</dd></div></dl></article>`;
      host!.innerHTML = `<section class="comparison-workspace ${state.theme ? 'compare-dark' : ''}"><header class="compare-title"><div><button class="compare-back" data-action="back">← Back to Reports</button><p class="eyebrow">MEASURED SITE COMPARISON</p><h1>Comparison workspace</h1><p>All values recalculate from each point's own latest source-data window.</p></div><div><button data-action="theme">${state.theme ? '☀ Light' : '◐ Dark'}</button><button data-action="export">Export CSV</button></div></header><section class="compare-filters"><label>Data source<select data-state="source"><option value="zetdc" ${state.source === 'zetdc' ? 'selected' : ''}>Wind Masts</option><option value="live" ${state.source === 'live' ? 'selected' : ''}>Live Wind Maps Data</option><option value="difference" ${state.source === 'difference' ? 'selected' : ''}>Live minus Wind Masts</option></select></label><label>Comparison type<select data-state="type"><option>Wind point versus wind point</option><option>Region versus region</option></select></label><label>Primary<select data-state="primary">${available.map(point => `<option value="${point.id}" ${String(point.id) === state.primary ? 'selected' : ''}>${point.name}</option>`).join('')}</select></label><label>Comparison<select data-state="comparison">${available.map(point => `<option value="${point.id}" ${String(point.id) === state.comparison ? 'selected' : ''}>${point.name}</option>`).join('')}</select></label><label>Latest source window<select data-state="period">${[1, 7, 30, 90].map(days => `<option value="${days}" ${days === state.period ? 'selected' : ''}>${days} day${days === 1 ? '' : 's'}</option>`).join('')}</select></label><label>Measure<select data-state="metric">${metrics.map(([key, name]) => `<option value="${key}" ${key === state.metric ? 'selected' : ''}>${name}</option>`).join('')}</select></label><button class="compare-show" data-action="apply">Apply comparison</button></section><div class="compare-context"><b>${sourceLabel()}</b><span>${state.period} latest days per point · ${label()}</span><i>${first.records + second.records} imported records</i></div><section class="compare-kpis"><article><small>${primary.name}</small><strong>${shown(first.value)}</strong><span>Primary measured result</span></article><article><small>${comparison.name}</small><strong>${shown(second.value)}</strong><span>Comparison measured result</span></article><article><small>Absolute variance</small><strong>${variance >= 0 ? '+' : ''}${shown(variance)}</strong><span>${percentage >= 0 ? '+' : ''}${format(percentage)}% versus primary</span></article><article><small>Data coverage</small><strong>${first.records + second.records}</strong><span>source records compared</span></article></section><section class="compare-main-grid"><section class="compare-chart-card"><header><div><p class="eyebrow">SIDE-BY-SIDE RESULT</p><h2>${label()}</h2><span>Y-axis: ${unit()}</span></div></header><div class="compare-bars"><article><i style="height:${Math.max(8, Math.abs(first.value) / max * 100)}%"></i><b>${primary.name}</b><span>${shown(first.value)}</span></article><article><i style="height:${Math.max(8, Math.abs(second.value) / max * 100)}%"></i><b>${comparison.name}</b><span>${shown(second.value)}</span></article></div></section><aside class="compare-findings"><p class="eyebrow">AUTOMATIC FINDING</p><h2>Measured variance</h2><p>${comparison.name} is ${format(Math.abs(percentage))}% ${variance >= 0 ? 'higher' : 'lower'} than ${primary.name} for ${label().toLowerCase()}.</p><p>This is a descriptive comparison of imported mast observations and Open-Meteo live wind conditions.</p></aside></section><section class="compare-profiles">${profile(primary, first, 'PRIMARY POINT')}${profile(comparison, second, 'COMPARISON POINT')}</section></section>`;
      host!.dataset.enhanced = 'true';
      bind();
    };
    const bind = () => {
      host!.querySelectorAll<HTMLSelectElement>('[data-state]').forEach(select => select.onchange = () => {
        const key = select.dataset.state!;
        (state as any)[key] = key === 'period' ? Number(select.value) : select.value;
        if (key === 'type') {
          const available = choices();
          state.primary = String(available[0]?.id || '');
          state.comparison = String(available[1]?.id || available[0]?.id || '');
        }
        draw();
      });
      host!.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => button.onclick = () => {
        const action = button.dataset.action;
        if (action === 'back') navigateApp('/reports');
        if (action === 'theme') { state.theme = !state.theme; draw(); }
        if (action === 'apply') draw();
        if (action === 'export') {
          const available = choices();
          const csv = ['data_source,site,metric,value,unit,period_days,records', ...available.map(point => { const data = valueFor(point); return `${sourceLabel()},${point.name},${label()},${data.value},${unit()},${state.period},${data.records}`; })].join('\n');
          const link = document.createElement('a');
          link.href = URL.createObjectURL(new Blob([csv], {type: 'text/csv'}));
          link.download = 'wind-site-comparison.csv';
          link.click();
          URL.revokeObjectURL(link.href);
        }
      });
    };
    draw();
  } finally {
    delete host.dataset.loading;
  }
};

window.addEventListener('zetdc:route-ready', () => { dispose(); enhance().catch(() => undefined); });

export {};
