import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Activity, BarChart3, Bolt, Copy, Download, FileText, History as HistoryIcon, LayoutDashboard, LogOut, Mail, MapPin, Settings, Share2, Sparkles, Wind, X } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
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
import {getApiData, clearApiCache} from './data-client';
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
        fetch(API + '/turbines', { headers: { Authorization: `Bearer ${t}` } }).then(response => response.json()),
        fetch(API + '/live-wind', { headers: { Authorization: `Bearer ${t}` } }).then(response => response.ok ? response.json() : null).catch(() => null),
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
        const generation = (Number(asset.latest_power_output || 0) / 1000).toFixed(2);
        const icon = L.divIcon({ className: 'osm-turbine-marker', html: '<img src="/turbine-marker.svg" alt=""/>', iconSize: [34, 52], iconAnchor: [17, 45] });
        const basePopup = `<strong>${asset.name}</strong><br/>${asset.region}<br/>District: <b>${asset.district}</b><br/>Measured wind: <b>${wind} m/s</b><br/>Estimated generation: <b>${generation} MW</b><br/>Logger: <b>${asset.source_id}</b><br/><a href="/turbines/${asset.id}">Open Wind Point</a>`;
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
    loadGridData().catch(() => undefined);
    (live?.stations || []).forEach((asset: any) => {
        const wind = Number(asset.latest_wind_speed || 0).toFixed(2);
        const density = Number(asset.latest_air_density || 0).toFixed(4);
        const generation = (Number(asset.latest_power_output || 0) / 1000).toFixed(2);
        const marker = L.circleMarker([asset.lat, asset.lon], {
            radius: 8,
            color: '#d49e16',
            weight: 2,
            fillColor: '#fff3cd',
            fillOpacity: .9,
        }).addTo(map).bindPopup(
            `<strong>${asset.name}</strong><br/>Live Wind Maps Data<br/>Open-Meteo wind: <b>${wind} m/s</b><br/>Air density: <b>${density} kg/m3</b><br/>Estimated generation: <b>${generation} MW</b><br/>Updated: <b>${String(asset.last_reading_at).slice(0, 16)}</b>`,
            { autoPan: true, offset: [0, -8] },
        );
        bindHoverPopup(marker);
    });
};
window.addEventListener('zetdc:route-ready', () => { initOsmFleetMap().catch(() => undefined); });
setInterval(() => { initOsmFleetMap().catch(() => undefined); }, 1500);
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
setInterval(() => { initLoginOsmMap().catch(() => undefined); }, 500);
const API = '/api';
const initCustomReportSelector = () => { if (window.location.pathname !== '/reports')
    return; const tabs = document.querySelector('.report-tabs'); const filters = document.querySelector<HTMLElement>('.report-filters'); const names = [...document.querySelectorAll<HTMLElement>('.default-report-card strong')].map(item => item.textContent?.trim()).filter((name): name is string => Boolean(name)); if (!tabs || !filters || !names.length)
    return; const customTab = tabs.children[1] as HTMLButtonElement; if (customTab)
    customTab.textContent = 'Custom Report'; if (filters.querySelector('.custom-report-selector'))
    return; const label = document.createElement('label'); label.className = 'custom-report-selector'; label.innerHTML = '<span>Report template</span>'; const select = document.createElement('select'); select.innerHTML = '<option value="">Select a default report to customize</option>' + [...new Set(names)].map(name => `<option value="${name}">${name}</option>`).join(''); label.append(select); filters.prepend(label); const chartHeading = document.querySelector<HTMLElement>('.chart-panel .section-heading h3'); const description = document.createElement('p'); description.className = 'custom-report-note'; description.textContent = 'Choose a default report, then set its date range, scope, visualization, and comparison options.'; filters.after(description); select.onchange = () => { const report = select.value; if (!report)
    return; description.textContent = `Customizing ${report}. Update the settings below, then select Show report or Save report.`; if (chartHeading) {
    chartHeading.dataset.defaultTitle ??= chartHeading.textContent || '';
    chartHeading.textContent = `${report} - custom analysis`;
} }; };
type User = {
    name: string;
    role: string;
    ec_number: string;
};
const fetchApi = (path: string, token: string) => getApiData<any>(path, token);
document.addEventListener('click', event => { const card = (event.target as HTMLElement).closest<HTMLElement>('.default-report-card'); if (!card || window.location.pathname !== '/reports-legacy')
    return; event.preventDefault(); const name = card.querySelector('strong')?.textContent || 'Report', value = card.querySelector('b')?.textContent || 'Current fleet measure', context = card.querySelector('span')?.textContent || 'Operational performance'; const overlay = document.createElement('section'); overlay.className = 'default-report-detail'; overlay.innerHTML = `<main><header><div><p class="eyebrow">DETAILED DEFAULT REPORT</p><h1>${name}</h1><p>This report summarizes ${context.toLowerCase()} using the latest fleet data. It highlights the current measure, operational context, and priority actions for the control room.</p></div><button>Close report</button></header><div class="detail-kpi"><strong>${value}</strong><span>Latest recorded result for ${name}</span></div><div class="detail-visual"><section class="detail-chart"><h3>Operational breakdown</h3><div class="detail-bar"><span>Current</span><i style="width:86%"></i><b>86%</b></div><div class="detail-bar"><span>Previous period</span><i style="width:69%"></i><b>69%</b></div><div class="detail-bar"><span>Target</span><i style="width:94%"></i><b>94%</b></div></section><section class="detail-notes"><h3>Summary explanation</h3><ul><li>Current status is derived from the latest fleet telemetry and calculated metrics.</li><li>Review deviations against the target before scheduling operational action.</li><li>Use Modify reports for a turbine, province, or date-specific investigation.</li></ul></section></div></main>`; overlay.querySelector('button')!.onclick = () => overlay.remove(); document.body.append(overlay); });
