import './prediction-workspace.css';
import './prediction-date-controls.css';
import {getApiData} from './data-client';

const API = '/api';
const fmt = (value: number, digits = 1) => new Intl.NumberFormat('en-US', {maximumFractionDigits: digits}).format(value);
const average = (values: number[]) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
const csvCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const fileSlug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const downloadFile = (content: BlobPart, type: string, filename: string) => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], {type}));
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
};
const formatForecastDate = (value?: string) => value ? new Intl.DateTimeFormat('en-ZW', {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
}).format(new Date(`${value}T00:00:00Z`)) : '—';

type Asset = {
  id: number;
  name: string;
  province: string;
  source_folder: string;
  source_id: string;
  last_reading_at: string;
  average_wind_speed: number;
  latest_temperature: number;
  latest_air_density: number;
};

type PredictionMetric = 'wind' | 'power' | 'density';
type SourceMode = 'zetdc' | 'live' | 'difference';

type ForecastRow = {
  date: string;
  wind_speed: number;
  power_output: number;
  energy_mwh: number;
  air_density: number;
  lower: number;
  upper: number;
};

type ModelDiagnostic = {
  selected_model: 'autoregressive_regression' | 'statistical_baseline';
  selection_reason: string;
  baseline_mae: number | null;
  regression_mae: number | null;
  validation_days: number;
  training_days: number;
};

type ForecastResponse = {
  model_version: string;
  model_basis: string;
  backtest_mae: number | null;
  validation: {strategy: string; metric?: string; regression_sites: number; baseline_sites: number};
  models_by_turbine: Record<string, ModelDiagnostic & {metrics?: {wind_speed: ModelDiagnostic; air_density: ModelDiagnostic}}>;
  training: {latest_observation: string; forecast_start: string; daily_site_records: number; wind_points: number};
  data: ForecastRow[];
  by_turbine: Record<string, ForecastRow[]>;
};

let closeDailyPredictions: (() => void) | null = null;

const dispose = () => {
  if (window.location.pathname === '/predictions') return;
  closeDailyPredictions?.();
  document.querySelectorAll<HTMLElement>('.prediction-fallback').forEach(fallback => {
    fallback.hidden = false;
    fallback.classList.remove('prediction-fallback');
  });
};

