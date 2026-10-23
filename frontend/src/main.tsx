import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Activity, BarChart3, Bolt, Copy, Download, History as HistoryIcon, LayoutDashboard, LogOut, Mail, MapPin, RefreshCw, Settings, Share2, Sparkles, Wind, X } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import './zimbabwe-outline.css';
import './dark-workspace.css';
import './report-tabs.css';
import './zesa-light.css';
import './zesa-brand-identity.css';
import './overview-header.css';
import './summary-drilldown.css';
import './turbine-contrast.css';
import './wind-point-detail.css';
import './history.css';
import './osm-fleet-map.css';
import './grid-voltage-lines.css';
import './login-osm-map.css';
import './login-turbines.css';
import './login-osm-boundary.css';
import './summary-tab-states.css';
import './map-visibility.css';
import './map-size-reset.css';
import './map-containment.css';
import './summary-tabs-light-grey.css';
import './summary-detail-contrast.css';
import './rounded-surfaces.css';
import './report-export-menu.css';
import './report-comparison.css';
import './universal-save.css';
import './logo-home.css';
import './reports-layout.css';
import './report-actions.css';
import './multi-comparison.css';
import './visualization-colors.css';
import './default-reports.css';
import './default-report-detail.css';
import './custom-report-selector.css';
import './prediction-workspace';
import './admin-console';
import './business-intelligence';
import './reports-workspace';
import './comparison-workspace';
import './compact-page-headers.css';
import './environment-module.css';
import {getApiData, clearApiCache, refreshLiveData} from './data-client';
import {navigateApp} from './navigation';
import {EnvironmentModule} from './environment-module';
const initOsmFleetMap = async () => {
    const target = document.querySelector<HTMLElement>('.zimbabwe:not([data-osm-map])');
    if (!target)
        return;
    target.dataset.osmMap = 'true';
    const auth = localStorage.getItem('zetdc-auth');
    if (!auth)
        return;
    const { t } = JSON.parse(auth);
    const [regions, turbines, live] = await Promise.all([
        fetch('/gis/zetdc-regions.geojson').then(response => response.json()),
        getApiData<any[]>('/turbines', t),
        getApiData<any>('/live-wind', t).catch(() => null),
    ]);
    target.innerHTML = '';
    const map = L.map(target, {
        zoomControl: false,
        attributionControl: true,
        scrollWheelZoom: false,
        zoomSnap: .25,
        preferCanvas: true,
    }).setView([-19.02, 29.15], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors' }).addTo(map);
    const regionColors: Record<string, string> = {
        'EASTERN REGION': '#29a3d8', 'WESTERN REGION': '#d8a52b', 'SOUTHERN REGION': '#31a36f',
        'NORTHERN REGION': '#8465c4', 'HARARE REGION': '#d96767',
    };
    const regionLayer = L.geoJSON(regions, {
        style: feature => ({
            color: '#075b9e', weight: 2, opacity: .9,
            fillColor: regionColors[String(feature?.properties?.province)] || '#63c6f4', fillOpacity: .22,
        }),
    }).addTo(map);
    // Keep Zimbabwe central without cropping the surrounding country context.
    map.fitBounds(regionLayer.getBounds(), { padding: [36, 36], maxZoom: 6 });
    const bindHoverPopup = (layer: any) => {
        let active = false;
        let closeTimer: number | undefined;
        const connectedPopups = new WeakSet<HTMLElement>();
        const cancelClose = () => {
            if (closeTimer !== undefined) window.clearTimeout(closeTimer);
            closeTimer = undefined;
        };
        const enter = () => {
            active = true;
            cancelClose();
            layer.openPopup();
        };
        const leave = () => {
            active = false;
            cancelClose();
            closeTimer = window.setTimeout(() => {
                if (!active) layer.closePopup();
            }, 160);
        };
        layer
            .on('mouseover', enter)
            .on('mouseout', leave)
            .on('popupopen', (event: any) => {
                const popup = event.popup.getElement() as HTMLElement | null;
                if (!popup || connectedPopups.has(popup)) return;
                connectedPopups.add(popup);
                popup.addEventListener('mouseenter', enter);
                popup.addEventListener('mouseleave', leave);
            })
            .on('popupclose', cancelClose);
        return {isActive: () => active};
    };
    let gridLayer: L.GeoJSON | null = null;
    let gridData: any | null = null;
    let gridEnabled = false;
    let gridLoading = false;
    let nearestLines: L.LayerGroup | null = null;
    const escapeHtml = (value: unknown) => String(value ?? '—').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]!));
    const distanceText = (meters: number) => meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
    const gridStats = {station: 0, transformer: 0, overhead: 0, cable: 0};
    const controlEl = document.createElement('div');
    controlEl.className = 'zesa-grid-control';
    controlEl.innerHTML = `<div class="grid-button-row"><button type="button" class="grid-toggle">ZESA Grid Infrastructure</button></div><div class="grid-measure-status">Select a wind point to see the nearest substation and grid infrastructure.</div><div class="grid-key"><b>Key</b><span><i class="wind"></i>Wind asset</span><span><i class="station"></i>Substation / station</span><span><i class="transformer"></i>Transformer</span><span><i class="overhead overhead-11"></i>11 kV overhead</span><span><i class="overhead overhead-33"></i>33 kV overhead</span><span><i class="overhead overhead-high"></i>88–330 kV overhead</span><span><i class="cable"></i>Underground cable</span></div>`;
    const mapLayout = target.closest<HTMLElement>('.map-layout');
    mapLayout?.after(controlEl);
    const setMeasureStatus = (message: string) => {
        const status = controlEl.querySelector<HTMLElement>('.grid-measure-status');
        if (status) status.textContent = message;
    };
    const clearNearestLines = () => {
        nearestLines?.remove();
        nearestLines = null;
    };
    const gridColor = (type: string, voltage = 0) => {
        if (type === 'overhead' && voltage === 11) return '#e6a700';
        if (type === 'overhead' && voltage === 33) return '#e85d27';
        return ({station: '#df4b3f', transformer: '#7b52d6', overhead: '#1f7a4d', cable: '#2563eb'}[type] || '#111827');
    };
    const gridPopup = (props: any) => {
        const type = String(props.asset_type || 'grid asset').replace('_', ' ');
        const voltage = props.voltage_kv ? `${props.voltage_kv} kV` : 'Voltage not listed';
        const capacity = props.capacity_kva ? `${Number(props.capacity_kva).toLocaleString()} kVA` : props.capacity ? `${props.capacity} capacity` : '';
        const spans = Number(props.segment_count || 0);
        return `<strong>${escapeHtml(props.label)}</strong><br/>${escapeHtml(type.toUpperCase())}<br/>Voltage: <b>${escapeHtml(voltage)}</b>${spans ? `<br/>Mapped spans: <b>${spans.toLocaleString()}</b>` : ''}${capacity ? `<br/>Capacity: <b>${escapeHtml(capacity)}</b>` : ''}<br/>Status: <b>${escapeHtml(props.status)}</b><br/>Region: <b>${escapeHtml(props.region)}</b>`;
    };
    const toggleButton = controlEl.querySelector<HTMLButtonElement>('.grid-toggle')!;
    const updateGridControl = () => {
        toggleButton.classList.toggle('active', gridEnabled);
        toggleButton.textContent = gridLoading ? 'Loading grid...' : gridEnabled ? 'Hide ZESA Grid Infrastructure' : 'ZESA Grid Infrastructure';
        controlEl.classList.toggle('expanded', gridEnabled);
    };
    const loadGridData = async () => {
        if (gridData) return gridData;
        gridLoading = true;
        updateGridControl();
        gridData = await fetch('/gis/zesa-grid-infrastructure.geojson').then(response => response.json());
        gridLoading = false;
        updateGridControl();
        return gridData;
    };
    type NearestGridFeature = {feature: any; latlng: L.LatLng; distance: number};
    const nearestFeature = (from: L.LatLng, predicate: (props: any) => boolean): NearestGridFeature | null => {
        const features = gridData?.features || [];
        let best: NearestGridFeature | null = null;
        for (const feature of features) {
            const props = feature.properties || {};
            if (!predicate(props)) continue;
            const lat = Number(props.measure_lat);
            const lon = Number(props.measure_lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            const latlng = L.latLng(lat, lon);
            const distance = map.distance(from, latlng);
            if (!best || distance < best.distance) best = {feature, latlng, distance};
        }
        return best;
    };
    const nearestSummary = async (asset: any) => {
        await loadGridData();
        const from = L.latLng(asset.lat, asset.lon);
        const station = nearestFeature(from, props => props.asset_type === 'station');
        const transformer = nearestFeature(from, props => props.asset_type === 'transformer');
        clearNearestLines();
        const layers: L.Layer[] = [];
        if (station) layers.push(L.polyline([from, station.latlng], {color: gridColor('station'), weight: 4, dashArray: '8 6', opacity: .95}));
        if (transformer) layers.push(L.polyline([from, transformer.latlng], {color: gridColor('transformer'), weight: 4, dashArray: '2 7', opacity: .95}));
        nearestLines = L.layerGroup(layers).addTo(map);
        const stationLabel = station ? `${escapeHtml(station.feature.properties.label)} <b>${distanceText(station.distance)}</b>` : 'No station found';
        const transformerLabel = transformer ? `${escapeHtml(transformer.feature.properties.label)} <b>${distanceText(transformer.distance)}</b>` : 'No transformer found';
        setMeasureStatus(`${asset.name}: nearest substation ${station ? distanceText(station.distance) : 'not found'}; nearest transformer ${transformer ? distanceText(transformer.distance) : 'not found'}.`);
        return `<br/><hr/><b>Nearest substation:</b><br/>${stationLabel}<br/><b>Nearest transformer:</b><br/>${transformerLabel}`;
    };
    const loadGridLayer = async () => {
        if (gridLayer) return gridLayer;
        const grid = await loadGridData();
        gridLayer = L.geoJSON(grid, {
            pane: 'overlayPane',
            style: (feature: any) => {
                const type = String(feature?.properties?.asset_type || '');
                const voltage = Number(feature?.properties?.voltage_kv || 0);
                const color = gridColor(type, voltage);
                if (type === 'station') return {color, weight: 3, opacity: 1, fillColor: color, fillOpacity: .42};
                if (type === 'overhead' && voltage === 11) return {color, weight: 1.1, opacity: .7};
                if (type === 'overhead' && voltage === 33) return {color, weight: 1.7, opacity: .84};
                return {color, weight: type === 'overhead' ? 3.2 : 4.2, opacity: type === 'cable' ? .88 : .95, dashArray: type === 'cable' ? '8 5' : undefined};
            },
            pointToLayer: (feature: any, latlng) => {
                const type = String(feature?.properties?.asset_type || '');
                return L.circleMarker(latlng, {
                    radius: type === 'transformer' ? 6 : 7,
                    color: '#ffffff',
                    weight: 2,
                    fillColor: gridColor(type, Number(feature?.properties?.voltage_kv || 0)),
                    fillOpacity: .98,
                });
            },
            onEachFeature: (feature: any, layer) => {
                const props = feature.properties || {};
                const type = String(props.asset_type || '');
                gridStats[type as keyof typeof gridStats] = (gridStats[type as keyof typeof gridStats] || 0) + Number(props.segment_count || 1);
                const lat = Number(props.measure_lat);
                const lon = Number(props.measure_lon);
                const label = String(props.label || type || 'Grid asset');
                layer.bindPopup(gridPopup(props), {autoPan: true});
                bindHoverPopup(layer);
                layer.on('click', () => {
                    if (Number.isFinite(lat) && Number.isFinite(lon)) setMeasureStatus(`${label} selected.`);
                });
            },
        });
        controlEl.querySelector<HTMLElement>('.grid-key')?.insertAdjacentHTML('beforeend', `<small>${gridStats.station.toLocaleString()} stations · ${gridStats.transformer.toLocaleString()} transformers · ${gridStats.overhead.toLocaleString()} overhead spans · ${gridStats.cable.toLocaleString()} cable routes</small>`);
        updateGridControl();
        return gridLayer;
    };
    toggleButton.onclick = async () => {
        if (gridLoading) return;
        if (!gridEnabled) {
            const layer = await loadGridLayer();
            layer.addTo(map);
            gridEnabled = true;
            setMeasureStatus('Select a wind point to see nearest grid infrastructure.');
        } else {
            gridLayer?.remove();
            gridEnabled = false;
            clearNearestLines();
            map.closePopup();
        }
        updateGridControl();
    };
    turbines.forEach((asset: any) => {
        const wind = Number(asset.average_wind_speed || 0).toFixed(2);
        const stddev = Number(asset.wind_speed_stddev || 0).toFixed(2);
        const direction = Number(asset.latest_wind_direction || 0).toFixed(0);
        const icon = L.divIcon({ className: 'osm-turbine-marker', html: '<img src="/turbine-marker.svg" alt=""/>', iconSize: [34, 52], iconAnchor: [17, 45] });
        const basePopup = `<strong>${asset.name}</strong><br/>${asset.region}<br/>District: <b>${asset.district}</b><br/>Measured wind: <b>${wind} m/s</b><br/>Wind variability: <b>${stddev} m/s σ</b><br/>Wind direction: <b>${direction}°</b><br/>Logger: <b>${asset.source_id}</b><br/><a href="/turbines/${asset.id}">Open Wind Point</a>`;
        const marker = L.marker([asset.lat, asset.lon], { icon }).addTo(map).bindPopup(basePopup, { autoPan: true, offset: [0, -8] });
        const hoverPopup = bindHoverPopup(marker);
        marker.on('click', async () => {
            if (!gridEnabled) {
                const layer = await loadGridLayer();
                layer.addTo(map);
                gridEnabled = true;
                updateGridControl();
            }
            marker.setPopupContent(basePopup + await nearestSummary(asset));
            if (hoverPopup.isActive()) marker.openPopup();
        });
    });
    (live?.stations || []).forEach((asset: any) => {
        const wind = Number(asset.latest_wind_speed || 0).toFixed(2);
        const stddev = Number(asset.wind_speed_stddev || 0).toFixed(2);
        const density = Number(asset.latest_air_density || 0).toFixed(4);
        const direction = Number(asset.latest_wind_direction || 0).toFixed(0);
        const marker = L.circleMarker([asset.lat, asset.lon], {
            radius: 8,
            color: '#d49e16',
            weight: 2,
            fillColor: '#fff3cd',
            fillOpacity: .9,
        }).addTo(map).bindPopup(
            `<strong>${asset.name}</strong><br/>Live Wind Maps Data<br/>Open-Meteo wind: <b>${wind} m/s</b><br/>Daily wind variability: <b>${stddev} m/s σ</b><br/>Wind direction: <b>${direction}°</b><br/>Air density: <b>${density} kg/m3</b><br/>Updated: <b>${String(asset.last_reading_at).slice(0, 16)}</b>`,
            { autoPan: true, offset: [0, -8] },
        );
        bindHoverPopup(marker);
    });
};
window.addEventListener('zetdc:route-ready', () => { initOsmFleetMap().catch(() => undefined); });
const initLoginOsmMap = async () => {
    const target = document.querySelector<HTMLElement>('.login .zim-outline:not([data-osm-map])');
    if (!target)
        return;
    const boundary = await fetch('/zimbabwe-osm-boundary.geojson').then(response => response.json());
    target.dataset.osmMap = 'true';
    target.innerHTML = '';
    const map = L.map(target, {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        keyboard: false,
    });
    const outline = L.geoJSON(boundary, {
        style: {
            className: 'login-zimbabwe-boundary',
            color: '#61d5ff',
            weight: 2.5,
            fillColor: '#2e98df',
            fillOpacity: 0.16,
        },
    }).addTo(map);
    map.fitBounds(outline.getBounds(), { padding: [12, 12] });
    const turbineIcon = L.divIcon({
        className: 'login-turbine-marker',
        html: '<div class="login-map-turbine" aria-hidden="true"><div class="login-map-rotor"><span></span><i></i><b></b></div><em></em></div>',
        iconSize: [44, 62],
        iconAnchor: [22, 55],
    });
    const turbinePoints: L.LatLngTuple[] = [[-19.517, 29.467], [-16.501, 31.545], [-16.321, 31.68], [-16.514, 30.655], [-16.65, 30.814], [-20.652, 28.072], [-20.402, 27.891], [-18.953, 30.956]];
    turbinePoints.forEach(point => L.marker(point, { icon: turbineIcon }).addTo(map));
    const pylonIcon = L.divIcon({ className: 'login-pylon-marker', html: '<div class="login-map-pylon"><i></i><b></b><em></em></div>', iconSize: [14, 26], iconAnchor: [7, 24] });
    const pylons: L.LatLngTuple[] = [[-17.92, 29.55], [-18.88, 31.06], [-20.78, 30.18]];
    pylons.forEach(point => L.marker(point, { icon: pylonIcon, interactive: false }).addTo(map));
    const cableStyle = {color: '#68dcff', weight: 1.6, opacity: .92, className: 'login-transmission-cable', interactive: false};
    L.polyline(pylons, cableStyle).addTo(map);
    [[turbinePoints[0], pylons[1]], [turbinePoints[1], pylons[0]], [turbinePoints[2], pylons[1]], [turbinePoints[3], pylons[1]], [turbinePoints[4], pylons[2]], [turbinePoints[5], pylons[1]], [turbinePoints[6], pylons[2]], [turbinePoints[7], pylons[0]]].forEach(path => L.polyline(path, cableStyle).addTo(map));
    requestAnimationFrame(() => map.invalidateSize());
};
const API = '/api';
type User = {
    name: string;
    role: string;
    ec_number: string;
};
const fetchApi = (path: string, token: string) => getApiData<any>(path, token);
document.addEventListener('click', event => { const pin = (event.target as HTMLElement).closest('.pin'); if (pin) {
    const id = [...document.querySelectorAll('.pin')].indexOf(pin) + 1;
    navigateApp('/turbines/' + id);
} });
document.addEventListener('click', event => { if ((event.target as HTMLElement).closest('.logo'))
    navigateApp('/'); });