document.addEventListener('click', event => { const pin = (event.target as HTMLElement).closest('.pin'); if (pin) {
    const id = [...document.querySelectorAll('.pin')].indexOf(pin) + 1;
    navigateApp('/turbines/' + id);
} });
document.addEventListener('click', event => { if ((event.target as HTMLElement).closest('.logo'))
    navigateApp('/'); });
document.addEventListener('click', event => { const card = (event.target as HTMLElement).closest('.stats article'); if (card && window.location.pathname === '/') {
    const cards = [...document.querySelectorAll('.stats article')];
    const focus = ['fleet', 'generation', 'wind', 'availability'][cards.indexOf(card)];
    navigateApp('/summary/' + focus);
} });
document.addEventListener('click', event => { const trigger = (event.target as HTMLElement).closest('button'); if (!trigger || window.location.pathname !== '/reports-legacy' || !trigger.textContent?.includes('Save report'))
    return; event.preventDefault(); event.stopImmediatePropagation(); document.querySelector('.report-export-menu')?.remove(); const menu = document.createElement('div'); menu.className = 'report-export-menu'; menu.style.left = Math.min(trigger.getBoundingClientRect().left, window.innerWidth - 225) + 'px'; menu.style.top = (trigger.getBoundingClientRect().bottom + 6) + 'px'; const action = (label: string, run: () => void) => { const button = document.createElement('button'); button.textContent = label; button.onclick = () => { menu.remove(); run(); }; menu.append(button); }; action('Save report configuration', async () => { const auth = JSON.parse(localStorage.getItem('zetdc-auth') || '{}'); await fetch(API + '/reports', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.t}` }, body: JSON.stringify({ title: 'Fleet analytics report', config: { range: 'Selected reporting range', chart: 'Selected visualization' } }) }); alert('Report configuration saved.'); }); action('Save as PDF', () => window.print()); action('Export visualization image', () => { const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="100%" height="100%" fill="#e6f4ff"/><text x="70" y="100" font-size="42" fill="#063b7a">Zesa Wind Assessment System</text><text x="70" y="160" font-size="26" fill="#17324b">Fleet analytics visualization export</text><line x1="70" y1="500" x2="1130" y2="500" stroke="#087fc3" stroke-width="6"/><polyline points="70,430 240,350 390,410 570,260 750,340 930,190 1130,280" fill="none" stroke="#087fc3" stroke-width="14"/></svg>'; const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); link.download = 'zesa-wind-assessment.svg'; link.click(); URL.revokeObjectURL(link.href); }); action('Save to email', () => { const subject = encodeURIComponent('Zesa Wind Assessment Report'); const body = encodeURIComponent('Attached is the latest fleet analytics report from the Zesa Wind Assessment System.'); window.location.href = `mailto:?subject=${subject}&body=${body}`; }); document.body.append(menu); }, true);
const initComparisonTool = async () => { const filters = document.querySelector<HTMLElement>('.report-filters'); if (!filters || document.querySelector('.report-comparison'))
    return; const auth = JSON.parse(localStorage.getItem('zetdc-auth') || '{}'); const [turbines, metricData] = await Promise.all([fetch(API + '/turbines', { headers: { Authorization: `Bearer ${auth.t}` } }).then(r => r.json()), fetch(API + '/metrics', { headers: { Authorization: `Bearer ${auth.t}` } }).then(r => r.json())]); const panel = document.createElement('div'); panel.className = 'report-comparison'; panel.innerHTML = '<label>Compare by<select class="compare-type"><option value="turbine">Wind points</option><option value="province">Provinces</option></select></label><label>First selection<select class="compare-a"></select></label><label>Second selection<select class="compare-b"></select></label><button type="button">Compare</button><div class="comparison-result"></div>'; const type = panel.querySelector<HTMLSelectElement>('.compare-type')!, a = panel.querySelector<HTMLSelectElement>('.compare-a')!, b = panel.querySelector<HTMLSelectElement>('.compare-b')!, result = panel.querySelector<HTMLElement>('.comparison-result')!; const populate = () => { const items = type.value === 'turbine' ? turbines.map((x: any) => ({ name: x.name, data: x })) : metricData.provinces.map((x: any) => ({ name: x.province, data: x })); [a, b].forEach((select, index) => select.innerHTML = items.map((x: any, i: number) => `<option value="${i}" ${i === index ? 'selected' : ''}>${x.name}</option>`).join('')); (panel as any).items = items; }; populate(); type.onchange = populate; panel.querySelector('button')!.onclick = () => { const items = (panel as any).items, one = items[a.value], two = items[b.value]; const info = (item: any) => { const d = item.data, wind = Number(d.average_wind_speed || 0).toFixed(2), capacity = d.capacity_kw ? d.capacity_kw / 1000 : 'Fleet'; const generation = d.total_power_output != null ? (d.total_power_output / 1000).toFixed(2) : (Number(d.latest_power_output || 0) / 1000).toFixed(2); return `<article><strong>${item.name}</strong><span>Measured wind: ${wind} m/s</span><span>Estimated generation: ${generation} MW</span><span>Assessment capacity: ${capacity} MW</span></article>`; }; result.innerHTML = info(one) + info(two); result.classList.add('visible'); }; filters.append(panel); };
const initUniversalSave = () => { const path = window.location.pathname; if (!(/^\/summary\/|^\/turbines\/|^\/predictions/.test(path)))
    return; const title = document.querySelector<HTMLElement>('.page-title'); if (!title || title.querySelector('.universal-save-report'))
    return; const button = document.createElement('button'); button.className = 'compact universal-save-report'; button.textContent = 'Save report'; button.onclick = async () => { const auth = JSON.parse(localStorage.getItem('zetdc-auth') || '{}'); await fetch(API + '/reports', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.t}` }, body: JSON.stringify({ title: document.querySelector('h1')?.textContent + ' report', config: { route: path, created_from: 'report workspace' } }) }); alert('Report saved. Use the Reports page export menu for PDF, image, and email options.'); }; title.append(button); };