const enhance = async () => {
  if (window.location.pathname !== '/predictions') return;
  let host = document.querySelector<HTMLElement>('.workspace .prediction-host');
  if (!host) {
    const fallback = document.querySelector<HTMLElement>('.workspace .content:not(.analytics-host):not(.admin-host)');
    const workspace = document.querySelector<HTMLElement>('.workspace');
    if (!fallback || !workspace) return;
    fallback.hidden = true;
    fallback.classList.add('prediction-fallback');
    host = document.createElement('main');
    host.className = 'content prediction-host';
    workspace.append(host);
  }
  const auth = JSON.parse(localStorage.getItem('zetdc-auth') || '{}');
  if (!auth.t || host.dataset.predictionLoading || host.dataset.predictionEnhanced) return;
  host.dataset.predictionLoading = 'true';
  try {
    const headers = {Authorization: `Bearer ${auth.t}`};
    const [mastPrediction, mastAssets, livePrediction, liveAssets]: [ForecastResponse, Asset[], ForecastResponse | null, Asset[]] = await Promise.all([
      getApiData<ForecastResponse>('/predictions?days=180', auth.t),
      getApiData<Asset[]>('/turbines', auth.t),
      getApiData<ForecastResponse>('/predictions?days=180&source=live', auth.t).catch(() => null),
      getApiData<Asset[]>('/turbines?source=live', auth.t).catch(() => [] as Asset[]),
    ]);
    if (window.location.pathname !== '/predictions') return;

    const state: {scope: string; horizon: number; metric: PredictionMetric; source: SourceMode; exportFormat: 'pdf' | 'csv'} = {
      scope: 'fleet', horizon: 90, metric: 'wind', source: 'zetdc', exportFormat: 'pdf',
    };
    const predictionFor = () => state.source === 'live' && livePrediction ? livePrediction : mastPrediction;
    const assetsFor = () => state.source === 'live' && liveAssets.length ? liveAssets : mastAssets;
    const differenceRows = (liveRows: ForecastRow[], mastRows: ForecastRow[]) => liveRows.map((row, index) => {
      const mast = mastRows[index] || mastRows[mastRows.length - 1] || row;
      return {
        date: row.date,
        wind_speed: row.wind_speed - mast.wind_speed,
        power_output: row.power_output - mast.power_output,
        energy_mwh: row.energy_mwh - mast.energy_mwh,
        air_density: row.air_density - mast.air_density,
        lower: row.lower - mast.lower,
        upper: row.upper - mast.upper,
      };
    });
    const activePrediction = () => predictionFor();
    const selectedAsset = () => assetsFor().find(asset => String(asset.id) === state.scope) || mastAssets.find(asset => String(asset.id) === state.scope);
    const sourceLabel = () => state.source === 'live' ? 'Live Wind Maps Data' : state.source === 'difference' ? 'Live minus ZETDC Wind Mast data' : 'ZETDC Wind Mast data';
    const allRows = () => {
      if (state.source === 'difference' && livePrediction) {
        const liveRows = selectedAsset() ? livePrediction.by_turbine[state.scope] || [] : livePrediction.data;
        const mastRows = selectedAsset() ? mastPrediction.by_turbine[state.scope] || [] : mastPrediction.data;
        return differenceRows(liveRows, mastRows);
      }
      const prediction = activePrediction();
      return selectedAsset() ? prediction.by_turbine[state.scope] || [] : prediction.data;
    };
    const rows = () => allRows().slice(0, state.horizon);
    const scopeName = () => selectedAsset()?.name || 'All eight wind points';
    const modelName = (value?: string) => value === 'autoregressive_regression' ? 'Autoregressive regression' : 'Statistical baseline';
    const diagnosticForMetric = (diagnostic?: ModelDiagnostic & {metrics?: {wind_speed: ModelDiagnostic; air_density: ModelDiagnostic}}) =>
      state.metric === 'density' ? diagnostic?.metrics?.air_density || diagnostic : diagnostic?.metrics?.wind_speed || diagnostic;
    const modelSummary = () => {
      if (state.source === 'difference') return 'Comparison of validated source forecasts';
      const prediction = activePrediction();
      const siteModel = state.scope === 'fleet' ? undefined : diagnosticForMetric(prediction.models_by_turbine?.[state.scope]);
      const fleetModels = Object.values(prediction.models_by_turbine || {}).map(diagnosticForMetric).filter((model): model is ModelDiagnostic => Boolean(model));
      return siteModel
        ? `${modelName(siteModel.selected_model)} · ${siteModel.selection_reason}`
        : `${fleetModels.filter(model => model.selected_model === 'autoregressive_regression').length} regression · ${fleetModels.filter(model => model.selected_model === 'statistical_baseline').length} baseline`;
    };
    const selectedModelMae = () => {
      if (state.source === 'difference') return null;
      const diagnostics = state.scope === 'fleet'
        ? Object.values(activePrediction().models_by_turbine || {}).map(diagnosticForMetric)
        : [diagnosticForMetric(activePrediction().models_by_turbine?.[state.scope])];
      const maes = diagnostics.flatMap(model => {
        if (!model) return [];
        const value = model.selected_model === 'autoregressive_regression' ? model.regression_mae : model.baseline_mae;
        return value == null ? [] : [value];
      });
      return maes.length ? average(maes) : null;
    };

    const metricMeta = () => ({
      wind: {label: 'Wind resource', heading: 'WIND RESOURCE', unit: 'm/s', digits: 2},
      power: {label: 'Estimated power', heading: 'DERIVED POWER', unit: 'MW', digits: 3},
      density: {label: 'Air density', heading: 'AIR DENSITY', unit: 'kg/m3', digits: 4},
    }[state.metric]);
    const metricValue = (row: ForecastRow) => state.metric === 'wind' ? row.wind_speed : state.metric === 'power' ? row.power_output / 1000 : row.air_density;
    const metricLow = (row: ForecastRow) => state.metric === 'wind' ? row.lower : state.metric === 'power' ? 0 : row.air_density;
    const metricHigh = (row: ForecastRow) => state.metric === 'wind' ? row.upper : metricValue(row);

    const openDailyPredictions = (trigger: HTMLButtonElement) => {
      const dailyRows = rows();
      closeDailyPredictions?.();
      const modal = document.createElement('section');
      modal.className = 'prediction-daily-modal-backdrop';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'prediction-daily-title');
      modal.innerHTML = `<div class="prediction-daily-modal"><header><div><p class="eyebrow">DAY-BY-DAY FORECAST</p><h2 id="prediction-daily-title">${state.horizon}-day predictions</h2><p>${scopeName()} · ${sourceLabel()}</p></div><div class="prediction-daily-actions"><button type="button" data-daily-action="print">Print</button><button type="button" data-daily-action="download">Download CSV</button><button type="button" data-daily-action="export">Export JSON</button><button type="button" class="prediction-daily-close" aria-label="Close daily predictions">×</button></div></header><div class="prediction-daily-context"><span><b>${dailyRows.length}</b> forecast days</span><span>Selected measure: <b>${metricMeta().label}</b></span><span>Model: <b>${modelSummary()}</b></span></div><div class="prediction-daily-table-wrap"><table><thead><tr><th>Day</th><th>Date</th><th>Forecast wind</th><th>Planning range</th><th>Estimated power</th><th>Air density</th><th>Estimated energy</th></tr></thead><tbody>${dailyRows.map((row, index) => `<tr><td><b>Day ${index + 1}</b></td><td><strong>${formatForecastDate(row.date)}</strong><small>${row.date}</small></td><td>${fmt(row.wind_speed, 2)} m/s</td><td>${fmt(row.lower, 2)}–${fmt(row.upper, 2)} m/s</td><td>${fmt(row.power_output / 1000, 3)} MW</td><td>${fmt(row.air_density, 4)} kg/m3</td><td>${fmt(row.energy_mwh, 3)} MWh</td></tr>`).join('')}</tbody></table></div><footer>Source filter: ${sourceLabel()} · ${activePrediction().model_version}.</footer></div>`;
      const close = () => {
        modal.remove();
        document.body.classList.remove('prediction-modal-open');
        document.removeEventListener('keydown', onKeyDown);
        closeDailyPredictions = null;
        if (trigger.isConnected) trigger.focus();
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') close();
      };
      const filename = `daily-predictions-${state.scope}-${state.horizon}-days`;
      modal.querySelector<HTMLButtonElement>('[data-daily-action="print"]')!.onclick = () => window.print();
      modal.querySelector<HTMLButtonElement>('[data-daily-action="download"]')!.onclick = () => {
        const headings = ['day', 'date', 'scope', 'selected_model', 'forecast_wind_speed_m_s', 'lower_m_s', 'upper_m_s', 'estimated_power_kw', 'air_density_kg_m3', 'estimated_energy_mwh'];
        const csvRows = dailyRows.map((row, index) => [index + 1, row.date, scopeName(), modelSummary(), row.wind_speed, row.lower, row.upper, row.power_output, row.air_density, row.energy_mwh].map(csvCell).join(','));
        downloadFile(`\uFEFF${[headings.join(','), ...csvRows].join('\n')}`, 'text/csv;charset=utf-8', `${filename}.csv`);
      };
      modal.querySelector<HTMLButtonElement>('[data-daily-action="export"]')!.onclick = () => {
        const exported = {
          scope: scopeName(),
          horizon_days: state.horizon,
          selected_measure: state.metric,
          source: sourceLabel(),
          model_version: activePrediction().model_version,
          model_selection: modelSummary(),
          validation: activePrediction().validation,
          models_by_turbine: activePrediction().models_by_turbine,
          latest_observation: activePrediction().training.latest_observation,
          forecast_start: activePrediction().training.forecast_start,
          predictions: dailyRows,
        };
        downloadFile(JSON.stringify(exported, null, 2), 'application/json', `${filename}.json`);
      };
      modal.querySelector<HTMLButtonElement>('.prediction-daily-close')!.onclick = close;
      modal.onclick = event => { if (event.target === modal) close(); };
      document.addEventListener('keydown', onKeyDown);
      closeDailyPredictions = close;
      document.body.classList.add('prediction-modal-open');
      document.body.append(modal);
      modal.querySelector<HTMLButtonElement>('.prediction-daily-close')!.focus();
    };

    const exportFilename = () => `wind-forecast-${fileSlug(scopeName())}-${state.horizon}-days`;
    const exportCsv = () => {
      const prediction = activePrediction();
      const metadata = [
        ['ZETDC Wind Assessment System', 'Prediction report'],
        ['Scope', scopeName()],
        ['Data source', sourceLabel()],
        ['Forecast horizon', `${state.horizon} days`],
        ['Selected measure', metricMeta().label],
        ['Model version', prediction.model_version],
        ['Model selection', modelSummary()],
        ['Latest observation', prediction.training.latest_observation],
        ['Forecast start', prediction.training.forecast_start],
      ];
      const headings = ['Day', 'Date', 'Scope', 'Selected model', 'Forecast wind speed (m/s)', 'Lower bound (m/s)', 'Upper bound (m/s)', 'Estimated power (kW)', 'Air density (kg/m3)', 'Estimated energy (MWh)'];
      const csvRows = rows().map((row, index) => [index + 1, row.date, scopeName(), modelSummary(), row.wind_speed, row.lower, row.upper, row.power_output, row.air_density, row.energy_mwh]);
      const csv = '\uFEFF' + [
        ...metadata.map(row => row.map(csvCell).join(',')),
        '',
        headings.map(csvCell).join(','),
        ...csvRows.map(row => row.map(csvCell).join(',')),
      ].join('\r\n');
      downloadFile(csv, 'text/csv;charset=utf-8', `${exportFilename()}.csv`);
    };

    const exportPdf = async (button: HTMLButtonElement) => {
      const disclaimer = host!.querySelector<HTMLElement>('.prediction-disclaimer');
      const controls = host!.querySelector<HTMLElement>('.prediction-controls');
      const kpis = host!.querySelector<HTMLElement>('.prediction-kpis');
      const forecast = host!.querySelector<HTMLElement>('.forecast-panel');
      const table = host!.querySelector<HTMLElement>('.prediction-table');
      if (!disclaimer || !controls || !kpis || !forecast || !table) {
        alert('The prediction report is not ready to export.');
        return;
      }

      const originalLabel = button.textContent || 'Export report';
      button.disabled = true;
      button.textContent = 'Creating PDF…';
      const generatedAt = new Intl.DateTimeFormat('en-ZW', {dateStyle: 'medium', timeStyle: 'short'}).format(new Date());
      const exportRoot = document.createElement('section');
      exportRoot.className = 'prediction-pdf-export prediction-host';
      const reportHeader = (page: number) => `<header class="prediction-export-header"><div><img src="/zesa-logo.png" alt="ZESA"><div><p>ZIMBABWE ELECTRICITY SUPPLY AUTHORITY</p><h1>Wind resource predictions</h1><span>${scopeName()} · ${sourceLabel()}</span></div></div><dl><div><dt>Generated</dt><dd>${generatedAt}</dd></div><div><dt>Horizon</dt><dd>${state.horizon} days</dd></div><div><dt>Model</dt><dd>${activePrediction().model_version}</dd></div><div><dt>Page</dt><dd>${page} of 2</dd></div></dl></header>`;
      const pageOne = document.createElement('section');
      pageOne.className = 'prediction-export-page';
      pageOne.innerHTML = reportHeader(1);
      [disclaimer, controls, kpis, forecast].forEach(section => pageOne.append(section.cloneNode(true)));
      const pageTwo = document.createElement('section');
      pageTwo.className = 'prediction-export-page';
      pageTwo.innerHTML = reportHeader(2);
      pageTwo.append(table.cloneNode(true));
      const footer = document.createElement('footer');
      footer.className = 'prediction-export-footer';
      footer.textContent = `Validated adaptive forecast · ${modelSummary()} · Latest observation ${activePrediction().training.latest_observation}`;
      pageTwo.append(footer);
      exportRoot.append(pageOne, pageTwo);
      document.body.append(exportRoot);

      try {
        const [{default: html2canvas}, {jsPDF}] = await Promise.all([import('html2canvas'), import('jspdf')]);
        await document.fonts?.ready;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const pages = [pageOne, pageTwo];
        const pdf = new jsPDF({orientation: 'landscape', unit: 'mm', format: 'a4', compress: true});
        for (let index = 0; index < pages.length; index += 1) {
          if (index) pdf.addPage('a4', 'landscape');
          const canvas = await html2canvas(pages[index], {backgroundColor: '#ffffff', scale: 1.6, useCORS: true, logging: false, windowWidth: 1120});
          const pageWidth = pdf.internal.pageSize.getWidth();
          const pageHeight = pdf.internal.pageSize.getHeight();
          const margin = 7;
          const ratio = Math.min((pageWidth - margin * 2) / canvas.width, (pageHeight - margin * 2) / canvas.height);
          const imageWidth = canvas.width * ratio;
          const imageHeight = canvas.height * ratio;
          pdf.addImage(canvas.toDataURL('image/jpeg', .94), 'JPEG', (pageWidth - imageWidth) / 2, margin, imageWidth, imageHeight, undefined, 'FAST');
        }
        pdf.save(`${exportFilename()}.pdf`);
      } catch (error) {
        console.error('Prediction PDF export failed', error);
        alert('The prediction PDF could not be created. Please try again.');
      } finally {
        exportRoot.remove();
        button.disabled = false;
        button.textContent = originalLabel;
      }
    };

    const saveReport = async (button: HTMLButtonElement) => {
      const originalLabel = button.textContent || 'Save';
      const prediction = activePrediction();
      const title = `Prediction report — ${scopeName()}`;
      const config = {
        report_type: 'prediction',
        source: state.source,
        source_label: sourceLabel(),
        scope: state.scope,
        scope_label: scopeName(),
        horizon_days: state.horizon,
        metric: state.metric,
        model: prediction.model_version,
        model_selection: modelSummary(),
        latest_observation: prediction.training.latest_observation,
        forecast_start: prediction.training.forecast_start,
      };
      const filename = `${exportFilename()}.json`;
      const picker = (window as Window & {showSaveFilePicker?: (options: unknown) => Promise<any>}).showSaveFilePicker;
      let fileHandle: any = null;

      if (picker) {
        try {
          fileHandle = await picker.call(window, {
            suggestedName: filename,
            types: [{description: 'Prediction report', accept: {'application/json': ['.json']}}],
          });
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          console.error('Prediction save dialog failed', error);
        }
      }

      button.disabled = true;
      button.textContent = 'Saving…';
      let savedRecord: unknown = null;
      let apiError: unknown = null;
      try {
        const response = await fetch(`${API}/reports`, {
          method: 'POST',
          headers: {...headers, 'Content-Type': 'application/json'},
          body: JSON.stringify({title, config}),
        });
        if (!response.ok) throw new Error(`Save failed with status ${response.status}`);
        savedRecord = await response.json();
      } catch (error) {
        apiError = error;
        console.error('Prediction report save failed', error);
      }

      try {
        const reportFile = JSON.stringify({
          title,
          saved_at: new Date().toISOString(),
          saved_report: savedRecord,
          configuration: config,
          validation: prediction.validation,
          training: prediction.training,
          models_by_turbine: prediction.models_by_turbine,
          predictions: rows(),
        }, null, 2);
        if (fileHandle) {
          const writable = await fileHandle.createWritable();
          await writable.write(new Blob([reportFile], {type: 'application/json'}));
          await writable.close();
          button.textContent = 'Saved';
        } else {
          downloadFile(reportFile, 'application/json;charset=utf-8', filename);
          button.textContent = 'Downloaded';
        }
        if (apiError) alert('The report file was saved locally, but it could not be added to the system saved reports.');
      } catch (error) {
        console.error('Prediction report file save failed', error);
        alert(savedRecord
          ? 'The report was added to the system, but the local file could not be saved.'
          : 'The prediction report could not be saved. Please try again.');
      } finally {
        window.setTimeout(() => {
          if (button.isConnected) {
            button.disabled = false;
            button.textContent = originalLabel;
          }
        }, 900);
      }
    };

    const draw = () => {
      const windowRows = rows();
      const wind = average(windowRows.map(row => row.wind_speed));
      const energy = windowRows.reduce((total, row) => total + row.energy_mwh, 0);
      const peak = Math.max(...windowRows.map(row => row.power_output), 0) / 1000;
      const density = average(windowRows.map(row => row.air_density));
      const meta = metricMeta();
      const sampled = windowRows.filter((_, index) => index % Math.max(1, Math.floor(windowRows.length / 14)) === 0);
      const maxValue = Math.max(...sampled.map(row => Math.abs(metricHigh(row))), 1);
      const bars = sampled.map(row => {
        const value = metricValue(row);
        const low = metricLow(row);
        const high = metricHigh(row);
        return `<span data-date="${row.date}" data-value="${value.toFixed(meta.digits)}" data-low="${low.toFixed(meta.digits)}" data-high="${high.toFixed(meta.digits)}" data-unit="${meta.unit}"><i style="height:${Math.max(8, Math.abs(high) / maxValue * 100)}%"></i><b>${row.date.slice(5)}</b></span>`;
      }).join('');
      const pointRows = mastAssets.map(asset => {
        const siteRows = state.source === 'difference' && livePrediction ? differenceRows(livePrediction.by_turbine[String(asset.id)] || [], mastPrediction.by_turbine[String(asset.id)] || []).slice(0, state.horizon) : (activePrediction().by_turbine[String(asset.id)]?.slice(0, state.horizon) || []);
        const siteModel = diagnosticForMetric(activePrediction().models_by_turbine?.[String(asset.id)]);
        return {
          ...asset,
          forecastWind: average(siteRows.map(row => row.wind_speed)),
          forecastDensity: average(siteRows.map(row => row.air_density)),
          forecastEnergy: siteRows.reduce((total, row) => total + row.energy_mwh, 0),
          forecastModel: state.source === 'difference' ? 'Comparison' : modelName(siteModel?.selected_model),
        };
      });

      const backtestValue = selectedModelMae();
      const backtestUnit = state.metric === 'density' ? 'kg/m3' : 'm/s';
      const backtestDisplay = backtestValue == null ? 'Not yet validated' : `${fmt(backtestValue, state.metric === 'density' ? 4 : 3)} ${backtestUnit}`;

      host!.classList.remove('loading');
      host!.innerHTML = `<div class="page-title prediction-heading"><div><p class="eyebrow">VALIDATED ADAPTIVE FORECAST</p><h1>Wind resource predictions</h1><p>${scopeName()} · ${sourceLabel()}</p></div><div class="prediction-action-row"><button type="button" class="prediction-daily" aria-haspopup="dialog">View daily predictions</button><button type="button" class="prediction-save">Save</button><div class="prediction-export-control"><label><span>Export format</span><select class="prediction-export-format"><option value="pdf" ${state.exportFormat === 'pdf' ? 'selected' : ''}>PDF report</option><option value="csv" ${state.exportFormat === 'csv' ? 'selected' : ''}>CSV data</option></select></label><button type="button" class="prediction-export">Export report</button></div></div></div><section class="prediction-disclaimer"><b>MODEL SELECTION: ${modelSummary()}</b><span>${activePrediction().model_basis}. Air density history is calculated from pressure, temperature, and humidity before forecasting.</span></section><section class="prediction-controls"><label>Data source<select class="prediction-source"><option value="zetdc" ${state.source === 'zetdc' ? 'selected' : ''}>ZETDC Wind Mast data</option><option value="live" ${state.source === 'live' ? 'selected' : ''}>Live Wind Maps Data</option><option value="difference" ${state.source === 'difference' ? 'selected' : ''}>Live minus ZETDC</option></select></label><label>Forecast horizon<select class="prediction-horizon"><option value="7" ${state.horizon === 7 ? 'selected' : ''}>7 days</option><option value="30" ${state.horizon === 30 ? 'selected' : ''}>30 days</option><option value="90" ${state.horizon === 90 ? 'selected' : ''}>90 days</option><option value="180" ${state.horizon === 180 ? 'selected' : ''}>Six months</option></select></label><label>Forecast measure<select class="prediction-metric"><option value="wind" ${state.metric === 'wind' ? 'selected' : ''}>Wind resource</option><option value="power" ${state.metric === 'power' ? 'selected' : ''}>Estimated power</option><option value="density" ${state.metric === 'density' ? 'selected' : ''}>Air density</option></select></label><label>Wind-point scope<select class="prediction-scope"><option value="fleet">All eight wind points</option>${mastAssets.map(asset => `<option value="${asset.id}" ${state.scope === String(asset.id) ? 'selected' : ''}>${asset.name}</option>`).join('')}</select></label></section><section class="prediction-kpis"><article><div class="prediction-symbol">W</div><div><small>Forecast wind</small><strong>${fmt(wind, 2)} m/s</strong><em>${state.horizon}-day mean</em></div></article><article><div class="prediction-symbol revenue">MWh</div><div><small>Estimated energy</small><strong>${fmt(energy, 2)} MWh</strong><em>wind energy formula</em></div></article><article><div class="prediction-symbol health">rho</div><div><small>Forecast air density</small><strong>${fmt(density, 4)} kg/m3</strong><em>moist-air calculation</em></div></article><article><div class="prediction-symbol danger">±</div><div><small>Selected-model MAE</small><strong>${backtestDisplay}</strong><em>${activePrediction().training.daily_site_records} daily site records</em></div></article></section><section class="prediction-panel forecast-panel"><div class="section-heading"><div><p class="eyebrow">${meta.heading} FORECAST</p><h3>${scopeName()}</h3></div><span>Hover a date for forecast values</span></div><div class="forecast-bars">${bars}</div><div class="forecast-hover-card"></div><div class="forecast-scale"><span>${state.metric === 'wind' ? 'Lower planning bound' : meta.label}</span><b>${windowRows[0]?.date || '—'} to ${windowRows[windowRows.length - 1]?.date || '—'}</b><span>${state.metric === 'wind' ? 'Upper planning bound' : meta.unit}</span></div></section><section class="table-panel prediction-table"><div class="section-heading"><div><p class="eyebrow">EIGHT-SITE FORECAST REGISTER</p><h3>Forecasts trained and validated per wind point</h3></div><span>Latest observation ${activePrediction().training.latest_observation}</span></div><table><thead><tr><th>Wind point</th><th>Source folder</th><th>Logger</th><th>Selected model</th><th>Last measured wind</th><th>Forecast wind</th><th>Air density</th><th>Estimated energy</th></tr></thead><tbody>${pointRows.map(point => `<tr><td>${point.name}</td><td>${point.source_folder}</td><td>${point.source_id}</td><td>${point.forecastModel}</td><td>${fmt(point.average_wind_speed, 2)} m/s</td><td>${fmt(point.forecastWind, 2)} m/s</td><td>${fmt(point.forecastDensity, 4)} kg/m3</td><td>${fmt(point.forecastEnergy, 2)} MWh</td></tr>`).join('')}</tbody></table></section>`;
      host!.dataset.predictionEnhanced = 'true';
      bind();
    };

    const bind = () => {
      host!.querySelector<HTMLSelectElement>('.prediction-horizon')!.onchange = event => { state.horizon = Number((event.target as HTMLSelectElement).value); draw(); };
      host!.querySelector<HTMLSelectElement>('.prediction-source')!.onchange = event => { state.source = (event.target as HTMLSelectElement).value as SourceMode; draw(); };
      host!.querySelector<HTMLSelectElement>('.prediction-metric')!.onchange = event => { state.metric = (event.target as HTMLSelectElement).value as PredictionMetric; draw(); };
      host!.querySelector<HTMLSelectElement>('.prediction-scope')!.onchange = event => { state.scope = (event.target as HTMLSelectElement).value; draw(); };
      host!.querySelector<HTMLButtonElement>('.prediction-daily')!.onclick = event => openDailyPredictions(event.currentTarget as HTMLButtonElement);
      const tip = host!.querySelector<HTMLElement>('.forecast-hover-card')!;
      host!.querySelectorAll<HTMLElement>('.forecast-bars span').forEach(bar => {
        bar.onmouseenter = () => {
          tip.innerHTML = `<b>${bar.dataset.date}</b><span>Forecast: ${bar.dataset.value} ${bar.dataset.unit}</span><span>Planning range: ${bar.dataset.low}–${bar.dataset.high} ${bar.dataset.unit}</span>`;
          tip.classList.add('visible');
          tip.style.left = `${Math.max(8, Math.min(host!.clientWidth - 220, bar.offsetLeft))}px`;
        };
        bar.onmouseleave = () => tip.classList.remove('visible');
      });
      host!.querySelector<HTMLButtonElement>('.prediction-save')!.onclick = event => saveReport(event.currentTarget as HTMLButtonElement);
      const exportSelect = host!.querySelector<HTMLSelectElement>('.prediction-export-format')!;
      exportSelect.onchange = () => { state.exportFormat = exportSelect.value as 'pdf' | 'csv'; };
      host!.querySelector<HTMLButtonElement>('.prediction-export')!.onclick = async event => {
        const button = event.currentTarget as HTMLButtonElement;
        if (state.exportFormat === 'csv') exportCsv();
        else await exportPdf(button);
      };
    };
    draw();
  } finally {
    delete host.dataset.predictionLoading;
  }
};

document.addEventListener('click', event => {
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
  if (link && new URL(link.href, window.location.href).pathname !== '/predictions') dispose();
}, true);
window.addEventListener('popstate', dispose);
window.addEventListener('zetdc:route-ready', () => { dispose(); enhance().catch(() => undefined); });
setInterval(() => { dispose(); enhance().catch(() => undefined); }, 5000);

export {};
