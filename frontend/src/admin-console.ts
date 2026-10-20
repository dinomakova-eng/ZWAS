import './admin-console.css';
import './admin-drilldown.css';
import {getApiData} from './data-client';
import {navigateApp} from './navigation';

const API = '/api';
const fmt = (value: number, digits = 2) => new Intl.NumberFormat('en-US', {maximumFractionDigits: digits}).format(value);

type AdminUser = {ec_number: string; name: string; email: string; phone: string; department: string; position: string; company: string; role: string; status: string; last_login: string};
type Point = {id: number; name: string; source_folder: string; source_id: string; province: string; region: string; district: string; locality: string; status: string; reading_count: number; source_file_count: number; first_reading_at: string; last_reading_at: string; average_wind_speed: number; latest_temperature: number; shared_logger_folders: string[]};
type WindEnergySettings = {blade_radius_m: number; power_coefficient: number; system_efficiency: number; sample_interval_minutes: number; tariff_usd_per_mwh: number; cap_to_capacity: boolean; rotor_swept_area_m2: number; formula: string; energy_formula: string; source_note: string};

const modules = [
  ['dashboard', 'Dashboard', '◫'], ['points', 'Wind points', '◉'], ['data', 'Source data', '▥'],
  ['forecast', 'Forecast model', '✦'], ['energy', 'Wind energy', 'ρ'], ['users', 'Users', '♙'],
] as const;

const status = (value: string) => `<span class="admin-pill ${value.toLowerCase()}">${value}</span>`;

const userModal = () => `<section class="admin-modal-backdrop"><form class="admin-modal" data-user-form><div class="admin-panel-heading"><div><p class="eyebrow">IDENTITY AND ACCESS</p><h2>Create user</h2></div><button type="button" class="admin-close">×</button></div><div class="admin-form-grid"><label>Full name<input name="name" required></label><label>Employee number<input name="ec_number" required></label><label>Email<input name="email" type="email" required></label><label>Phone<input name="phone"></label><label>Department<input name="department"></label><label>Position<input name="position"></label><label>Company<input name="company" value="ZESA"></label><label>Role<select name="role"><option>Guest</option><option>Data Analyst</option><option>System Administrator</option></select></label></div><div class="admin-save-row"><span>The new account is created in the active backend session.</span><button>Create user</button></div></form></section>`;