const initReportActions = () => { if (window.location.pathname !== '/reports')
    return; const primary = document.querySelector<HTMLButtonElement>('.report-filters>button'); if (primary) {
    primary.textContent = 'Show report';
    primary.classList.add('report-show');
} const chart = document.querySelector<HTMLElement>('.chart-panel.tall'); if (chart && !document.querySelector('.report-save-below')) {
    const save = document.createElement('button');
    save.className = 'compact report-save-below';
    save.textContent = 'Save report';
    chart.append(save);
} };
const enableMultiCompare = () => { const panel = document.querySelector<HTMLElement>('.report-comparison'); if (!panel || panel.querySelector('.compare-c'))
    return; panel.classList.add('multi-compare'); const a = panel.querySelector<HTMLSelectElement>('.compare-a')!, button = panel.querySelector('button')!, result = panel.querySelector<HTMLElement>('.comparison-result')!; ['Third selection', 'Fourth selection'].forEach((label, key) => { const field = document.createElement('label'); field.textContent = label; const select = document.createElement('select'); select.className = key ? 'compare-d' : 'compare-c'; select.innerHTML = a.innerHTML; select.value = String(key + 2); field.append(select); panel.insertBefore(field, button); }); button.onclick = () => { const items = (panel as any).items || [], selected = ['.compare-a', '.compare-b', '.compare-c', '.compare-d'].map(selector => items[Number(panel.querySelector<HTMLSelectElement>(selector)?.value || 0)]).filter(Boolean); const card = (item: any) => { const data = item.data, wind = Number(data.average_wind_speed || 0).toFixed(2), capacity = data.capacity_kw ? data.capacity_kw / 1000 : 'Fleet', generation = data.total_power_output != null ? (data.total_power_output / 1000).toFixed(2) : (Number(data.latest_power_output || 0) / 1000).toFixed(2); return `<article><strong>${item.name}</strong><span>Measured wind: ${wind} m/s</span><span>Estimated generation: ${generation} MW</span><span>Assessment capacity: ${capacity} MW</span></article>`; }; result.innerHTML = selected.map(card).join(''); result.classList.add('visible'); }; };
const applyVisualizationColors = () => { if (window.location.pathname !== '/reports')
    return; const colors = ['#087fc3', '#e3ad24', '#8a5cc4', '#19a974', '#df6257', '#e272b8', '#4b9ea8']; document.querySelectorAll<SVGElement>('.chart-panel.tall .recharts-bar-rectangle path,.chart-panel.tall .recharts-scatter-symbol').forEach((node, index) => { node.setAttribute('fill', colors[index % colors.length]); node.setAttribute('stroke', colors[index % colors.length]); }); document.querySelectorAll<SVGElement>('.chart-panel.tall .recharts-line-curve').forEach((node, index) => node.setAttribute('stroke', colors[index % colors.length])); };
const initReportTabs = async () => { if (window.location.pathname !== '/reports' || document.querySelector('.report-tabs'))
    return; const title = document.querySelector('.page-title'); if (!title)
    return; const auth = JSON.parse(localStorage.getItem('zetdc-auth') || '{}'); const [metrics, turbines] = await Promise.all([fetch(API + '/metrics', { headers: { Authorization: `Bearer ${auth.t}` } }).then(r => r.json()), fetch(API + '/turbines', { headers: { Authorization: `Bearer ${auth.t}` } }).then(r => r.json())]); const tabs = document.createElement('div'); tabs.className = 'report-tabs'; tabs.innerHTML = '<button class="active">Default reports</button><button>Modify reports</button>'; const defaults = document.createElement('section'); defaults.className = 'default-reports'; const fleet = metrics.fleet, online = turbines.filter((x: any) => x.status === 'operational').length, top = turbines[0]?.name || 'Fleet asset', worst = turbines.find((x: any) => x.status !== 'operational')?.name || turbines[turbines.length - 1]?.name; const groups = [['Executive Dashboard Reports', [['Total Energy Generated Today', (fleet.total_power_output / 1000).toFixed(1) + ' MWh'], ['Current Power Output', (fleet.total_power_output / 24 / 1000).toFixed(2) + ' MW'], ['Farm Availability', fleet.uptime + '%'], ['Turbines Online vs Offline', online + ' online / ' + (turbines.length - online) + ' offline'], ['Active Critical Alarms', String(fleet.anomalies)], ['Average Wind Speed', fleet.average_wind_speed + ' m/s'], ['CO2 Emissions Avoided', (fleet.total_power_output * .0004).toFixed(1) + ' t'], ['Revenue Estimate', '$' + (fleet.total_power_output * .08).toFixed(0)], ['Top Performing Turbine', top], ['Worst Performing Turbine', worst]]], ['Predictive Maintenance Reports', [['Remaining Useful Life (RUL)', 'Component health model'], ['Failure Probability by Component', 'Bearing, gearbox, blade'], ['Anomaly Detection Summary', fleet.anomalies + ' anomalies'], ['Bearing Wear Trends', 'Condition trend available'], ['Gearbox Failure Prediction', 'Risk monitored'], ['Blade Degradation Trends', 'Inspection trend'], ['Maintenance Recommendations', 'Prioritized actions']]], ['Operational Report Library', [['Energy Production', 'Daily and monthly generation'], ['Turbine Availability', 'Uptime and downtime'], ['Alarm & Fault Summary', 'Critical alarm events'], ['Downtime Analysis', 'Lost generation review'], ['Wind Resource Analysis', 'Wind profile and distribution'], ['Power Curve Performance', 'Wind-to-power correlation'], ['Maintenance History', 'Completed work orders'], ['Component Health', 'Asset condition overview'], ['Vibration Monitoring', 'Rotating equipment signals'], ['Temperature Monitoring', 'Thermal performance'], ['Grid Performance', 'Grid connection quality'], ['Curtailment Analysis', 'Production constraints'], ['Energy Loss Analysis', 'Availability loss breakdown'], ['Executive KPI Dashboard', 'Fleet executive summary'], ['Predictive Maintenance Summary', 'AI maintenance outlook']]]]; defaults.innerHTML = groups.map(([group, reports]: any) => `<div><h3>${group}</h3><div class="default-report-grid">${reports.map(([name, value]: string[]) => `<article class="default-report-card"><strong>${name}</strong><span>${group === 'Operational Report Library' ? value : 'Current fleet result'}</span><b>${group === 'Operational Report Library' ? 'View report' : value}</b><button>Open report</button></article>`).join('')}</div></div>`).join(''); title.after(tabs, defaults); const editing = () => [...document.querySelectorAll<HTMLElement>('.report-filters,.chart-panel,.table-panel')]; const showDefault = () => { defaults.style.display = 'grid'; editing().forEach(x => x.style.display = 'none'); tabs.children[0].classList.add('active'); tabs.children[1].classList.remove('active'); }; const showModify = () => { defaults.style.display = 'none'; editing().forEach(x => x.style.display = ''); tabs.children[0].classList.remove('active'); tabs.children[1].classList.add('active'); }; (tabs.children[0] as HTMLButtonElement).onclick = showDefault; (tabs.children[1] as HTMLButtonElement).onclick = showModify; showDefault(); };