function Login({ onLogin }: {
    onLogin: (u: User, t: string) => void;
}) { useEffect(() => { initLoginOsmMap().catch(() => undefined); }, []); const [ec, setEc] = useState('ze9160517'), [password, setPassword] = useState('ZETDC2026!'), [error, setError] = useState(''); const submit = async (e: React.FormEvent) => { e.preventDefault(); setError(''); try { const r = await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ec_number: ec.trim(), password }) }); if (!r.ok) {
    setError('The EC number or password is incorrect.');
    return;
} const d = await r.json(); onLogin(d.user, d.token); } catch {
    setError('The sign-in service is unavailable. Check that the system is running and try again.');
} }; const turbine = (className: string) => <div className={'login-turbine ' + className}><span /><i /><b /></div>; return <main className="login"><section className="login-brand"><div className="login-grid"/><div className="login-topline"><img src="/zesa-logo.png" alt="ZESA"/><span>ZIMBABWE ELECTRICITY SUPPLY AUTHORITY</span></div><div className="login-scene"><div className="zim-outline"><img className="zimbabwe-outline-image" src="/zimbabwe-outline.png" alt="Outline of Zimbabwe"/><span>Zimbabwe</span>{turbine('turbine-one')}{turbine('turbine-two')}{turbine('turbine-three')}</div><div className="signal signal-one"/><div className="signal signal-two"/></div><div className="login-copy"><p className="eyebrow">RENEWABLE ENERGY OPERATIONS</p><h1>Zesa Wind<br />Assessment System</h1><p>Measured visibility across Zimbabwe's wind assessment network.</p><div className="login-stat"><Bolt /><span>8 measured wind points</span><span className="dot"/><span>Measurement data loaded</span></div></div></section><form className="login-form" onSubmit={submit}><img className="form-logo" src="/zesa-logo.png" alt="ZESA crest"/><p className="eyebrow">SECURE OPERATIONS ACCESS</p><h2>Sign in to control</h2><label>EC Number<input value={ec} onChange={e => setEc(e.target.value)} autoComplete="username"/></label><label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password"/></label>{error && <p className="error">{error}</p>}<button>Sign in <span>→</span></button><p className="login-help">Authorised ZESA staff only<br />Use your assigned EC credentials</p></form></main>; }
function Layout({ user, token, onLogout }: {
    user: User;
    token: string;
    onLogout: () => void;
}) {
    const location = useLocation();
    const [liveRevision, setLiveRevision] = useState(0);
    const [liveRefreshState, setLiveRefreshState] = useState<'refreshing' | 'current' | 'error'>('refreshing');
    const compactPageHeader = location.pathname.startsWith('/reports') || location.pathname === '/predictions' || location.pathname === '/environment';
    useEffect(() => {
        const started = () => setLiveRefreshState('refreshing');
        const refreshed = () => {
            setLiveRefreshState('current');
            setLiveRevision(current => current + 1);
        };
        const failed = () => setLiveRefreshState('error');
        window.addEventListener('zetdc:live-data-refresh-started', started);
        window.addEventListener('zetdc:live-data-refreshed', refreshed);
        window.addEventListener('zetdc:live-data-refresh-error', failed);
        refreshLiveData(token, 'system_open').catch(() => undefined);
        return () => {
            window.removeEventListener('zetdc:live-data-refresh-started', started);
            window.removeEventListener('zetdc:live-data-refreshed', refreshed);
            window.removeEventListener('zetdc:live-data-refresh-error', failed);
        };
    }, [token]);
    useEffect(() => { window.dispatchEvent(new Event('zetdc:route-ready')); }, [location.pathname, liveRevision]);
    const liveStatus = liveRefreshState === 'refreshing'
        ? 'REFRESHING LIVE DATA'
        : liveRefreshState === 'error' ? 'CACHED LIVE DATA' : 'LIVE DATA CURRENT';
    return <div className="shell"><aside><div className="logo"><span><Wind /></span><b>ZESA</b><small>WIND ASSESSMENT SYSTEM</small></div><nav>
    <NavLink to="/"><LayoutDashboard /> Overview</NavLink><NavLink to="/environment"><MapPin /> Wind Map</NavLink><NavLink to="/reports"><BarChart3 /> Reports</NavLink><NavLink to="/predictions"><Sparkles /> Predictions</NavLink><NavLink to="/history"><HistoryIcon /> History</NavLink>{user.role === 'admin' && <NavLink to="/admin"><Settings /> Administration</NavLink>}
  </nav><div className="sidebar-foot"><div className="user-avatar">{user.name.split(' ').map(x => x[0]).join('')}</div><div><strong>{user.name}</strong><small>{user.role} · {user.ec_number}</small></div><button aria-label="Sign out" title="Sign out" onClick={onLogout}><LogOut size={18}/></button></div></aside><section className={`workspace${compactPageHeader ? ' compact-page-header' : ''}`}><header><div><p className="eyebrow">NATIONAL RENEWABLES OPERATIONS</p><h2>Wind Measurement Control</h2></div><div className={`live ${liveRefreshState}`}><i /> {liveStatus} <span>8 WIND POINTS</span></div></header><Routes>
    <Route path="/" element={<Dashboard key={liveRevision} token={token}/>}/><Route path="/environment" element={<EnvironmentModule key={liveRevision} token={token}/>}/><Route path="/summary/:focus" element={<SummaryDetail token={token} liveRevision={liveRevision}/>}/><Route path="/turbines/:id" element={<TurbineDetail token={token}/>}/><Route path="/reports" element={<ReportsWorkspace />}/><Route path="/reports/analytics" element={<Analytics />}/><Route path="/reports/compare" element={<Compare />}/><Route path="/predictions" element={<PredictionsWorkspace />}/><Route path="/history" element={<HistoryWorkspace token={token} liveRevision={liveRevision}/>}/><Route path="/admin" element={user.role === 'admin' ? <Admin key={liveRevision} token={token}/> : <Navigate to="/"/>}/>
  </Routes></section></div>;
}
function Dashboard({ token }: {
    token: string;
}) {
    const [data, setData] = useState<any>();
    const [selected, setSelected] = useState<any>();

    useEffect(() => {
        let active = true;
        Promise.all([fetchApi('/turbines', token), fetchApi('/metrics', token), fetchApi('/overview-summary', token)])
            .then(([t, m, overview]) => { if (active) setData({ t, m, overview }); });
        const refresh = window.setInterval(() => {
            getApiData<any>('/overview-summary', token, 0)
                .then(overview => { if (active) setData((current: any) => current ? { ...current, overview } : current); })
                .catch(() => undefined);
        }, 60 * 60 * 1000);
        return () => { active = false; window.clearInterval(refresh); };
    }, [token]);

    useEffect(() => {
        if (!data) return;
        const frame = window.requestAnimationFrame(() => { initOsmFleetMap().catch(() => undefined); });
        return () => window.cancelAnimationFrame(frame);
    }, [data]);

    if (!data) return <Loading />;

    const fleet = data.m.fleet;
    const mastMonth = data.overview.mast;
    const liveMonth = data.overview.live;
    const mastMonthLabel = formatReportMonth(mastMonth?.report_month);
    const liveMonthLabel = formatReportMonth(liveMonth?.report_month);
    const stats = [
        { label: 'Total wind points', value: String(data.t.length), note: 'active measurement sites', focus: 'fleet', icon: <Activity /> },
        { label: 'Fleet wind speed', value: `${Number(mastMonth?.average_wind_speed || 0).toFixed(2)} m/s`, note: `${mastMonthLabel} reported-month average`, focus: 'wind', icon: <Wind /> },
        { label: 'Data availability', value: `${fleet.uptime}%`, note: 'valid logger samples', focus: 'availability', icon: <Activity /> },
        { label: 'Live wind speed', value: liveMonth?.available ? `${Number(liveMonth.average_wind_speed).toFixed(2)} m/s` : 'Awaiting data', note: liveMonth?.available ? `${liveMonthLabel} month-to-date · daily refresh` : `${liveMonthLabel} · refreshes when online`, focus: 'live-wind', icon: <Wind /> },
    ];
    const turbineMetrics = (t: any) => ({
        wind: Number(t.average_wind_speed || 0).toFixed(2),
        stddev: Number(t.wind_speed_stddev || 0).toFixed(2),
        range: `${Number(t.minimum_wind_speed || 0).toFixed(2)}–${Number(t.maximum_wind_speed || 0).toFixed(2)}`,
        direction: Number(t.latest_wind_direction || 0).toFixed(0),
    });
    const siteComparison = data.t.map((site: any) => ({
        site: site.name,
        wind: Number(Number(site.average_wind_speed || 0).toFixed(2)),
    }));

    return <main className="content dashboard-content">
        <div className="stats dashboard-summary-cards">{stats.map((stat, i) => <article key={stat.label} role="button" tabIndex={0} aria-label={`View ${stat.label} details`} onClick={() => navigateApp('/summary/' + stat.focus)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') navigateApp('/summary/' + stat.focus); }}><span className={'stat-icon s' + i}>{stat.icon}</span><div><small>{stat.label}</small><strong>{stat.value}</strong><em>{stat.note}</em></div></article>)}</div>
        <div className="section-heading"><div><p className="eyebrow">GEOGRAPHIC VIEW</p><h3>Wind Points</h3></div><span className="legend"><i /> Reporting <i className="amber"/> Review</span></div>
        <div className="map-layout fleet-map-layout"><div className="map fleet-map"><div className="zimbabwe fleet-map-canvas"><span>Zimbabwe</span>{data.t.map((t: any) => { const metric = turbineMetrics(t); return <button key={t.id} className={'pin ' + (t.status === 'maintenance' ? 'maintenance' : '')} style={{ left: `${20 + (t.lon - 27) * 8}%`, top: `${24 + (-t.lat - 16) * 7}%` }} onMouseEnter={() => setSelected(t)} onFocus={() => setSelected(t)} onClick={() => setSelected(t)} aria-label={`View ${t.name}`}><img src="/turbine-marker.svg" alt=""/><span className="asset-tooltip"><strong>{t.name}</strong><span>{t.region} · {t.district}</span><span>Measured wind <b>{metric.wind} m/s</b></span><span>Wind std. dev. <b>{metric.stddev} m/s</b></span><span>Wind range <b>{metric.range} m/s</b></span><span>Direction <b>{metric.direction}°</b></span><span>Latest record <b>{t.last_reading_at.slice(0, 10)}</b></span></span></button>; })}</div><div className="map-note">Select a wind point for its measured telemetry</div></div><aside className="province-panel">{selected ? (() => { const metric = turbineMetrics(selected); return <><p className="eyebrow">SELECTED WIND POINT</p><h3>{selected.name}</h3><p>{selected.region} · {selected.district} District</p><div className="detail-grid"><span>Logger status<b className={selected.status}>{selected.status}</b></span><span>Average wind<b>{metric.wind} m/s</b></span><span>Wind std. dev.<b>{metric.stddev} m/s</b></span><span>Wind range<b>{metric.range} m/s</b></span><span>Wind direction<b>{metric.direction}°</b></span><span>Logger<b>{selected.source_id}</b></span></div></>; })() : <><p className="eyebrow">REGIONAL STATUS</p><h3>Regions</h3><p>Points use measured mast telemetry.</p><div className="province-list">{data.m.regions.slice(0, 5).map((item: any) => <div key={item.region}><span>{item.region}</span><b>{item.average_wind_speed} m/s</b></div>)}</div></>}</aside></div>
        <div className="section-heading"><div><p className="eyebrow">SITE COMPARISON</p><h3>Average measured wind speed by site</h3></div><span>All {siteComparison.length} available sites · m/s</span></div>
        <div className="chart-panel"><ResponsiveContainer width="100%" height={230}><BarChart data={siteComparison} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}><CartesianGrid stroke="#e8ece8" vertical={false}/><XAxis dataKey="site" tick={{ fontSize: 11 }}/><YAxis tick={{ fontSize: 11 }} unit=" m/s"/><Tooltip formatter={(value: number) => [`${value.toFixed(2)} m/s`, 'Average measured wind']}/><Bar dataKey="wind" name="Average measured wind" fill="#087fc3" radius={[5, 5, 0, 0]}/></BarChart></ResponsiveContainer></div>
    </main>;
}
type WindPointPhotoSet = {
    photos: string[];
    source: string;
};

const windPointPhotoSets: Record<number, WindPointPhotoSet> = {
    2: { photos: ['/wind-points/guruve-1.jpeg'], source: 'GURUVE.jpeg' },
    3: { photos: ['/wind-points/guruve-2.jpeg'], source: 'GURUVE-.jpeg' },
    4: { photos: ['/wind-points/mt-darwin-dotito-2.jpeg'], source: 'MT DARWIN DOTITO-.jpeg' },
    5: { photos: ['/wind-points/mangwe.jpeg'], source: 'MANGWE.jpeg' },
    6: { photos: ['/wind-points/mt-darwin-dotito-1.jpeg'], source: 'MT DARWIN DOTITO.jpeg' },
    8: { photos: ['/wind-points/vungu.jpeg'], source: 'VUNGU.jpeg' },
};

const weeklyMetricOptions = [
    { key: 'wind_speed', label: 'Average wind', unit: 'm/s', color: '#087fc3', decimals: 2 },
    { key: 'wind_speed_min', label: 'Minimum wind', unit: 'm/s', color: '#39a978', decimals: 2 },
    { key: 'wind_speed_max', label: 'Maximum wind', unit: 'm/s', color: '#d85e76', decimals: 2 },
    { key: 'wind_direction', label: 'Wind direction', unit: '°', color: '#d49e16', decimals: 1 },
    { key: 'temperature', label: 'Temperature', unit: '°C', color: '#e5892e', decimals: 1 },
    { key: 'humidity', label: 'Humidity', unit: '%', color: '#8a5cc4', decimals: 1 },
    { key: 'air_pressure', label: 'Air pressure', unit: 'hPa', color: '#2a9b70', decimals: 1 },
    { key: 'air_density', label: 'Air density', unit: 'kg/m3', color: '#4d9dca', decimals: 4 },
    { key: 'availability_pct', label: 'Availability', unit: '%', color: '#d49e16', decimals: 1 },
    { key: 'data_quality_pct', label: 'Data quality', unit: '%', color: '#d85e76', decimals: 1 },
] as const;

function WindPointPhoto({ asset }: { asset: any }) {
    const photoSet = windPointPhotoSets[Number(asset.id)];
    const activePhoto = photoSet?.photos[0] || '';
    const [zoom, setZoom] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const [drag, setDrag] = useState<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
    const viewerRef = useRef<HTMLElement>(null);
    const changeZoom = (amount: number) => setZoom(current => {
        const next = Math.min(3, Math.max(1, Number((current + amount).toFixed(1))));
        if (next === 1) setOffset({ x: 0, y: 0 });
        return next;
    });
    const panImage = (deltaX: number, deltaY: number, bounds: DOMRect) => {
        const limitX = bounds.width * (zoom - 1) / 2;
        const limitY = bounds.height * (zoom - 1) / 2;
        setOffset(current => ({
            x: Math.max(-limitX, Math.min(limitX, current.x - deltaX)),
            y: Math.max(-limitY, Math.min(limitY, current.y - deltaY)),
        }));
    };
    const moveImage = (event: React.PointerEvent<HTMLElement>) => {
        if (!drag || zoom === 1) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const limitX = bounds.width * (zoom - 1) / 2;
        const limitY = bounds.height * (zoom - 1) / 2;
        const x = drag.offsetX + event.clientX - drag.x;
        const y = drag.offsetY + event.clientY - drag.y;
        setOffset({ x: Math.max(-limitX, Math.min(limitX, x)), y: Math.max(-limitY, Math.min(limitY, y)) });
    };
    const stopMoving = () => setDrag(null);

    useEffect(() => {
        const viewer = viewerRef.current;
        if (!viewer) return;
        let gestureScale = 1;
        const handleTouchpad = (event: WheelEvent) => {
            if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                const amount = -Math.sign(event.deltaY) * Math.min(.3, Math.max(.1, Math.abs(event.deltaY) * .01));
                changeZoom(amount);
            } else if (zoom > 1) {
                event.preventDefault();
                panImage(event.deltaX, event.deltaY, viewer.getBoundingClientRect());
            }
        };
        const handleGestureStart = (event: Event) => { event.preventDefault(); gestureScale = 1; };
        const handleGestureChange = (event: Event) => {
            event.preventDefault();
            const scale = Number((event as Event & { scale: number }).scale || 1);
            changeZoom((scale - gestureScale) * .8);
            gestureScale = scale;
        };
        viewer.addEventListener('wheel', handleTouchpad, { passive: false });
        viewer.addEventListener('gesturestart', handleGestureStart, { passive: false });
        viewer.addEventListener('gesturechange', handleGestureChange, { passive: false });
        return () => {
            viewer.removeEventListener('wheel', handleTouchpad);
            viewer.removeEventListener('gesturestart', handleGestureStart);
            viewer.removeEventListener('gesturechange', handleGestureChange);
        };
    }, [zoom, activePhoto]);

    if (!photoSet || !activePhoto) return <section className="wind-point-photo-card">
        <div className="section-heading wind-point-photo-heading"><div><p className="eyebrow">SITE VISUAL</p><h3>Site View</h3></div><button className="compact" onClick={() => navigateApp('/')}>Back to fleet map</button></div>
        <div className="wind-point-photo-empty"><span aria-hidden="true">◎</span><strong>Site image unavailable</strong><p>No site photograph is currently available for this wind point.</p></div>
    </section>;

    return <section className="wind-point-photo-card">
        <div className="section-heading wind-point-photo-heading"><div><p className="eyebrow">SITE VISUAL</p><h3>Site View</h3></div><button className="compact" onClick={() => navigateApp('/')}>Back to fleet map</button></div>
        <figure ref={viewerRef} className={`wind-point-viewer ${zoom > 1 ? 'is-zoomed' : ''} ${drag ? 'is-dragging' : ''}`} style={{ backgroundImage: `url("${activePhoto}")` }} onDoubleClick={() => changeZoom(zoom === 1 ? 1 : -2)} onPointerDown={event => { if (zoom === 1 || (event.target as HTMLElement).closest('.site-image-controls')) return; setDrag({ x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y }); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={moveImage} onPointerUp={stopMoving} onPointerCancel={stopMoving}>
            <img src={activePhoto} alt={`${asset.name} Site View`} draggable={false} style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}/>
            <div className="wind-point-viewer-shade" />
            <span className="viewer-source">Site View</span>
            <div className="site-image-controls" aria-label="Site image zoom controls"><button type="button" onClick={() => changeZoom(-.25)} disabled={zoom === 1} aria-label="Zoom out">−</button><span>{Math.round(zoom * 100)}%</span><button type="button" onClick={() => changeZoom(.25)} disabled={zoom === 3} aria-label="Zoom in">+</button><button type="button" className="site-image-reset" onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}>Reset</button></div>
            <span className="site-image-hint">{zoom === 1 ? 'Pinch or double-click to zoom' : 'Drag or use two fingers to pan'}</span>
        </figure>
        <div className="wind-point-photo-caption"><span>{asset.name} · Site View</span></div>
    </section>;
}

function TurbineDetail({ token }: {
    token: string;
}) {
    const { id } = useParams();
    const [asset, setAsset] = useState<any>();
    const [rows, setRows] = useState<any[]>([]);
    const [metricKey, setMetricKey] = useState<(typeof weeklyMetricOptions)[number]['key']>('wind_speed');

    useEffect(() => {
        Promise.all([fetchApi('/turbines', token), fetchApi('/analytics/daily?days=7', token)]).then(([t, r]) => {
            setAsset(t.find((item: any) => item.id === Number(id)));
            setRows(r.filter((item: any) => item.turbine_id === Number(id)));
        });
    }, [id, token]);

    if (!asset) return <Loading />;
    const metric = weeklyMetricOptions.find(item => item.key === metricKey) || weeklyMetricOptions[0];
    const measuredRecords = rows.reduce((sum, row) => sum + Number(row.records || 0), 0);
    const avg = measuredRecords ? rows.reduce((sum, row) => sum + Number(row.wind_speed || 0) * Number(row.records || 0), 0) / measuredRecords : 0;
    const minimum = Math.min(...rows.map(row => Number(row.wind_speed_min ?? row.wind_speed ?? 0)));
    const maximum = Math.max(...rows.map(row => Number(row.wind_speed_max ?? row.wind_speed ?? 0)));

    return <main className="content wind-point-detail"><div className="page-title"><p className="eyebrow">MEASURED WIND POINT · DETAILS</p><h1>{asset.name}</h1><p>{asset.region} · {asset.district} District</p></div><div className="district-context"><article><small>ZETDC region</small><strong>{asset.region}</strong><span>{asset.district} District</span></article><article><small>Latest measurement</small><strong>{asset.last_reading_at.slice(0, 10)}</strong><span>Current telemetry status</span></article></div><div className="stats dashboard-summary-cards"><article><span className="stat-icon s2"><Wind /></span><div><small>Measured average wind</small><strong>{avg.toFixed(2)} m/s</strong><em>weekly record-weighted mean</em></div></article><article><span className="stat-icon s1"><Wind /></span><div><small>Measured wind range</small><strong>{Number.isFinite(minimum) ? minimum.toFixed(2) : '0.00'}–{Number.isFinite(maximum) ? maximum.toFixed(2) : '0.00'} m/s</strong><em>source minimum to maximum</em></div></article><article><span className="stat-icon s0"><Settings /></span><div><small>Logger status</small><strong className={asset.status}>{asset.status}</strong><em>{asset.reading_count.toLocaleString()} measurements</em></div></article></div>
        <WindPointPhoto asset={asset}/>
        <section className="chart-panel weekly-metrics-card"><div className="section-heading"><div><p className="eyebrow">WEEKLY MEASUREMENT HISTORY</p><h3>{metric.label} · daily result</h3></div><span>Latest seven source days</span></div><div className="weekly-metric-picker" role="group" aria-label="Choose weekly metric">{weeklyMetricOptions.map(option => <button type="button" key={option.key} className={option.key === metricKey ? 'active' : ''} onClick={() => setMetricKey(option.key)}><i style={{ background: option.color }}/>{option.label}</button>)}</div><ResponsiveContainer width="100%" height={270}><LineChart data={rows} margin={{ top: 12, right: 18, left: 4, bottom: 0 }}><CartesianGrid stroke="#c9e3f5" vertical={false}/><XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={value => String(value).slice(5)}/><YAxis tick={{ fontSize: 11 }} width={62} unit={` ${metric.unit}`}/><Tooltip formatter={(value: number) => [`${Number(value).toFixed(metric.decimals)} ${metric.unit}`, metric.label]} labelFormatter={value => `Date ${value}`}/><Line type="monotone" dataKey={metric.key} name={metric.label} stroke={metric.color} strokeWidth={3} dot={{ r: 3, fill: '#fff', strokeWidth: 2 }} activeDot={{ r: 6 }} connectNulls/></LineChart></ResponsiveContainer></section>
    </main>;
}
const formatReportMonth = (month?: string) => {
    if (!month) return 'Latest month';
    const [year, monthNumber] = month.split('-').map(Number);
    return new Intl.DateTimeFormat('en-ZW', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
};

const formatSummaryWind = (value: any) => value == null ? '—' : `${Number(value).toFixed(2)} m/s`;
const formatSummaryDirection = (value: any) => value == null ? '—' : `${Number(value).toFixed(0)}°`;

function SummaryDetail({ token, liveRevision }: { token: string; liveRevision: number }) {
    const { focus = 'fleet' } = useParams();
    const [assets, setAssets] = useState<any[]>([]);
    const [metrics, setMetrics] = useState<any>();
    const [overview, setOverview] = useState<any>();
    const [refreshingLive, setRefreshingLive] = useState(false);
    const [refreshError, setRefreshError] = useState('');

    useEffect(() => {
        let active = true;
        Promise.all([fetchApi('/turbines', token), fetchApi('/metrics', token), fetchApi('/overview-summary', token)])
            .then(([t, m, summary]) => { if (active) { setAssets(t); setMetrics(m); setOverview(summary); } });
        const refresh = window.setInterval(() => {
            getApiData<any>('/overview-summary', token, 0)
                .then(summary => { if (active) setOverview(summary); })
                .catch(() => undefined);
        }, 60 * 60 * 1000);
        return () => { active = false; window.clearInterval(refresh); };
    }, [token, liveRevision]);

    if (!metrics || !overview) return <Loading />;

    const isLive = focus === 'live-wind';
    const isMastMonth = focus === 'wind';
    const monthly = isLive ? overview.live : overview.mast;
    const mastMonthLabel = formatReportMonth(overview.mast?.report_month);
    const liveMonthLabel = formatReportMonth(overview.live?.report_month);
    const labels: Record<string, [string, string]> = {
        fleet: ['Wind assessment points', `All ${assets.length} measured points and their current logger state`],
        range: ['Measured wind range', 'Source minimum and maximum wind speeds across the active reporting window'],
        wind: ['Fleet wind speed', `ZETDC mast average for the latest reported month · ${mastMonthLabel}`],
        availability: ['Data availability summary', 'Valid logger samples across all wind points'],
        'live-wind': ['Live wind speed', `Current live-model readings for ${liveMonthLabel} · month to date`],
    };
    const [title, note] = labels[focus] || labels.fleet;
    const value = focus === 'range'
        ? `${Number(metrics.fleet.min_wind_speed).toFixed(2)}–${Number(metrics.fleet.max_wind_speed).toFixed(2)} m/s`
        : isMastMonth || isLive
            ? formatSummaryWind(monthly?.average_wind_speed)
            : focus === 'availability' ? `${metrics.fleet.uptime}%` : String(assets.length);
    const mastRows = overview.mast?.points || [];
    const liveRows = overview.live?.provinces || [];
    const summaryLabel = isLive ? 'Reported-month live measure' : isMastMonth ? 'Reported-month fleet measure' : 'Current fleet measure';
    const summaryNote = isLive
        ? `${overview.live?.provider || 'Open-Meteo'} · daily online refresh · ${overview.live?.start_date} to ${overview.live?.end_date}`
        : isMastMonth ? `${overview.mast?.records.toLocaleString()} mast records · ${overview.mast?.start_date} to ${overview.mast?.end_date}` : 'measured source data';
    const refreshAllLiveData = async () => {
        if (!window.confirm('Refresh live wind data now? This will update the shared live snapshot used across the entire system.')) return;
        setRefreshingLive(true);
        setRefreshError('');
        try {
            await refreshLiveData(token, 'manual');
        } catch (error) {
            setRefreshError(error instanceof Error ? error.message : 'Live wind refresh failed. The last successful data remains available.');
        } finally {
            setRefreshingLive(false);
        }
    };

    return <main className="content summary-detail-page">
        <div className={`page-title ${isLive ? 'live-summary-title' : ''}`}><p className="eyebrow">SUMMARY DRILL-DOWN</p><h1>{title}</h1><p>{note}</p>{isLive && <div className="live-summary-refresh"><button type="button" onClick={refreshAllLiveData} disabled={refreshingLive}><RefreshCw className={refreshingLive ? 'spinning' : ''} size={16}/>{refreshingLive ? 'Refreshing all live data…' : 'Refresh live data'}</button><small>Updates every live-data module</small></div>}</div>
        {refreshError && <p className="live-refresh-error" role="alert">{refreshError}</p>}
        <div className="stats"><article><span className="stat-icon s2">{isLive || isMastMonth || focus === 'range' ? <Wind /> : <Activity />}</span><div><small>{summaryLabel}</small><strong>{value}</strong><em>{summaryNote}</em></div></article></div>
        <div className="table-panel">
            <div className="section-heading"><div><p className="eyebrow">{isLive ? 'PROVINCE BREAKDOWN' : 'POINT BREAKDOWN'}</p><h3>{isLive ? `${liveMonthLabel} live wind across Zimbabwe’s 10 provinces` : isMastMonth ? `${mastMonthLabel} mast wind details` : focus === 'fleet' ? 'Wind point register' : 'Measured wind details'}</h3></div><button className="compact" onClick={() => navigateApp('/')}>Back to fleet map</button></div>
            {isLive ? <table><thead><tr><th>Province</th><th>Reference location</th><th>Status</th><th>Average wind</th><th>Wind range</th><th>Direction</th></tr></thead><tbody>{liveRows.map((province: any) => <tr key={province.province}><td><strong>{province.province}</strong></td><td>{province.location}</td><td><b className={`summary-status ${province.status}`}>{province.status}</b></td><td>{formatSummaryWind(province.average_wind_speed)}</td><td>{province.minimum_wind_speed == null ? '—' : `${Number(province.minimum_wind_speed).toFixed(2)}–${Number(province.maximum_wind_speed).toFixed(2)} m/s`}</td><td>{formatSummaryDirection(province.average_wind_direction)}</td></tr>)}</tbody></table>
                : isMastMonth ? <table><thead><tr><th>Wind point</th><th>Location</th><th>Status</th><th>Average wind</th><th>Wind range</th><th>Direction</th></tr></thead><tbody>{mastRows.map((point: any) => <tr className="summary-row" key={point.turbine_id} onClick={() => navigateApp('/turbines/' + point.turbine_id)}><td>{point.name}</td><td>{point.province}</td><td><b className={point.status}>{point.status}</b></td><td>{formatSummaryWind(point.metrics.wind_speed)}</td><td>{Number(point.metrics.wind_speed_min).toFixed(2)}–{Number(point.metrics.wind_speed_max).toFixed(2)} m/s</td><td>{formatSummaryDirection(point.metrics.wind_direction)}</td></tr>)}</tbody></table>
                    : <table><thead><tr><th>Wind point</th><th>Location</th><th>Status</th><th>Average wind</th><th>Wind range</th><th>Direction</th></tr></thead><tbody>{assets.map(t => { const wind = Number(t.average_wind_speed || 0).toFixed(2), minimum = Number(t.minimum_wind_speed || 0).toFixed(2), maximum = Number(t.maximum_wind_speed || 0).toFixed(2), direction = Number(t.latest_wind_direction || 0).toFixed(0); return <tr className="summary-row" key={t.id} onClick={() => navigateApp('/turbines/' + t.id)}><td>{t.name}</td><td>{t.province}</td><td><b className={t.status}>{t.status}</b></td><td>{wind} m/s</td><td>{minimum}–{maximum} m/s</td><td>{direction}°</td></tr>; })}</tbody></table>}
            {isLive && <p className="summary-source-note">Each province uses its capital as a consistent Open-Meteo 10 m wind reference location. Figures run from the first day of the current month through the latest daily online refresh.</p>}
        </div>
    </main>;
}
const historyMonthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const historyMetricColors: Record<string, string> = {
    wind_speed: '#087fc3', wind_speed_min: '#39a978', wind_speed_max: '#d85e76', wind_direction: '#d49e16', temperature: '#e5892e', humidity: '#8a5cc4',
    air_pressure: '#2a9b70', air_density: '#4d9dca', availability_pct: '#d49e16', data_quality_pct: '#d85e76',
};

const historyExportColumns = [
    ['Date', (day: any) => day.date],
    ['Average wind speed (m/s)', (day: any) => day.metrics.wind_speed],
    ['Minimum wind speed (m/s)', (day: any) => day.metrics.wind_speed_min],
    ['Maximum wind speed (m/s)', (day: any) => day.metrics.wind_speed_max],
    ['Wind direction (degrees)', (day: any) => day.metrics.wind_direction],
    ['Temperature (°C)', (day: any) => day.metrics.temperature],
    ['Humidity (%)', (day: any) => day.metrics.humidity],
    ['Air pressure (hPa)', (day: any) => day.metrics.air_pressure],
    ['Air density (kg/m3)', (day: any) => day.metrics.air_density],
    ['Availability (%)', (day: any) => day.metrics.availability_pct],
    ['Data quality (%)', (day: any) => day.metrics.data_quality_pct],
    ['Measurements', (day: any) => day.records],
] as const;

const historyDelimitedData = (days: any[], separator: string) => {
    const escapeValue = (value: any) => {
        const valueText = value == null ? '' : String(value);
        return separator === ',' && /[",\r\n]/.test(valueText) ? `"${valueText.replace(/"/g, '""')}"` : valueText;
    };
    return [
        historyExportColumns.map(([label]) => escapeValue(label)).join(separator),
        ...days.map(day => historyExportColumns.map(([, value]) => escapeValue(value(day))).join(separator)),
    ].join('\r\n');
};

const downloadHistoryFile = (contents: string, filename: string, type = 'text/csv;charset=utf-8') => {
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

const escapeHistoryXml = (value: any) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const historyExcelWorkbook = (worksheets: { name: string; rows: any[] }[]) => {
    const worksheetXml = worksheets.map(sheet => {
        const name = sheet.name.replace(/[\\/:?*\[\]]/g, ' ').slice(0, 31) || 'Wind point';
        const header = `<Row>${historyExportColumns.map(([label]) => `<Cell ss:StyleID="Header"><Data ss:Type="String">${escapeHistoryXml(label)}</Data></Cell>`).join('')}</Row>`;
        const rows = sheet.rows.map(row => `<Row>${historyExportColumns.map(([, value]) => { const cell = value(row); const type = typeof cell === 'number' ? 'Number' : 'String'; return `<Cell><Data ss:Type="${type}">${escapeHistoryXml(cell)}</Data></Cell>`; }).join('')}</Row>`).join('');
        return `<Worksheet ss:Name="${escapeHistoryXml(name)}"><Table>${header}${rows}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane></WorksheetOptions></Worksheet>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel"><Styles><Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#DFF2FF" ss:Pattern="Solid"/></Style></Styles>${worksheetXml}</Workbook>`;
};

function HistoryWorkspace({ token, liveRevision }: { token: string; liveRevision: number }) {
    const [histories, setHistories] = useState<any>();
    const [sourceMode, setSourceMode] = useState<'zetdc' | 'live' | 'difference'>('zetdc');
    const [metricKey, setMetricKey] = useState('wind_speed');
    const [pointId, setPointId] = useState('all');
    const [registerPointId, setRegisterPointId] = useState('');
    const [year, setYear] = useState(2026);
    const [month, setMonth] = useState<number | null>(null);
    const [exportStatus, setExportStatus] = useState('');

    useEffect(() => {
        Promise.all([
            fetchApi('/history', token),
            fetchApi('/history?source=live', token).catch(() => null),
        ]).then(([data, live]) => {
            setHistories({ zetdc: data, live });
            const initialYear = data.years.includes(2026) ? 2026 : data.years[data.years.length - 1];
            setYear(initialYear);
            setMonth(null);
        });
    }, [token, liveRevision]);

    useEffect(() => {
        if (month == null) return;
        const previousOverflow = document.body.style.overflow;
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setMonth(null);
        };
        document.body.style.overflow = 'hidden';
        window.addEventListener('keydown', closeOnEscape);
        return () => {
            document.body.style.overflow = previousOverflow;
            window.removeEventListener('keydown', closeOnEscape);
        };
    }, [month]);

    if (!histories) return <Loading />;

    const differenceHistory = (live: any, mast: any) => {
        const subtractMetrics = (a: any = {}, b: any = {}) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(key => [key, a[key] == null || b[key] == null ? null : Number(a[key]) - Number(b[key])]));
        const mastMonths = new Map((mast.months || []).map((item: any) => [item.key, item]));
        const sortedMastMonths = [...(mast.months || [])].sort((a: any, b: any) => String(a.key).localeCompare(String(b.key)));
        const latestMastMonth = sortedMastMonths[sortedMastMonths.length - 1];
        const latestMastPoints = new Map((latestMastMonth?.points || []).map((point: any) => [point.turbine_id, point]));
        const latestMastMonthDays = latestMastMonth?.days || [];
        const latestMastDays = new Map((latestMastMonthDays[latestMastMonthDays.length - 1]?.points || []).map((point: any) => [point.turbine_id, point]));
        const months = (live?.months || []).map((item: any) => {
            const base: any = mastMonths.get(item.key) || latestMastMonth;
            const basePoints = new Map((base?.points || []).map((point: any) => [point.turbine_id, point]));
            const baseDays = new Map((base?.days || []).map((day: any) => [day.date, day]));
            return {
                ...item,
                records: item.records - Number(base?.records || 0),
                metrics: subtractMetrics(item.metrics, base?.metrics),
                points: item.points.map((point: any) => {
                    const basePoint = (basePoints.get(point.turbine_id) || latestMastPoints.get(point.turbine_id)) as any;
                    return {...point, records: point.records - Number(basePoint?.records || 0), metrics: subtractMetrics(point.metrics, basePoint?.metrics)};
                }),
                days: item.days.map((day: any) => {
                    const baseDay: any = baseDays.get(day.date);
                    const baseDayPoints = new Map((baseDay?.points || []).map((point: any) => [point.turbine_id, point]));
                    return {...day, records: day.records - Number(baseDay?.records || 0), metrics: subtractMetrics(day.metrics, baseDay?.metrics || latestMastMonth?.metrics), points: day.points.map((point: any) => {
                        const basePoint = (baseDayPoints.get(point.turbine_id) || latestMastDays.get(point.turbine_id) || latestMastPoints.get(point.turbine_id)) as any;
                        return {...point, records: point.records - Number(basePoint?.records || 0), metrics: subtractMetrics(point.metrics, basePoint?.metrics)};
                    })};
                }),
            };
        });
        return {...mast, years: sortedYears(months), months, data_source: {label: 'Live minus ZETDC Wind Mast data'}};
    };
    const sortedYears = (months: any[]) => [...new Set(months.map((item: any) => item.year))].sort();
    const history = sourceMode === 'live' && histories.live ? histories.live : sourceMode === 'difference' && histories.live ? differenceHistory(histories.live, histories.zetdc) : histories.zetdc;
    const sourceLabel = sourceMode === 'live' ? 'Live Wind Maps Data' : sourceMode === 'difference' ? 'Live minus ZETDC Wind Mast data' : 'ZETDC Wind Mast data';
    const metrics = history.metrics.map((item: any) => ({ ...item, color: historyMetricColors[item.key] || '#087fc3' }));
    const metric = metrics.find((item: any) => item.key === metricKey) || metrics[0];
    const windPoints = history.wind_points || [];
    const selectedPoint = windPoints.find((item: any) => String(item.turbine_id) === pointId);
    const scopeName = selectedPoint?.name || 'All wind points';
    const monthScope = (item: any) => pointId === 'all'
        ? item
        : item?.points?.find((point: any) => String(point.turbine_id) === pointId);
    const yearRows = history.months.filter((item: any) => item.year === year);
    const selected = yearRows.find((item: any) => item.month === month && monthScope(item)?.metrics?.[metricKey] != null);
    const selectedScope = monthScope(selected);
    const formatMetricValue = (key: string, value: any) => {
        const definition = metrics.find((item: any) => item.key === key);
        const digits = key === 'air_density' ? 4 : key.startsWith('wind_speed') ? 2 : 1;
        return value == null ? '—' : `${Number(value).toLocaleString('en-US', { maximumFractionDigits: digits })} ${definition?.unit || ''}`;
    };
    const formatValue = (value: any) => formatMetricValue(metricKey, value);
    const chooseYear = (targetYear: number) => {
        setYear(targetYear);
        setMonth(null);
    };
    const moveYear = (direction: number) => {
        const index = history.years.indexOf(year);
        const target = history.years[index + direction];
        if (target != null) chooseYear(target);
    };
    const chooseMetric = (key: string) => {
        setMetricKey(key);
        setMonth(null);
    };
    const choosePoint = (key: string) => {
        setPointId(key);
        setMonth(null);
    };
    const selectedIndex = history.years.indexOf(year);
    const selectedDays = selected?.days.map((day: any) => {
        if (pointId === 'all') return day;
        const point = day.points?.find((item: any) => String(item.turbine_id) === pointId);
        return point ? { ...point, date: day.date, day: day.day } : null;
    }).filter(Boolean) || [];
    const registerPoints = selected?.points.filter((point: any) => point.metrics?.[metricKey] != null) || [];
    const activeRegisterPoint = registerPoints.find((point: any) => String(point.turbine_id) === registerPointId) || registerPoints[0];
    const pointDailyRows = (targetPointId: string) => selected?.days.map((day: any) => {
        const point = day.points?.find((item: any) => String(item.turbine_id) === targetPointId && item.metrics?.[metricKey] != null);
        return point ? { ...point, date: day.date, day: day.day } : null;
    }).filter(Boolean) || [];
    const registerDays = activeRegisterPoint ? pointDailyRows(String(activeRegisterPoint.turbine_id)) : [];
    const registerScopeName = activeRegisterPoint?.name || scopeName;
    const dailyChart = selectedDays.map((day: any) => ({ date: day.date, day: String(day.day).padStart(2, '0'), value: day.metrics[metricKey] })).filter((day: any) => day.value != null);
    const exportScope = registerScopeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const exportFilename = selected ? `daily-measurement-register-${exportScope}-${selected.year}-${String(selected.month).padStart(2, '0')}.csv` : '';
    const csvData = selected ? historyDelimitedData(registerDays, ',') : '';
    const tsvData = selected ? historyDelimitedData(registerDays, '\t') : '';
    const reportTitle = selected ? `Daily measurement register — ${registerScopeName} — ${historyMonthNames[selected.month - 1]} ${selected.year}` : '';
    const copyData = async () => {
        try {
            let copied = false;
            if (navigator.clipboard?.writeText) {
                try {
                    await navigator.clipboard.writeText(tsvData);
                    copied = true;
                } catch {
                    copied = false;
                }
            }
            if (!copied) {
                const textarea = document.createElement('textarea');
                textarea.value = tsvData;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                copied = document.execCommand('copy');
                textarea.remove();
                if (!copied) throw new Error('Copy was not accepted');
            }
            setExportStatus(`Copied ${registerDays.length} daily records for ${registerScopeName} to the clipboard.`);
        } catch {
            setExportStatus('Copy was blocked by the browser. Use Export Excel instead.');
        }
    };
    const downloadExcel = () => {
        if (!selected) return;
        const worksheets = registerPoints.map((point: any) => ({
            name: point.name.replace(/ Wind Point$/i, ''),
            rows: pointDailyRows(String(point.turbine_id)),
        }));
        const filename = `daily-measurement-register-${selected.year}-${String(selected.month).padStart(2, '0')}.xls`;
        downloadHistoryFile(`\ufeff${historyExcelWorkbook(worksheets)}`, filename, 'application/vnd.ms-excel;charset=utf-8');
        setExportStatus(`Exported ${worksheets.length} wind-point worksheets to ${filename}.`);
    };
    const emailData = () => {
        const body = `${reportTitle}\n\n${tsvData}`;
        window.location.href = `mailto:?subject=${encodeURIComponent(reportTitle)}&body=${encodeURIComponent(body)}`;
        setExportStatus('Opened your email application with the register included in the message.');
    };
    const shareData = async () => {
        const file = new File([`\ufeff${csvData}`], exportFilename, { type: 'text/csv' });
        const sharePayload = { title: reportTitle, text: `${reportTitle} (${registerDays.length} daily records)`, files: [file] };
        try {
            if (!navigator.share || (navigator.canShare && !navigator.canShare({ files: [file] }))) {
                downloadHistoryFile(`\ufeff${csvData}`, exportFilename);
                setExportStatus('System sharing is unavailable in this browser, so the CSV was downloaded for saving to Files or USB.');
                return;
            }
            await navigator.share(sharePayload);
            setExportStatus('The daily register was sent to the selected share destination.');
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                setExportStatus('Share cancelled.');
            } else {
                setExportStatus('The system share menu could not be opened. Use Export Excel or Email instead.');
            }
        }
    };
    const openMonth = (targetMonth: number) => {
        const target = yearRows.find((item: any) => item.month === targetMonth);
        const available = target?.points?.filter((point: any) => point.metrics?.[metricKey] != null) || [];
        const preferred = pointId !== 'all' && available.some((point: any) => String(point.turbine_id) === pointId)
            ? pointId
            : String(available[0]?.turbine_id || '');
        setExportStatus('');
        setRegisterPointId(preferred);
        setMonth(targetMonth);
    };

    return <main className="content history-workspace">
        <div className="page-title history-title"><div><p className="eyebrow">MEASUREMENT ARCHIVE</p><h1>History</h1><p>Explore historical wind-point measurements by metric, year, and month.</p></div><span><i/> Data available</span></div>

        <section className="history-step history-metric-step"><header><b>01</b><div><p className="eyebrow">METRIC</p><h2>Select a measurement</h2></div><label className="history-popup-scope history-page-scope"><span>Data source</span><select value={sourceMode} onChange={event => { setSourceMode(event.target.value as any); setMonth(null); }}><option value="zetdc">ZETDC Wind Mast data</option><option value="live" disabled={!histories.live}>Live Wind Maps Data</option><option value="difference" disabled={!histories.live}>Live minus ZETDC</option></select></label></header><div className="history-metric-grid">{metrics.map((item: any) => <button type="button" key={item.key} className={item.key === metricKey ? 'active' : ''} onClick={() => chooseMetric(item.key)}><i style={{ background: item.color }}/><span>{item.label}</span><small>{item.unit}</small></button>)}</div></section>

        <div className="history-filter-row">
            <section className="history-step history-point-step"><header><b>02</b><div><p className="eyebrow">WIND POINT</p><h2>Choose measurement scope</h2></div></header><label className="history-popup-scope history-page-scope"><span>Wind point</span><select value={pointId} onChange={event => choosePoint(event.target.value)}><option value="all">All wind points</option>{windPoints.map((point: any) => <option key={point.turbine_id} value={String(point.turbine_id)}>{point.name}</option>)}</select></label></section>

            <section className="history-step history-year-step"><header><b>03</b><div><p className="eyebrow">YEAR</p><h2>Choose reporting year</h2></div></header><div className="history-year-controls"><button type="button" onClick={() => moveYear(-1)} disabled={selectedIndex <= 0} aria-label="Previous year">‹</button><div>{history.years.map((item: number) => <button type="button" key={item} className={item === year ? 'active' : ''} onClick={() => chooseYear(item)}>{item}</button>)}</div><button type="button" onClick={() => moveYear(1)} disabled={selectedIndex >= history.years.length - 1} aria-label="Next year">›</button></div></section>
        </div>

        <section className="history-step history-month-step"><header><b>04</b><div><p className="eyebrow">MONTH</p><h2>{metric.label} · {year}</h2></div><span>{scopeName} · {sourceLabel}</span></header><div className="history-month-grid">{historyMonthNames.map((name, index) => { const item = yearRows.find((row: any) => row.month === index + 1); const scoped = monthScope(item); const hasData = scoped?.metrics?.[metricKey] != null; return <button type="button" key={name} disabled={!hasData} className={`${hasData ? 'has-data' : 'no-data'} ${month === index + 1 && hasData ? 'active' : ''}`} onClick={() => openMonth(index + 1)}><small>{String(index + 1).padStart(2, '0')}</small><strong>{name}</strong><span>{hasData ? formatValue(scoped.metrics[metricKey]) : 'No data'}</span>{hasData && <em><i/> Monthly result · {pointId === 'all' ? `${item.wind_points} points` : scopeName}</em>}</button>; })}</div></section>

        {selected ? <div className="history-modal" role="dialog" aria-modal="true" aria-labelledby="history-dialog-title"><section className="history-detail"><header><div><p className="eyebrow">DAILY HISTORY DRILL-DOWN</p><h2 id="history-dialog-title">{historyMonthNames[selected.month - 1]} {selected.year}</h2><span>{metric.label} day by day · {scopeName}</span></div><div className="history-detail-heading-actions"><strong style={{ color: metric.color }}>{formatValue(selectedScope.metrics[metricKey])}</strong><button type="button" className="history-close" onClick={() => setMonth(null)} aria-label="Close daily history drill-down"><X/></button></div></header><div className="history-export-bar"><div className="history-export-intro"><b>Daily measurement register</b><span>Excel creates {registerPoints.length} wind-point worksheet tabs. Copy, email, and share use the active register tab.</span></div><label className="history-popup-scope"><span>Graph scope</span><select value={pointId} onChange={event => { const value = event.target.value; setPointId(value); if (value !== 'all') setRegisterPointId(value); setExportStatus(''); }}><option value="all">All wind points</option>{selected.points.map((point: any) => <option key={point.turbine_id} value={String(point.turbine_id)}>{point.name}</option>)}</select></label><div className="history-export-actions"><button type="button" onClick={copyData}><Copy/>Copy active tab</button><button type="button" onClick={downloadExcel}><Download/>Export Excel</button><button type="button" onClick={emailData}><Mail/>Email active tab</button><button type="button" className="primary" onClick={shareData}><Share2/>Share / save</button></div>{exportStatus && <p className="history-export-status" role="status" aria-live="polite">{exportStatus}</p>}</div><div className="history-average-note"><b>{scopeName}</b><span>Metric figures in the summary cards reflect the selected month and wind-point scope. Measurement counts are monthly totals.</span></div><div className="history-detail-kpis"><article><small>Monthly result</small><strong>{formatValue(selectedScope.metrics[metricKey])}</strong><span>{metric.label} · {scopeName}</span></article><article><small>Measurements</small><strong>{selectedScope.records.toLocaleString()}</strong><span>{scopeName} monthly total</span></article><article><small>Reporting wind points</small><strong>{pointId === 'all' ? selected.wind_points : 1}</strong><span>{scopeName}</span></article></div><div className="history-chart"><div className="history-chart-heading"><div><p className="eyebrow">DAILY TREND</p><h3>{metric.label} by day · {scopeName}</h3></div><span>{dailyChart.length} recorded day{dailyChart.length === 1 ? '' : 's'}</span></div><ResponsiveContainer width="100%" height={270}><LineChart data={dailyChart} margin={{ top: 12, right: 18, left: 5, bottom: 5 }}><CartesianGrid stroke="#dceaf3" vertical={false}/><XAxis dataKey="day" tick={{ fontSize: 10 }}/><YAxis tick={{ fontSize: 10 }} unit={` ${metric.unit}`}/><Tooltip labelFormatter={(_, payload) => `${payload?.[0]?.payload?.date || ''} · ${scopeName}`} formatter={(value: number) => [formatValue(value), metric.label]}/><Line type="monotone" dataKey="value" name={`${metric.label} · ${scopeName}`} stroke={metric.color} strokeWidth={3} dot={{ r: 3, fill: '#fff', strokeWidth: 2 }} activeDot={{ r: 6 }}/></LineChart></ResponsiveContainer></div><div className="history-daily-table"><header><div><p className="eyebrow">DAY-BY-DAY RECORDING</p><h3>Daily measurement register</h3></div><span>{registerScopeName} · {registerDays.length} recorded days</span></header><div className="history-register-tabs" role="tablist" aria-label="Available wind points for the selected month and metric">{registerPoints.map((point: any) => { const tabId = String(point.turbine_id); const active = String(activeRegisterPoint?.turbine_id) === tabId; return <button type="button" role="tab" id={`history-register-tab-${tabId}`} aria-selected={active} key={tabId} className={active ? 'active' : ''} onClick={() => { setRegisterPointId(tabId); setExportStatus(''); }}><span>{point.name.replace(/ Wind Point$/i, '')}</span><small>{point.records.toLocaleString()} records</small></button>; })}</div><div role="tabpanel" aria-labelledby={`history-register-tab-${activeRegisterPoint?.turbine_id || ''}`}><table><thead><tr><th>Date</th><th>Average wind</th><th>Minimum wind</th><th>Maximum wind</th><th>Direction</th><th>Temperature</th><th>Humidity</th><th>Air pressure</th><th>Air density</th><th>Availability</th><th>Data quality</th><th>Measurements</th></tr></thead><tbody>{registerDays.map((day: any) => <tr key={day.date}><td><strong>{day.date}</strong></td><td>{formatMetricValue('wind_speed', day.metrics.wind_speed)}</td><td>{formatMetricValue('wind_speed_min', day.metrics.wind_speed_min)}</td><td>{formatMetricValue('wind_speed_max', day.metrics.wind_speed_max)}</td><td>{formatMetricValue('wind_direction', day.metrics.wind_direction)}</td><td>{formatMetricValue('temperature', day.metrics.temperature)}</td><td>{formatMetricValue('humidity', day.metrics.humidity)}</td><td>{formatMetricValue('air_pressure', day.metrics.air_pressure)}</td><td>{formatMetricValue('air_density', day.metrics.air_density)}</td><td>{formatMetricValue('availability_pct', day.metrics.availability_pct)}</td><td>{formatMetricValue('data_quality_pct', day.metrics.data_quality_pct)}</td><td>{day.records.toLocaleString()}</td></tr>)}</tbody></table></div></div></section></div> : <section className="history-empty"><HistoryIcon/><h2>Select a month to view its daily history</h2><p>Choose a green month to open the {scopeName} full-page measurement register.</p></section>}
    </main>;
}

function ReportsWorkspace() { return <main className="content reports-host loading" aria-label="Reports" aria-busy="true"/>; }
function PredictionsWorkspace() { return <main className="content prediction-host loading" aria-label="Predictions">Loading forecast data...</main>; }
function Analytics() { return <main className="content analytics-host loading" aria-label="Analytics">Loading compact analytics...</main>; }
function Compare() { return <main className="content comparison-host loading" aria-label="Compare">Loading site comparison...</main>; }
function Admin({ token }: {
    token: string;
}) { return <main className="content admin-host" aria-label="Administration"/>; }
function PageTitle({ title, note }: {
    title: string;
    note: string;
}) { return <div className="page-title"><p className="eyebrow">ANALYTICS WORKSPACE</p><h1>{title}</h1><p>{note}</p></div>; }
;
function Loading() { return <main className="content loading">Loading operational data...</main>; }
function App() { const [auth, setAuth] = useState<{
    u: User;
    t: string;
} | null>(() => { const x = localStorage.getItem('zetdc-auth'); return x ? JSON.parse(x) : null; }); const navigate = useNavigate(); const login = (u: User, t: string) => { clearApiCache(); localStorage.setItem('zetdc-auth', JSON.stringify({ u, t })); setAuth({ u, t }); navigate('/'); }; const logout = () => { clearApiCache(); localStorage.removeItem('zetdc-auth'); setAuth(null); }; return auth ? <Layout user={auth.u} token={auth.t} onLogout={logout}/> : <Login onLogin={login}/>; }
;
createRoot(document.getElementById('root')!).render(<BrowserRouter><App /></BrowserRouter>);