const enhance = async () => {
  if (window.location.pathname !== '/admin') return;
  const host = document.querySelector<HTMLElement>('.workspace .content.admin-host');
  const auth = JSON.parse(localStorage.getItem('zetdc-auth') || '{}');
  if (!host || !auth.t || host.dataset.loading || host.dataset.enhanced) return;
  host.dataset.loading = 'true';
  try {
    const headers = {Authorization: `Bearer ${auth.t}`};
    const [metrics, sourcePoints, initialUsers, forecast, initialWindEnergy] = await Promise.all([
      getApiData<any>('/metrics', auth.t),
      getApiData<Point[]>('/turbines', auth.t),
      getApiData<AdminUser[]>('/admin/users', auth.t),
      getApiData<any>('/predictions?days=30', auth.t),
      getApiData<WindEnergySettings>('/admin/wind-energy', auth.t),
    ]);
    if (window.location.pathname !== '/admin') return;
    const points: Point[] = sourcePoints;
    let users: AdminUser[] = initialUsers;
    let windEnergy: WindEnergySettings = initialWindEnergy;
    let active = 'dashboard';
    let dark = false;
    let collapsed = false;

    const dashboard = () => {
      const fleet = metrics.fleet;
      return `<section class="admin-content-heading admin-dashboard-heading"><div><p class="eyebrow">MEASURED-DATA ADMINISTRATION</p><h1>Administration dashboard</h1><p>Current source, forecast, and access status for the eight imported wind points.</p></div></section><section class="admin-kpi-grid"><article><small>Reporting points</small><strong>${fleet.reporting_points} / ${points.length}</strong><span>${fleet.records.toLocaleString()} latest-day records</span></article><article><small>Measured wind</small><strong>${fleet.average_wind_speed} m/s</strong><span>${fleet.min_wind_speed}–${fleet.max_wind_speed} m/s</span></article><article><small>Data quality</small><strong>${fleet.data_quality_pct}%</strong><span>logger sample completeness</span></article><article><small>Estimated power</small><strong>${fmt(fleet.current_power_output_kw / 1000, 3)} MW</strong><span>wind energy formula</span></article></section><section class="admin-dashboard-grid"><article class="admin-fleet-card"><div class="admin-panel-heading"><div><p class="eyebrow">SOURCE PORTFOLIO</p><h2>Wind measurement network</h2></div><button data-module="points">View points</button></div><dl><div><dt>Archive</dt><dd>${metrics.source.archive}</dd></div><div><dt>CSV files</dt><dd>${metrics.source.csv_file_count}</dd></div><div><dt>Total normalized records</dt><dd>${points.reduce((total, point) => total + point.reading_count, 0).toLocaleString()}</dd></div><div><dt>Latest observation</dt><dd>${fleet.last_reading_at.slice(0, 10)}</dd></div><div><dt>Average temperature</dt><dd>${fleet.average_temperature_c} °C</dd></div><div><dt>Average humidity</dt><dd>${fleet.average_humidity_pct}%</dd></div></dl></article><article class="admin-ai-card"><div class="admin-panel-heading"><div><p class="eyebrow">FORECAST STATUS</p><h2>Measured baseline</h2></div><button data-module="forecast">Model details</button></div><div class="admin-ai-metrics"><div><strong>1</strong><span>data-driven model</span></div><div><strong>${forecast.backtest_mae}</strong><span>backtest MAE m/s</span></div><div><strong>${forecast.training.daily_site_records}</strong><span>daily site records</span></div><div><strong>${forecast.training.wind_points}</strong><span>wind points trained</span></div></div><p>${forecast.model_version} · observations through ${forecast.training.latest_observation}.</p></article></section>`;
    };
    const pointTable = () => `<section class="admin-content-heading"><div><p class="eyebrow">SOURCE REGISTER</p><h1>Wind-point management</h1><p>Identity and latest measurement status from all eight archive folders.</p></div></section><section class="admin-table-card"><table><thead><tr><th>Wind point</th><th>Folder / logger</th><th>Records</th><th>Measured wind</th><th>Latest record</th><th>Status</th></tr></thead><tbody>${points.map(point => `<tr><td><b>${point.name}</b><small>${point.locality}</small></td><td>${point.source_folder}<small>${point.source_id}</small></td><td>${point.reading_count.toLocaleString()}</td><td>${fmt(point.average_wind_speed)} m/s</td><td>${point.last_reading_at.slice(0, 16).replace('T', ' ')}</td><td>${status(point.status)}</td></tr>`).join('')}</tbody></table></section>`;
    const dataView = () => `<section class="admin-content-heading"><div><p class="eyebrow">DATA PROVENANCE</p><h1>Source-data administration</h1><p>Import coverage, transformations, duplicates, and measurement provenance.</p></div></section><section class="admin-card-grid"><article><small>Source archive</small><strong>${metrics.source.archive}</strong><span>SHA-256 ${metrics.source.sha256.slice(0, 12)}…</span></article><article><small>Folders / CSV files</small><strong>${metrics.source.folder_count} / ${metrics.source.csv_file_count}</strong><span>validated during import</span></article><article><small>Normalized readings</small><strong>${points.reduce((total, point) => total + point.reading_count, 0).toLocaleString()}</strong><span>${points.reduce((total, point) => total + point.source_file_count, 0)} source files</span></article></section><section class="admin-table-card"><table><thead><tr><th>Folder</th><th>Logger</th><th>First record</th><th>Last record</th><th>CSV files</th><th>Duplicate logger</th></tr></thead><tbody>${points.map(point => `<tr><td>${point.source_folder}</td><td>${point.source_id}</td><td>${point.first_reading_at.slice(0, 10)}</td><td>${point.last_reading_at.slice(0, 10)}</td><td>${point.source_file_count}</td><td>${point.shared_logger_folders.length ? `Shared with ${point.shared_logger_folders.join(', ')}` : 'No'}</td></tr>`).join('')}</tbody></table></section>`;
    const forecastView = () => `<section class="admin-content-heading"><div><p class="eyebrow">MODEL PROVENANCE</p><h1>Forecast administration</h1><p>The forecast now retrains from the current imported dataset on every API process start.</p></div></section><section class="admin-card-grid"><article><small>Model version</small><strong>${forecast.model_version}</strong><span>transparent baseline</span></article><article><small>Training points</small><strong>${forecast.training.wind_points}</strong><span>all wind points</span></article><article><small>Daily site records</small><strong>${forecast.training.daily_site_records}</strong><span>aggregated measurements</span></article><article><small>Backtest MAE</small><strong>${forecast.backtest_mae} m/s</strong><span>holdout error</span></article></section><section class="admin-workspace-card"><div><p class="eyebrow">MODEL BASIS</p><h2>Measured weekday profile</h2><p>${forecast.model_basis}. Forecasts begin ${forecast.training.forecast_start}, after the latest imported observation on ${forecast.training.latest_observation}.</p></div><div class="admin-action-grid"><button data-route="/predictions">Open predictions<span>→</span></button><button data-route="/reports/analytics">Review analytics<span>→</span></button></div></section>`;
    const energyView = () => `<section class="admin-content-heading"><div><p class="eyebrow">WIND ENERGY FORMULA</p><h1>Formula settings</h1><p>${windEnergy.source_note}</p></div></section><section class="admin-card-grid"><article><small>Formula</small><strong>0.5 × rho × A × v³ × Cp</strong><span>power output in kW after efficiency</span></article><article><small>Rotor swept area</small><strong>${fmt(windEnergy.rotor_swept_area_m2, 1)} m²</strong><span>A = π × radius²</span></article><article><small>Sample interval</small><strong>${fmt(windEnergy.sample_interval_minutes, 1)} min</strong><span>used for ZETDC mast energy</span></article></section><section class="admin-workspace-card admin-energy-card"><form data-energy-form><div class="admin-panel-heading"><div><p class="eyebrow">CALCULATION INPUTS</p><h2>Estimated energy constants</h2></div><button>Save formula</button></div><div class="admin-form-grid"><label>Blade radius (m)<input name="blade_radius_m" type="number" step="0.1" min="0.1" value="${windEnergy.blade_radius_m}"></label><label>Power coefficient Cp<input name="power_coefficient" type="number" step="0.001" min="0" max="0.593" value="${windEnergy.power_coefficient}"></label><label>System efficiency<input name="system_efficiency" type="number" step="0.01" min="0" max="1" value="${windEnergy.system_efficiency}"></label><label>ZETDC sample interval (minutes)<input name="sample_interval_minutes" type="number" step="1" min="1" value="${windEnergy.sample_interval_minutes}"></label><label>Tariff USD per MWh<input name="tariff_usd_per_mwh" type="number" step="0.01" min="0" value="${windEnergy.tariff_usd_per_mwh}"></label><label class="admin-toggle-row"><span>Cap power to assessment capacity</span><input name="cap_to_capacity" type="checkbox" ${windEnergy.cap_to_capacity ? 'checked' : ''}></label></div><div class="admin-save-row"><span>Uses measured wind speed, calculated air density, rotor area, Cp, and efficiency.</span><em class="admin-energy-message"></em></div></form></section>`;
    const usersView = () => `<section class="admin-content-heading"><div><p class="eyebrow">IDENTITY AND ACCESS</p><h1>User management</h1><p>Backend user records; independent of wind telemetry imports.</p></div><button data-action="create-user">Create user</button></section><section class="admin-user-summary"><article><small>Total users</small><strong>${users.length}</strong><span>directory records</span></article><article><small>Active users</small><strong>${users.filter(user => user.status === 'Active').length}</strong><span>enabled accounts</span></article></section><section class="admin-table-card"><table><thead><tr><th>User</th><th>Employee no.</th><th>Department</th><th>Role</th><th>Status</th><th>Last login</th></tr></thead><tbody>${users.map(user => `<tr><td><b>${user.name}</b><small>${user.email}</small></td><td>${user.ec_number}</td><td>${user.department || '—'}</td><td>${user.role}</td><td>${status(user.status)}</td><td>${user.last_login}</td></tr>`).join('')}</tbody></table></section>`;

    const render = () => {
      const view = active === 'dashboard' ? dashboard() : active === 'points' ? pointTable() : active === 'data' ? dataView() : active === 'forecast' ? forecastView() : active === 'energy' ? energyView() : usersView();
      host!.innerHTML = `<section class="admin-console ${collapsed ? 'collapsed' : ''} ${dark ? 'admin-dark' : ''}"><aside class="admin-side"><div class="admin-side-brand"><span>ADMIN CONSOLE</span><button data-action="collapse">☰</button></div><nav>${modules.map(([id, label, icon]) => `<button class="${active === id ? 'active' : ''}" data-module="${id}"><i>${icon}</i><span>${label}</span></button>`).join('')}</nav></aside><section class="admin-main"><header class="admin-topbar"><label class="admin-search">⌕<input placeholder="Search modules" disabled></label><div class="admin-top-actions"><button data-action="theme">${dark ? '☀' : '◐'}</button><button class="admin-profile"><i>FM</i><span>Farai Makova<small>System Administrator</small></span></button></div></header><div class="admin-health"><span class="good-dot"></span> Source data connected · ${points.length} points · ${metrics.source.csv_file_count} CSV files</div><main class="admin-body">${view}</main></section></section>`;
      host!.dataset.enhanced = 'true';
      bind();
    };
    const bind = () => {
      host!.querySelectorAll<HTMLElement>('[data-module]').forEach(button => button.onclick = () => { active = button.dataset.module || 'dashboard'; render(); });
      host!.querySelectorAll<HTMLButtonElement>('[data-route]').forEach(button => button.onclick = () => navigateApp(button.dataset.route || '/'));
      host!.querySelector<HTMLButtonElement>('[data-action="collapse"]')!.onclick = () => { collapsed = !collapsed; render(); };
      host!.querySelector<HTMLButtonElement>('[data-action="theme"]')!.onclick = () => { dark = !dark; render(); };
      host!.querySelector<HTMLFormElement>('[data-energy-form]')?.addEventListener('submit', async event => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const data = new FormData(form);
        const payload = {
          blade_radius_m: Number(data.get('blade_radius_m')),
          power_coefficient: Number(data.get('power_coefficient')),
          system_efficiency: Number(data.get('system_efficiency')),
          sample_interval_minutes: Number(data.get('sample_interval_minutes')),
          tariff_usd_per_mwh: Number(data.get('tariff_usd_per_mwh')),
          cap_to_capacity: data.has('cap_to_capacity'),
        };
        const message = form.querySelector<HTMLElement>('.admin-energy-message');
        const response = await fetch(`${API}/admin/wind-energy`, {method: 'PUT', headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
        if (response.ok) {
          windEnergy = await response.json();
          if (message) message.textContent = 'Formula saved. Energy metrics will use the new constants on refresh.';
          setTimeout(render, 700);
        } else if (message) {
          message.textContent = 'Formula settings could not be saved.';
        }
      });
      host!.querySelector<HTMLButtonElement>('[data-action="create-user"]')?.addEventListener('click', () => {
        host!.insertAdjacentHTML('beforeend', userModal());
        const modal = host!.querySelector<HTMLElement>('.admin-modal-backdrop')!;
        modal.querySelector<HTMLButtonElement>('.admin-close')!.onclick = () => modal.remove();
        modal.querySelector<HTMLFormElement>('[data-user-form]')!.onsubmit = async event => {
          event.preventDefault();
          const payload = Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement));
          const response = await fetch(`${API}/admin/users`, {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
          if (response.ok) { users = [...users, await response.json()]; modal.remove(); render(); }
        };
      });
    };
    render();
  } finally {
    delete host.dataset.loading;
  }
};

window.addEventListener('zetdc:route-ready', () => { enhance().catch(() => undefined); });
setInterval(() => { enhance().catch(() => undefined); }, 5000);

export {};