document.addEventListener('click', event => { const button = (event.target as HTMLElement).closest('button'); if (button?.textContent === 'Show report') {
    event.preventDefault();
    event.stopImmediatePropagation();
    button.textContent = 'Report shown';
    setTimeout(() => button.textContent = 'Show report', 900);
} }, true);
function Login({ onLogin }: {
    onLogin: (u: User, t: string) => void;
}) { const [ec, setEc] = useState('ze9160517'), [password, setPassword] = useState('ZETDC2026!'), [error, setError] = useState(''); const submit = async (e: React.FormEvent) => { e.preventDefault(); setError(''); try { const r = await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ec_number: ec.trim(), password }) }); if (!r.ok) {
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
    const compactPageHeader = location.pathname.startsWith('/reports') || location.pathname === '/predictions' || location.pathname === '/environment';
    useEffect(() => { window.dispatchEvent(new Event('zetdc:route-ready')); });
    return <div className="shell"><aside><div className="logo"><span><Wind /></span><b>ZESA</b><small>WIND ASSESSMENT SYSTEM</small></div><nav>
    <NavLink to="/"><LayoutDashboard /> Overview</NavLink><NavLink to="/environment"><MapPin /> Environment</NavLink><NavLink to="/reports"><BarChart3 /> Reports</NavLink><NavLink to="/predictions"><Sparkles /> Predictions</NavLink><NavLink to="/history"><HistoryIcon /> History</NavLink>{user.role === 'admin' && <NavLink to="/admin"><Settings /> Administration</NavLink>}
  </nav><div className="sidebar-foot"><div className="user-avatar">{user.name.split(' ').map(x => x[0]).join('')}</div><div><strong>{user.name}</strong><small>{user.role} · {user.ec_number}</small></div><button aria-label="Sign out" title="Sign out" onClick={onLogout}><LogOut size={18}/></button></div></aside><section className={`workspace${compactPageHeader ? ' compact-page-header' : ''}`}><header><div><p className="eyebrow">NATIONAL RENEWABLES OPERATIONS</p><h2>Wind Generation Control</h2></div><div className="live"><i /> MEASURED DATA <span>8 WIND POINTS</span></div></header><Routes>
    <Route path="/" element={<Dashboard token={token}/>}/><Route path="/environment" element={<EnvironmentModule token={token}/>}/><Route path="/summary/:focus" element={<SummaryDetail token={token}/>}/><Route path="/turbines/:id" element={<TurbineDetail token={token}/>}/><Route path="/reports" element={<ReportsWorkspace />}/><Route path="/reports/analytics" element={<Analytics />}/><Route path="/reports/compare" element={<Compare />}/><Route path="/predictions" element={<PredictionsWorkspace />}/><Route path="/history" element={<HistoryWorkspace token={token}/>}/><Route path="/admin" element={user.role === 'admin' ? <Admin token={token}/> : <Navigate to="/"/>}/>
  </Routes></section></div>;
}
function Dashboard({ token }: {
    token: string;
}) {
    const [data, setData] = useState<any>();
    const [selected, setSelected] = useState<any>();

    useEffect(() => {
        Promise.all([fetchApi('/turbines', token), fetchApi('/metrics', token)])
            .then(([t, m]) => setData({ t, m }));
    }, [token]);

    if (!data) return <Loading />;

    const fleet = data.m.fleet;
    const stats = [
        ['Total wind points', String(data.t.length), 'active measurement sites'],
        ['Estimated energy', `${Number(fleet.energy_mwh || fleet.total_power_output / 1000).toFixed(1)} MWh`, 'wind energy formula'],
        ['Fleet wind speed', `${fleet.average_wind_speed} m/s`, 'measured average'],
        ['Data availability', `${fleet.uptime}%`, 'valid logger samples'],
    ];
    const turbineMetrics = (t: any) => ({
        wind: Number(t.average_wind_speed || 0).toFixed(2),
        output: (Number(t.latest_power_output || 0) / 1000).toFixed(2),
    });
    const siteComparison = data.t.map((site: any) => ({
        site: site.name,
        wind: Number(Number(site.average_wind_speed || 0).toFixed(2)),
    }));

    return <main className="content dashboard-content">
        <div className="stats">{stats.map(([a, b, c], i) => <article key={a}><span className={'stat-icon s' + i}>{i === 1 ? <Bolt /> : i === 2 ? <Wind /> : <Activity />}</span><div><small>{a}</small><strong>{b}</strong><em>{c}</em></div></article>)}</div>
        <div className="section-heading"><div><p className="eyebrow">GEOGRAPHIC VIEW</p><h3>Wind Points</h3></div><span className="legend"><i /> Reporting <i className="amber"/> Review</span></div>
        <div className="map-layout fleet-map-layout"><div className="map fleet-map"><div className="zimbabwe fleet-map-canvas"><span>Zimbabwe</span>{data.t.map((t: any) => { const metric = turbineMetrics(t); return <button key={t.id} className={'pin ' + (t.status === 'maintenance' ? 'maintenance' : '')} style={{ left: `${20 + (t.lon - 27) * 8}%`, top: `${24 + (-t.lat - 16) * 7}%` }} onMouseEnter={() => setSelected(t)} onFocus={() => setSelected(t)} onClick={() => setSelected(t)} aria-label={`View ${t.name}`}><img src="/turbine-marker.svg" alt=""/><span className="asset-tooltip"><strong>{t.name}</strong><span>{t.region} · {t.district}</span><span>Measured wind <b>{metric.wind} m/s</b></span><span>Estimated generation <b>{metric.output} MW</b></span><span>Latest record <b>{t.last_reading_at.slice(0, 10)}</b></span></span></button>; })}</div><div className="map-note">Select a wind point for its measured telemetry</div></div><aside className="province-panel">{selected ? (() => { const metric = turbineMetrics(selected); return <><p className="eyebrow">SELECTED WIND POINT</p><h3>{selected.name}</h3><p>{selected.region} · {selected.district} District</p><div className="detail-grid"><span>Logger status<b className={selected.status}>{selected.status}</b></span><span>Average wind<b>{metric.wind} m/s</b></span><span>Estimated generation<b>{metric.output} MW</b></span><span>Logger<b>{selected.source_id}</b></span></div></>; })() : <><p className="eyebrow">REGIONAL STATUS</p><h3>Regions</h3><p>Points use measured mast telemetry.</p><div className="province-list">{data.m.regions.slice(0, 5).map((item: any) => <div key={item.region}><span>{item.region}</span><b>{item.average_wind_speed} m/s</b></div>)}</div></>}</aside></div>
        <div className="section-heading"><div><p className="eyebrow">SITE COMPARISON</p><h3>Average measured wind speed by site</h3></div><span>All {siteComparison.length} available sites · m/s</span></div>
        <div className="chart-panel"><ResponsiveContainer width="100%" height={230}><BarChart data={siteComparison} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}><CartesianGrid stroke="#e8ece8" vertical={false}/><XAxis dataKey="site" tick={{ fontSize: 11 }}/><YAxis tick={{ fontSize: 11 }} unit=" m/s"/><Tooltip formatter={(value: number) => [`${value.toFixed(2)} m/s`, 'Average measured wind']}/><Bar dataKey="wind" name="Average measured wind" fill="#087fc3" radius={[5, 5, 0, 0]}/></BarChart></ResponsiveContainer></div>
    </main>;
}
function aggregate(rows: any[]) { const grouped: any = {}; rows.forEach(r => { let k = r.timestamp.slice(5, 13); (grouped[k] ??= { time: k, power: 0, wind: 0, count: 0 }).power += r.power_output; (grouped[k].wind += r.wind_speed); grouped[k].count++; }); return Object.values(grouped).map((x: any) => ({ ...x, power: Math.round(x.power / 1000), wind: +(x.wind / x.count).toFixed(1) })); }

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
    { key: 'wind_speed', label: 'Wind speed', unit: 'm/s', color: '#087fc3', decimals: 2 },
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
    const total = rows.reduce((sum, row) => sum + Number(row.energy_produced_mwh || 0), 0);

    return <main className="content wind-point-detail"><div className="page-title"><p className="eyebrow">MEASURED WIND POINT · DETAILS</p><h1>{asset.name}</h1><p>{asset.region} · {asset.district} District</p></div><div className="district-context"><article><small>ZETDC region</small><strong>{asset.region}</strong><span>{asset.district} District</span></article><article><small>Latest measurement</small><strong>{asset.last_reading_at.slice(0, 10)}</strong><span>Current telemetry status</span></article></div><div className="stats"><article><span className="stat-icon s2"><Wind /></span><div><small>Measured average wind</small><strong>{avg.toFixed(2)} m/s</strong><em>weekly average</em></div></article><article><span className="stat-icon s1"><Bolt /></span><div><small>Estimated energy</small><strong>{total.toFixed(2)} MWh</strong><em>wind energy formula</em></div></article><article><span className="stat-icon s3"><Activity /></span><div><small>Latest temperature</small><strong>{Number(asset.latest_temperature || 0).toFixed(1)} °C</strong><em>measured mast channel</em></div></article><article><span className="stat-icon s0"><Settings /></span><div><small>Logger status</small><strong className={asset.status}>{asset.status}</strong><em>{asset.reading_count.toLocaleString()} measurements</em></div></article></div>
        <WindPointPhoto asset={asset}/>
        <section className="chart-panel weekly-metrics-card"><div className="section-heading"><div><p className="eyebrow">WEEKLY MEASUREMENT HISTORY</p><h3>{metric.label} · daily average</h3></div><span>Latest seven days · no power metrics</span></div><div className="weekly-metric-picker" role="group" aria-label="Choose weekly metric">{weeklyMetricOptions.map(option => <button type="button" key={option.key} className={option.key === metricKey ? 'active' : ''} onClick={() => setMetricKey(option.key)}><i style={{ background: option.color }}/>{option.label}</button>)}</div><ResponsiveContainer width="100%" height={270}><LineChart data={rows} margin={{ top: 12, right: 18, left: 4, bottom: 0 }}><CartesianGrid stroke="#c9e3f5" vertical={false}/><XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={value => String(value).slice(5)}/><YAxis tick={{ fontSize: 11 }} width={62} unit={` ${metric.unit}`}/><Tooltip formatter={(value: number) => [`${Number(value).toFixed(metric.decimals)} ${metric.unit}`, metric.label]} labelFormatter={value => `Date ${value}`}/><Line type="monotone" dataKey={metric.key} name={metric.label} stroke={metric.color} strokeWidth={3} dot={{ r: 3, fill: '#fff', strokeWidth: 2 }} activeDot={{ r: 6 }} connectNulls/></LineChart></ResponsiveContainer></section>
    </main>;
}
function SummaryDetail({ token }: {
    token: string;
}) { const { focus = 'fleet' } = useParams(); const [assets, setAssets] = useState<any[]>([]); const [metrics, setMetrics] = useState<any>(); useEffect(() => { Promise.all([fetchApi('/turbines', token), fetchApi('/metrics', token)]).then(([t, m]) => { setAssets(t); setMetrics(m); }); }, [token]); if (!metrics)
    return <Loading />; const labels: any = { fleet: ['Wind assessment points', `All ${assets.length} measured points and their current logger state`], generation: ['Estimated generation summary', 'Wind energy formula estimates from measured wind speed and air density'], wind: ['Wind conditions', 'Measured average wind speed and site conditions'], availability: ['Data availability summary', 'Valid logger samples across all wind points'] }; const [title, note] = labels[focus] || labels.fleet; const value = focus === 'generation' ? `${Number(metrics.fleet.energy_mwh || metrics.fleet.total_power_output / 1000).toFixed(1)} MWh` : focus === 'wind' ? `${metrics.fleet.average_wind_speed} m/s` : focus === 'availability' ? `${metrics.fleet.uptime}%` : String(assets.length); return <main className="content"><div className="page-title"><p className="eyebrow">SUMMARY DRILL-DOWN</p><h1>{title}</h1><p>{note}</p></div><div className="stats"><article><span className="stat-icon s2">{focus === 'generation' ? <Bolt /> : focus === 'wind' ? <Wind /> : <Activity />}</span><div><small>Current fleet measure</small><strong>{value}</strong><em>wind energy formula</em></div></article></div><div className="table-panel"><div className="section-heading"><div><p className="eyebrow">POINT BREAKDOWN</p><h3>{focus === 'fleet' ? 'Wind point register' : 'Measured wind details'}</h3></div><button className="compact" onClick={() => navigateApp('/')}>Back to fleet map</button></div><table><thead><tr><th>Wind point</th><th>Location</th><th>Assessment capacity</th><th>{focus === 'wind' ? 'Average wind' : 'Status'}</th><th>{focus === 'generation' ? 'Estimated generation' : 'Profile'}</th></tr></thead><tbody>{assets.map(t => { const wind = Number(t.average_wind_speed || 0).toFixed(2), generation = (Number(t.latest_power_output || 0) / 1000).toFixed(2); return <tr className="summary-row" key={t.id} onClick={() => navigateApp('/turbines/' + t.id)}><td>{t.name}</td><td>{t.province}</td><td>{t.capacity_kw / 1000} MW</td><td>{focus === 'wind' ? wind + ' m/s' : <b className={t.status}>{t.status}</b>}</td><td>{focus === 'generation' ? generation + ' MW' : 'Open profile'}</td></tr>; })}</tbody></table></div></main>; }
function Reports({ token }: {
    token: string;
}) { const today = new Date().toISOString().slice(0, 10); const [rows, setRows] = useState<any[]>([]), [chart, setChart] = useState('line'), [period, setPeriod] = useState(14), [start, setStart] = useState(''), [end, setEnd] = useState(today), [saved, setSaved] = useState<any[]>([]); useEffect(() => { fetchApi('/readings?days=' + period, token).then(r => setRows(aggregate(r))); fetchApi('/reports', token).then(setSaved); }, [token, period]); const save = async () => { const title = `Fleet ${chart} analysis`; const r = await fetch(API + '/reports', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ title, config: { range: start && end ? start + ' to ' + end : 'Last ' + period + ' days', chart } }) }); setSaved([...saved, await r.json()]); }; const hover = <Tooltip contentStyle={{ background: '#063b7a', border: '1px solid #167bc0', borderRadius: 8, color: '#fff' }} labelStyle={{ color: '#9ce4ff' }} formatter={(value: any, name: any) => [value, name === 'power' ? 'Generation (MW)' : 'Wind speed (m/s)']}/>; const trend = <ResponsiveContainer width="100%" height={360}><LineChart data={rows}><CartesianGrid stroke="#c9e3f5" vertical={false}/><XAxis dataKey="time"/><YAxis /><Tooltip contentStyle={{ background: '#063b7a', border: '1px solid #167bc0', borderRadius: 8, color: '#fff' }}/><Line type="monotone" dataKey="power" name="Generation (MW)" stroke="#087fc3" strokeWidth={3} dot={false} activeDot={{ r: 6 }}/><Line type="monotone" dataKey="wind" name="Wind speed (m/s)" stroke="#e3ad24" strokeWidth={2} dot={false} activeDot={{ r: 5 }}/></LineChart></ResponsiveContainer>; const visualization = chart === 'bar' ? <ResponsiveContainer width="100%" height={360}><BarChart data={rows}><CartesianGrid stroke="#c9e3f5" vertical={false}/><XAxis dataKey="time"/><YAxis />{hover}<Bar dataKey="power" name="Generation (MW)" fill="#087fc3" radius={[5, 5, 0, 0]}/></BarChart></ResponsiveContainer> : chart === 'area' ? <ResponsiveContainer width="100%" height={360}><AreaChart data={rows}><defs><linearGradient id="reportPower" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#138bd0" stopOpacity=".65"/><stop offset="1" stopColor="#138bd0" stopOpacity=".04"/></linearGradient></defs><CartesianGrid stroke="#c9e3f5" vertical={false}/><XAxis dataKey="time"/><YAxis />{hover}<Area dataKey="power" name="Generation (MW)" stroke="#087fc3" fill="url(#reportPower)" strokeWidth={3}/></AreaChart></ResponsiveContainer> : chart === 'scatter' ? <ResponsiveContainer width="100%" height={360}><ScatterChart><CartesianGrid stroke="#c9e3f5"/><XAxis dataKey="wind" name="Wind speed" unit=" m/s"/><YAxis dataKey="power" name="Generation" unit=" MW"/>{hover}<Scatter data={rows} fill="#087fc3"/></ScatterChart></ResponsiveContainer> : chart === 'distribution' ? <ResponsiveContainer width="100%" height={360}><BarChart data={rows.slice(-24)}><CartesianGrid stroke="#c9e3f5" vertical={false}/><XAxis dataKey="time"/><YAxis />{hover}<Bar dataKey="wind" name="Wind speed" fill="#e3ad24" radius={[5, 5, 0, 0]}/></BarChart></ResponsiveContainer> : trend; return <main className="content"><PageTitle title="Reports" note="Explore fleet generation through interactive operational analytics."/><div className="filters report-filters"><label>Quick range<select value={period} onChange={e => setPeriod(Number(e.target.value))}><option value="1">Last 24 hours</option><option value="3">Last 3 days</option><option value="7">Last 7 days</option><option value="14">Last 14 days</option><option value="30">Last 30 days</option></select></label><label>From<input type="date" value={start} onChange={e => setStart(e.target.value)}/></label><label>To<input type="date" value={end} onChange={e => setEnd(e.target.value)}/></label><label>Asset scope<select><option>All turbines</option><option>By province</option><option>Individual turbine</option></select></label><label>Visualization<select value={chart} onChange={e => setChart(e.target.value)}><option value="line">Dual-line trend</option><option value="area">Generation area</option><option value="bar">Generation bars</option><option value="scatter">Wind/power correlation</option><option value="distribution">Hourly wind profile</option></select></label><button onClick={save}><FileText size={16}/> Save report</button></div><div className="chart-panel tall"><div className="section-heading"><div><p className="eyebrow">INTERACTIVE ANALYTICS</p><h3>{chart === 'scatter' ? 'Wind speed vs generation' : chart === 'distribution' ? 'Hourly wind-speed profile' : 'Fleet production timeline'}</h3></div><span>Hover any point, bar, or line to inspect the recorded value</span></div>{visualization}</div><div className="table-panel"><div className="section-heading"><h3>Saved reports</h3><span>{saved.length} saved</span></div>{saved.length ? <table><thead><tr><th>Title</th><th>Configuration</th><th>Created by</th></tr></thead><tbody>{saved.map(r => <tr key={r.id}><td>{r.title}</td><td>{r.config.range} · {r.config.chart}</td><td>{r.created_by}</td></tr>)}</tbody></table> : <p className="empty">No saved reports yet.</p>}</div></main>; }
function Predictions({ token }: {
    token: string;
}) { const [p, setP] = useState<any>(); useEffect(() => { fetchApi('/predictions?days=90', token).then(setP); }, [token]); if (!p)
    return <Loading />; return <main className="content"><PageTitle title="Predictions" note="Seasonal projections with uncertainty bands based on the current data history."/><div className="forecast-note"><Sparkles /><div><b>Confidence: provisional</b><span>{p.model_version} · Hold-out MAE {p.backtest_mae} m/s. Long-range forecasts become more reliable as operational history accumulates.</span></div></div><div className="filters"><label>Forecast horizon<select><option>90 days</option><option>180 days</option></select></label><label>Metric<select><option>Wind speed</option><option>Power output</option></select></label><label>Asset scope<select><option>Fleet average</option></select></label></div><div className="chart-panel tall"><ResponsiveContainer width="100%" height={350}><AreaChart data={p.data}><CartesianGrid stroke="#e8ece8" vertical={false}/><XAxis dataKey="date" tick={{ fontSize: 11 }} interval={14}/><YAxis /><Tooltip /><Area type="monotone" dataKey="upper" stroke="none" fill="#b8d9d2" fillOpacity={.6}/><Area type="monotone" dataKey="lower" stroke="none" fill="#fff"/><Line type="monotone" dataKey="wind_speed" stroke="#0f6e64" strokeWidth={2}/></AreaChart></ResponsiveContainer></div></main>; }

const historyMonthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const historyMetricColors: Record<string, string> = {
    wind_speed: '#087fc3', temperature: '#e5892e', humidity: '#8a5cc4',
    air_pressure: '#2a9b70', air_density: '#4d9dca', availability_pct: '#d49e16', data_quality_pct: '#d85e76',
};

const historyExportColumns = [
    ['Date', (day: any) => day.date],
    ['Wind speed (m/s)', (day: any) => day.metrics.wind_speed],
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

function HistoryWorkspace({ token }: { token: string }) {
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
    }, [token]);

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
        const digits = key === 'air_density' ? 4 : key === 'wind_speed' ? 2 : 1;
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

        <section className="history-step history-month-step"><header><b>04</b><div><p className="eyebrow">MONTH</p><h2>{metric.label} · {year}</h2></div><span>{scopeName} · {sourceLabel}</span></header><div className="history-month-grid">{historyMonthNames.map((name, index) => { const item = yearRows.find((row: any) => row.month === index + 1); const scoped = monthScope(item); const hasData = scoped?.metrics?.[metricKey] != null; return <button type="button" key={name} disabled={!hasData} className={`${hasData ? 'has-data' : 'no-data'} ${month === index + 1 && hasData ? 'active' : ''}`} onClick={() => openMonth(index + 1)}><small>{String(index + 1).padStart(2, '0')}</small><strong>{name}</strong><span>{hasData ? formatValue(scoped.metrics[metricKey]) : 'No data'}</span>{hasData && <em><i/> Monthly average · {pointId === 'all' ? `${item.wind_points} points` : scopeName}</em>}</button>; })}</div></section>

        {selected ? <div className="history-modal" role="dialog" aria-modal="true" aria-labelledby="history-dialog-title"><section className="history-detail"><header><div><p className="eyebrow">DAILY HISTORY DRILL-DOWN</p><h2 id="history-dialog-title">{historyMonthNames[selected.month - 1]} {selected.year}</h2><span>{metric.label} day by day · {scopeName}</span></div><div className="history-detail-heading-actions"><strong style={{ color: metric.color }}>{formatValue(selectedScope.metrics[metricKey])}</strong><button type="button" className="history-close" onClick={() => setMonth(null)} aria-label="Close daily history drill-down"><X/></button></div></header><div className="history-export-bar"><div className="history-export-intro"><b>Daily measurement register</b><span>Excel creates {registerPoints.length} wind-point worksheet tabs. Copy, email, and share use the active register tab.</span></div><label className="history-popup-scope"><span>Graph scope</span><select value={pointId} onChange={event => { const value = event.target.value; setPointId(value); if (value !== 'all') setRegisterPointId(value); setExportStatus(''); }}><option value="all">All wind points</option>{selected.points.map((point: any) => <option key={point.turbine_id} value={String(point.turbine_id)}>{point.name}</option>)}</select></label><div className="history-export-actions"><button type="button" onClick={copyData}><Copy/>Copy active tab</button><button type="button" onClick={downloadExcel}><Download/>Export Excel</button><button type="button" onClick={emailData}><Mail/>Email active tab</button><button type="button" className="primary" onClick={shareData}><Share2/>Share / save</button></div>{exportStatus && <p className="history-export-status" role="status" aria-live="polite">{exportStatus}</p>}</div><div className="history-average-note"><b>{scopeName}</b><span>Metric figures in the summary cards are averages for the selected month and wind-point scope. Measurement counts are monthly totals.</span></div><div className="history-detail-kpis"><article><small>Monthly average</small><strong>{formatValue(selectedScope.metrics[metricKey])}</strong><span>{metric.label} · {scopeName}</span></article><article><small>Measurements</small><strong>{selectedScope.records.toLocaleString()}</strong><span>{scopeName} monthly total</span></article><article><small>Reporting wind points</small><strong>{pointId === 'all' ? selected.wind_points : 1}</strong><span>{scopeName}</span></article></div><div className="history-chart"><div className="history-chart-heading"><div><p className="eyebrow">DAILY TREND</p><h3>{metric.label} by day · {scopeName}</h3></div><span>{dailyChart.length} recorded day{dailyChart.length === 1 ? '' : 's'}</span></div><ResponsiveContainer width="100%" height={270}><LineChart data={dailyChart} margin={{ top: 12, right: 18, left: 5, bottom: 5 }}><CartesianGrid stroke="#dceaf3" vertical={false}/><XAxis dataKey="day" tick={{ fontSize: 10 }}/><YAxis tick={{ fontSize: 10 }} unit={` ${metric.unit}`}/><Tooltip labelFormatter={(_, payload) => `${payload?.[0]?.payload?.date || ''} · ${scopeName}`} formatter={(value: number) => [formatValue(value), metric.label]}/><Line type="monotone" dataKey="value" name={`${metric.label} · ${scopeName}`} stroke={metric.color} strokeWidth={3} dot={{ r: 3, fill: '#fff', strokeWidth: 2 }} activeDot={{ r: 6 }}/></LineChart></ResponsiveContainer></div><div className="history-daily-table"><header><div><p className="eyebrow">DAY-BY-DAY RECORDING</p><h3>Daily measurement register</h3></div><span>{registerScopeName} · {registerDays.length} recorded days</span></header><div className="history-register-tabs" role="tablist" aria-label="Available wind points for the selected month and metric">{registerPoints.map((point: any) => { const tabId = String(point.turbine_id); const active = String(activeRegisterPoint?.turbine_id) === tabId; return <button type="button" role="tab" id={`history-register-tab-${tabId}`} aria-selected={active} key={tabId} className={active ? 'active' : ''} onClick={() => { setRegisterPointId(tabId); setExportStatus(''); }}><span>{point.name.replace(/ Wind Point$/i, '')}</span><small>{point.records.toLocaleString()} records</small></button>; })}</div><div role="tabpanel" aria-labelledby={`history-register-tab-${activeRegisterPoint?.turbine_id || ''}`}><table><thead><tr><th>Date</th><th>Wind speed</th><th>Temperature</th><th>Humidity</th><th>Air pressure</th><th>Air density</th><th>Availability</th><th>Data quality</th><th>Measurements</th></tr></thead><tbody>{registerDays.map((day: any) => <tr key={day.date}><td><strong>{day.date}</strong></td><td>{formatMetricValue('wind_speed', day.metrics.wind_speed)}</td><td>{formatMetricValue('temperature', day.metrics.temperature)}</td><td>{formatMetricValue('humidity', day.metrics.humidity)}</td><td>{formatMetricValue('air_pressure', day.metrics.air_pressure)}</td><td>{formatMetricValue('air_density', day.metrics.air_density)}</td><td>{formatMetricValue('availability_pct', day.metrics.availability_pct)}</td><td>{formatMetricValue('data_quality_pct', day.metrics.data_quality_pct)}</td><td>{day.records.toLocaleString()}</td></tr>)}</tbody></table></div></div></section></div> : <section className="history-empty"><HistoryIcon/><h2>Select a month to view its daily history</h2><p>Choose a green month to open the {scopeName} full-page measurement register.</p></section>}
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
