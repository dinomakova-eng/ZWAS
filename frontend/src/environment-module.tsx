import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';

const IRENA_WMS = 'https://irena-ga.azurewebsites.net/geoserver/wms';
const IRENA_LAYER = 'vortex:M.100.year';
const ZIMBABWE_VIEW: L.LatLngBoundsExpression = [[-22.55, 25.15], [-15.55, 33.15]];

const focusZimbabwe = (map: L.Map) => {
  map.fitBounds(ZIMBABWE_VIEW, { padding: [16, 16] });
  map.setZoom(map.getZoom() + .75);
};

type EnvironmentModuleProps = {
  token: string;
};

type Turbine = {
  id: number;
  name: string;
  lat: number;
  lon: number;
  region?: string;
  district?: string;
  source_id?: string;
  status?: string;
  average_wind_speed?: number;
  wind_speed_stddev?: number;
  latest_wind_speed?: number;
  latest_wind_direction?: number;
  latest_temperature?: number;
  latest_humidity?: number;
  latest_air_pressure?: number;
  latest_air_density?: number;
  last_reading_at?: string;
};

type LiveWindResponse = {
  metadata?: {
    provider?: string;
    collected_at?: string;
    stale?: boolean;
  };
  stations?: Turbine[];
};

type OsmLocation = {
  name?: string;
  display_name?: string;
  feature_type?: string;
  source?: string;
};

type WindWindowStats = {
  average: number;
  minimum: number;
  maximum: number;
  start_date: string;
  end_date: string;
  days: number;
  samples?: number;
};

type WindDailyStats = {
  date: string;
  average: number;
  minimum: number;
  maximum: number;
  samples?: number;
};

type EnvironmentWindSummary = {
  point: { latitude: number; longitude: number; region?: string; district?: string };
  closest_wind_point: {
    id: number;
    name: string;
    latitude: number;
    longitude: number;
    distance_km: number;
    region?: string;
    district?: string;
  };
  observed: {
    live: WindWindowStats | null;
    mast: WindWindowStats | null;
    live_daily: WindDailyStats[];
    mast_daily: WindDailyStats[];
  };
  forecast: {
    live: WindWindowStats | null;
    mast: WindWindowStats | null;
    blended: WindWindowStats | null;
    daily: Array<{ date: string; wind_speed: number; lower: number; upper: number }>;
  };
  method: {
    label: string;
    live_weight_pct: number;
    mast_weight_pct: number;
    mast_model?: string;
    mast_model_mae?: number | null;
    live_available: boolean;
  };
};

type PopupGridContext = {
  nearestSubstation: { name: string; distance: number } | null;
  nearestTransformer: { name: string; distance: number } | null;
};

type Selection = {
  label: string;
  title: string;
  note: string;
  rows: Array<[string, string]>;
  latitude?: number;
  longitude?: number;
  nearby?: NearbyAsset[];
};

type NearbyAsset = {
  kind: string;
  name: string;
  distance: number;
  latitude: number;
  longitude: number;
};

type LayerKey = 'annualWind' | 'liveWind' | 'mastWind' | 'regions' | 'overhead' | 'cables' | 'stations' | 'transformers';

const layerLabels: Array<{ key: LayerKey; label: string; className: string }> = [
  { key: 'annualWind', label: 'IRENA annual wind · 100 m', className: 'wind' },
  { key: 'liveWind', label: 'Live wind conditions · 10 m', className: 'live-wind' },
  { key: 'mastWind', label: 'Latest ZESA mast observations', className: 'mast-wind' },
  { key: 'regions', label: 'ZETDC regional boundaries', className: 'regions' },
  { key: 'overhead', label: 'ZESA overhead lines · 11/33/88–330 kV', className: 'overhead voltage-lines' },
  { key: 'cables', label: 'ZESA underground cables', className: 'cable' },
  { key: 'stations', label: 'ZESA substations / stations', className: 'station' },
  { key: 'transformers', label: 'ZESA transformers', className: 'transformer' },
];

const initialLayerVisibility: Record<LayerKey, boolean> = {
  annualWind: true,
  liveWind: true,
  mastWind: true,
  regions: true,
  overhead: true,
  cables: true,
  stations: true,
  transformers: true,
};

type MapSummary = {
  mastPoints: number;
  livePoints: number;
  stations: number;
  transformers: number;
  routes: number;
};

const emptySummary: MapSummary = { mastPoints: 0, livePoints: 0, stations: 0, transformers: 0, routes: 0 };

const safeText = (value: unknown) => String(value ?? 'Not listed').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

const distanceLabel = (metres: number) => metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;

const resourceBand = (windSpeed: number) => {
  if (windSpeed < 4) return 'Low';
  if (windSpeed < 6) return 'Moderate';
  if (windSpeed < 7.5) return 'Good';
  return 'Strong';
};

const windColor = (windSpeed: number) => {
  if (windSpeed < 4) return '#2f80ed';
  if (windSpeed < 6) return '#00b8a9';
  if (windSpeed < 7.5) return '#f2c94c';
  return '#eb5757';
};

const compactWindValue = (value: number | undefined) => Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—';
const compactDayDate = (value: string) => new Intl.DateTimeFormat('en-ZW', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));

const observedDayCell = (stats?: WindDailyStats) => stats
  ? `<span class="environment-observed-cell"><small>${compactDayDate(stats.date)}</small><strong>${compactWindValue(stats.average)} avg</strong><em>${compactWindValue(stats.minimum)}–${compactWindValue(stats.maximum)}</em></span>`
  : '<span class="environment-observed-cell unavailable"><small>No source day</small><strong>—</strong><em>—</em></span>';

const observedDailyRows = (summary: EnvironmentWindSummary) => Array.from({ length: 7 }, (_, index) => `
  <div class="environment-observed-row">
    <b>${index + 1}</b>
    ${observedDayCell(summary.observed.live_daily[index])}
    ${observedDayCell(summary.observed.mast_daily[index])}
  </div>`).join('');

const forecastDailyRows = (summary: EnvironmentWindSummary) => summary.forecast.daily.slice(0, 7).map(row => `
  <div class="environment-forecast-row">
    <b>${compactDayDate(row.date)}</b>
    <span>${compactWindValue(row.wind_speed)}</span>
    <span>${compactWindValue(row.lower)}</span>
    <span>${compactWindValue(row.upper)}</span>
  </div>`).join('');

const windWindowLabel = (stats: WindWindowStats | null) => stats
  ? `${stats.average.toFixed(2)} avg · ${stats.minimum.toFixed(2)}–${stats.maximum.toFixed(2)} m/s`
  : 'Not available';

const windAnalysisPopup = (
  title: string,
  point: L.LatLng,
  summary: EnvironmentWindSummary | null,
  gridContext: PopupGridContext,
  pending = true,
) => {
  const nearest = summary?.closest_wind_point;
  const method = summary?.method;
  const methodLabel = method?.live_available
    ? `${method.live_weight_pct}% live model · ${method.mast_weight_pct}% mast calibration`
    : 'Mast forecast fallback · live model unavailable';
  return `<div class="environment-wind-popup">
    <header><small>DAILY WIND DETAIL</small><strong>${safeText(title)}</strong><span>${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}</span></header>
    <div class="environment-point-context">
      <span><small>ZESA region</small><b>${safeText(summary?.point.region || 'Locating…')}</b></span>
      <span><small>ZESA district</small><b>${safeText(summary?.point.district || 'Locating…')}</b></span>
      <span><small>Closest wind point</small><b>${safeText(nearest?.name || 'Locating…')}</b>${nearest ? `<em>${nearest.distance_km.toFixed(1)} km</em>` : ''}</span>
      <span><small>Nearest substation</small><b>${safeText(gridContext.nearestSubstation?.name || 'Not available')}</b>${gridContext.nearestSubstation ? `<em>${distanceLabel(gridContext.nearestSubstation.distance)}</em>` : ''}</span>
      <span><small>Nearest transformer</small><b>${safeText(gridContext.nearestTransformer?.name || 'Not available')}</b>${gridContext.nearestTransformer ? `<em>${distanceLabel(gridContext.nearestTransformer.distance)}</em>` : ''}</span>
    </div>
    ${summary ? `<div class="environment-wind-daily-layout"><section><div class="environment-wind-section-title"><b>Previous 7 source days</b><span>daily avg · min–max m/s</span></div><div class="environment-observed-table"><div class="environment-observed-row heading"><b>Day</b><span>Live 10 m</span><span>ZESA mast</span></div>${observedDailyRows(summary)}</div></section><section><div class="environment-wind-section-title"><b>Next 7 days</b><span>best estimate · m/s</span></div><div class="environment-forecast-table"><div class="environment-forecast-row heading"><b>Date</b><span>Avg</span><span>Min</span><span>Max</span></div>${forecastDailyRows(summary)}</div></section></div><footer>${safeText(methodLabel)}</footer>` : pending ? '<div class="environment-wind-loading"><i></i><span>Preparing observed and forecast wind…</span></div>' : '<div class="environment-wind-loading unavailable"><span>Seven-day wind analysis is temporarily unavailable.</span></div>'}
  </div>`;
};

const routeDistance = (point: L.LatLng, feature: any) => {
  const lines = feature.geometry?.type === 'MultiLineString' ? feature.geometry.coordinates : [feature.geometry?.coordinates || []];
  const latitudeScale = 110540;
  const longitudeScale = 111320 * Math.cos(point.lat * Math.PI / 180);
  const px = point.lng * longitudeScale;
  const py = point.lat * latitudeScale;
  let closest = { distance: Number.POSITIVE_INFINITY, latitude: Number(feature.properties?.measure_lat), longitude: Number(feature.properties?.measure_lon) };
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      const [lonA, latA] = line[index - 1];
      const [lonB, latB] = line[index];
      const ax = lonA * longitudeScale;
      const ay = latA * latitudeScale;
      const bx = lonB * longitudeScale;
      const by = latB * latitudeScale;
      const dx = bx - ax;
      const dy = by - ay;
      const denominator = dx * dx + dy * dy;
      const amount = denominator ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denominator)) : 0;
      const x = ax + amount * dx;
      const y = ay + amount * dy;
      const distance = Math.hypot(px - x, py - y);
      if (distance < closest.distance) closest = { distance, latitude: y / latitudeScale, longitude: x / longitudeScale };
    }
  }
  return closest;
};

export function EnvironmentModule({ token }: EnvironmentModuleProps) {
  const mapElementRef = useRef<HTMLDivElement>(null);
  const analysisPopupRef = useRef<HTMLDivElement>(null);
  const leafletMapRef = useRef<L.Map | null>(null);
  const windLayerRef = useRef<L.TileLayer.WMS | null>(null);
  const mapLayersRef = useRef<Partial<Record<LayerKey, L.Layer>>>({});
  const queryMarkerRef = useRef<L.CircleMarker | null>(null);
  const [summary, setSummary] = useState<MapSummary>(emptySummary);
  const [opacity, setOpacity] = useState(68);
  const [layerVisibility, setLayerVisibility] = useState(initialLayerVisibility);
  const [copyStatus, setCopyStatus] = useState('');
  const [status, setStatus] = useState('Loading annual, live, mast and ZESA spatial layers…');
  const [selection, setSelection] = useState<Selection>({
    label: 'MAP INSPECTOR',
    title: 'Explore Zimbabwe',
    note: 'Select a live wind halo, ZESA mast, grid asset, or any location on the map.',
    rows: [['Wind data', 'Live conditions, ZESA mast observations and IRENA annual mean'], ['Map interaction', 'Pan, zoom and inspect']],
  });

  useEffect(() => {
    if (!mapElementRef.current) return;

    const controller = new AbortController();
    let disposed = false;
    let inspectionSequence = 0;
    let analysisPoint: L.LatLng | null = null;
    let inspectPoint: (point: L.LatLng) => void = () => undefined;

    const positionAnalysisPopup = () => {
      const popup = analysisPopupRef.current;
      if (!analysisPoint || !popup || popup.hidden) return;
      popup.style.left = '50%';
      popup.style.top = '50%';
    };

    const closeAnalysisPopup = () => {
      analysisPoint = null;
      if (analysisPopupRef.current) analysisPopupRef.current.hidden = true;
    };

    const showAnalysisPopup = (point: L.LatLng, content: string) => {
      const popup = analysisPopupRef.current;
      if (!popup) return;
      analysisPoint = point;
      popup.innerHTML = `<button type="button" class="environment-analysis-close" aria-label="Close wind analysis">×</button>${content}`;
      popup.hidden = false;
      popup.querySelector<HTMLButtonElement>('.environment-analysis-close')?.addEventListener('click', closeAnalysisPopup, { once: true });
      requestAnimationFrame(positionAnalysisPopup);
    };

    // Show the navigable map immediately. The large infrastructure register
    // continues loading without holding the whole page behind a blank panel.
    const map = L.map(mapElementRef.current, {
      zoomControl: true,
      minZoom: 5,
      maxZoom: 16,
      zoomSnap: .25,
      preferCanvas: true,
    });
    map.on('move zoom resize', positionAnalysisPopup);
    window.addEventListener('resize', positionAnalysisPopup);
    leafletMapRef.current = map;
    map.createPane('windResource');
    map.getPane('windResource')!.style.zIndex = '240';
    map.createPane('regionalBoundaries');
    map.getPane('regionalBoundaries')!.style.zIndex = '360';
    map.createPane('gridRoutes');
    map.getPane('gridRoutes')!.style.zIndex = '420';
    map.createPane('gridAssets');
    map.getPane('gridAssets')!.style.zIndex = '460';
    map.createPane('liveWind');
    map.getPane('liveWind')!.style.zIndex = '500';
    map.createPane('windSites');
    map.getPane('windSites')!.style.zIndex = '520';

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    const windResource = L.tileLayer.wms(IRENA_WMS, {
      layers: IRENA_LAYER,
      styles: 'ku_wind_speed',
      format: 'image/png',
      transparent: true,
      version: '1.1.1',
      opacity: opacity / 100,
      pane: 'windResource',
      attribution: 'IRENA Global Atlas · Vortex wind resource',
    }).addTo(map);
    windLayerRef.current = windResource;
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
    focusZimbabwe(map);
    requestAnimationFrame(() => map.invalidateSize());

    const json = async (url: string, options?: RequestInit) => {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      return response.json();
    };

    const featureCollection = (features: any[]): any => ({ type: 'FeatureCollection', features });
    const pointFeatures = (features: any[]) => featureCollection(features.map(feature => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(feature.properties.measure_lon), Number(feature.properties.measure_lat)] },
      properties: feature.properties,
    })).filter(feature => Number.isFinite(feature.geometry.coordinates[0]) && Number.isFinite(feature.geometry.coordinates[1])));

    const assetPopup = (properties: any) => {
      const kind = String(properties.asset_type || 'grid asset').replace('_', ' ');
      const voltage = properties.voltage_kv ? `${Number(properties.voltage_kv)} kV` : 'Not listed';
      const capacity = properties.capacity_kva
        ? `${Number(properties.capacity_kva).toLocaleString()} kVA`
        : properties.capacity ? `${Number(properties.capacity).toLocaleString()} kVA` : 'Not listed';
      const spans = Number(properties.segment_count || 0);
      return `<div class="environment-popup"><small>ZESA ${safeText(kind).toUpperCase()}</small><strong>${safeText(properties.label)}</strong><span>Voltage <b>${safeText(voltage)}</b></span>${spans ? `<span>Mapped spans <b>${spans.toLocaleString()}</b></span>` : ''}<span>Capacity <b>${safeText(capacity)}</b></span><span>Status <b>${safeText(properties.status || 'Not listed')}</b></span></div>`;
    };

    const initialise = async () => {
      try {
        const [regions, grid, turbines, liveResponse] = await Promise.all([
          json('/gis/zetdc-regions.geojson'),
          json('/gis/zesa-grid-infrastructure.geojson'),
          json('/api/turbines', { headers: { Authorization: `Bearer ${token}` } }),
          json('/api/live-wind', { headers: { Authorization: `Bearer ${token}` } }).catch(() => null),
        ]) as [any, any, Turbine[], LiveWindResponse | null];
        if (disposed || !mapElementRef.current) return;

        const liveStations = liveResponse?.stations || [];

        const gridFeatures: any[] = grid.features || [];
        const stations = gridFeatures.filter(feature => feature.properties?.asset_type === 'station');
        const substations = stations.filter(feature => String(feature.properties?.station_type || '').toUpperCase() === 'SUBSTATION');
        const transformers = gridFeatures.filter(feature => feature.properties?.asset_type === 'transformer');
        const overheadRoutes = gridFeatures.filter(feature => feature.properties?.asset_type === 'overhead');
        const cableRoutes = gridFeatures.filter(feature => feature.properties?.asset_type === 'cable');

        setSummary({
          mastPoints: turbines.length,
          livePoints: liveStations.length,
          stations: stations.length,
          transformers: transformers.length,
          routes: [...overheadRoutes, ...cableRoutes].reduce((total, feature) => total + Number(feature.properties?.segment_count || 1), 0),
        });

        const regionLayer = L.geoJSON(regions, {
          pane: 'regionalBoundaries',
          style: { color: '#f7fbff', weight: 2, opacity: .95, fillColor: '#ffffff', fillOpacity: .025 },
          onEachFeature: (feature, layer) => layer.bindTooltip(String(feature.properties?.province || 'ZETDC region'), { sticky: true }),
        }).addTo(map);

        const overheadLayer = L.geoJSON(featureCollection(overheadRoutes), {
          pane: 'gridRoutes',
          style: feature => {
            const voltage = Number(feature?.properties?.voltage_kv || 0);
            if (voltage === 11) return {color: '#ffd43b', weight: 1.05, opacity: .74};
            if (voltage === 33) return {color: '#ff7b39', weight: 1.65, opacity: .86};
            return {color: voltage >= 330 ? '#ef3340' : '#1f7a4d', weight: voltage >= 330 ? 3.4 : 2.5, opacity: .94};
          },
          onEachFeature: (feature, layer) => {
            layer.bindPopup(assetPopup(feature.properties));
            layer.on('click', () => setSelection({
              label: 'ZESA OVERHEAD LINE',
              title: feature.properties?.label || 'Transmission route',
              note: 'Grid infrastructure route from the ZESA spatial register.',
              rows: [['Voltage', feature.properties?.voltage_kv ? `${feature.properties.voltage_kv} kV` : 'Not listed'], ['Mapped spans', feature.properties?.segment_count ? Number(feature.properties.segment_count).toLocaleString() : '1'], ['Status', feature.properties?.status || 'Not listed']],
            }));
          },
        }).addTo(map);

        const cableLayer = L.geoJSON(featureCollection(cableRoutes), {
          pane: 'gridRoutes',
          style: { color: '#d457ff', weight: 3, opacity: .9, dashArray: '7 5' },
          onEachFeature: (feature, layer) => {
            layer.bindPopup(assetPopup(feature.properties));
            layer.on('click', () => setSelection({
              label: 'ZESA UNDERGROUND CABLE',
              title: feature.properties?.label || 'Cable route',
              note: 'Underground infrastructure route from the ZESA spatial register.',
              rows: [['Voltage', feature.properties?.voltage_kv ? `${feature.properties.voltage_kv} kV` : 'Not listed'], ['Status', feature.properties?.status || 'Not listed']],
            }));
          },
        }).addTo(map);

        const makeAssetLayer = (features: any[], type: 'station' | 'transformer') => L.geoJSON(pointFeatures(features), {
          pane: 'gridAssets',
          pointToLayer: (feature, latlng) => {
            const voltage = Number(feature.properties?.voltage_kv || 0);
            return L.circleMarker(latlng, {
              pane: 'gridAssets',
              radius: type === 'station' ? Math.min(8, 4.5 + voltage / 110) : Math.min(6.5, 3.5 + voltage / 180),
              color: '#ffffff',
              weight: 1.6,
              fillColor: type === 'station' ? '#ed3f53' : '#8758ff',
              fillOpacity: .98,
            });
          },
          onEachFeature: (feature, layer) => {
            const properties = feature.properties || {};
            layer.bindPopup(assetPopup(properties));
            layer.bindTooltip(properties.label || type, { direction: 'top' });
            layer.on('click', () => setSelection({
              label: `ZESA ${type.toUpperCase()}`,
              title: properties.label || type,
              note: 'Infrastructure asset from the ZESA spatial register.',
              rows: [
                ['Voltage', properties.voltage_kv ? `${Number(properties.voltage_kv)} kV` : 'Not listed'],
                ['Capacity', properties.capacity_kva ? `${Number(properties.capacity_kva).toLocaleString()} kVA` : properties.capacity ? `${Number(properties.capacity).toLocaleString()} kVA` : 'Not listed'],
                ['Status', properties.status || 'Not listed'],
              ],
            }));
          },
        });

        const stationLayer = makeAssetLayer(stations, 'station').addTo(map);
        const transformerLayer = makeAssetLayer(transformers, 'transformer').addTo(map);

        const liveWindLayer = L.layerGroup(liveStations.map(station => {
          const windSpeed = Number(station.latest_wind_speed || 0);
          const marker = L.circleMarker([station.lat, station.lon], {
            pane: 'liveWind',
            radius: 15,
            color: '#ffffff',
            weight: 2.5,
            fillColor: windColor(windSpeed),
            fillOpacity: .88,
            bubblingMouseEvents: false,
          });
          marker.bindTooltip(`Live · ${station.name} · ${windSpeed.toFixed(2)} m/s`, { direction: 'top' });
          marker.on('click', () => inspectPoint(marker.getLatLng()));
          return marker;
        })).addTo(map);

        const mastWindLayer = L.layerGroup(turbines.map(turbine => {
          const icon = L.divIcon({
            className: 'environment-turbine-icon',
            html: '<span><img src="/turbine-marker.svg" alt=""/></span>',
            iconSize: [34, 52],
            iconAnchor: [17, 45],
          });
          const wind = Number(turbine.latest_wind_speed || 0).toFixed(2);
          const marker = L.marker([turbine.lat, turbine.lon], { icon, pane: 'windSites', title: turbine.name });
          marker.bindTooltip(`ZESA mast · ${turbine.name} · ${wind} m/s`, { direction: 'top' });
          marker.on('click', () => inspectPoint(marker.getLatLng()));
          return marker;
        })).addTo(map);

        mapLayersRef.current = {
          annualWind: windResource,
          liveWind: liveWindLayer,
          mastWind: mastWindLayer,
          regions: regionLayer,
          overhead: overheadLayer,
          cables: cableLayer,
          stations: stationLayer,
          transformers: transformerLayer,
        };

        const nearest = <T,>(items: T[], lat: (item: T) => number, lon: (item: T) => number, point: L.LatLng): { item: T; distance: number } | null => {
          let result: { item: T; distance: number } | null = null;
          for (const item of items) {
            const distance = map!.distance(point, L.latLng(lat(item), lon(item)));
            if (!result || distance < result.distance) result = { item, distance };
          }
          return result;
        };

        const nearestRoute = (features: any[], point: L.LatLng) => {
          let result: { item: any; distance: number; latitude: number; longitude: number } | null = null;
          for (const feature of features) {
            const route = routeDistance(point, feature);
            if (!result || route.distance < result.distance) result = { item: feature, ...route };
          }
          return result;
        };

        inspectPoint = async point => {
          const inspectionId = ++inspectionSequence;
          const nearestTurbine = nearest(turbines, item => item.lat, item => item.lon, point);
          const nearestSubstation = nearest(substations.length ? substations : stations, item => Number((item as any).properties.measure_lat), item => Number((item as any).properties.measure_lon), point);
          const nearestTransformer = nearest(transformers, item => Number((item as any).properties.measure_lat), item => Number((item as any).properties.measure_lon), point);
          const nearestOverhead = nearestRoute(overheadRoutes, point);
          const nearestCable = nearestRoute(cableRoutes, point);
          const coordinateKey = `${point.lat.toFixed(4)},${point.lng.toFixed(4)}`;

          queryMarkerRef.current?.remove();
          queryMarkerRef.current = L.circleMarker(point, {
            pane: 'windSites', radius: 9, color: '#ffffff', weight: 3, fillColor: '#00d5ff', fillOpacity: .92,
          }).addTo(map!).bindTooltip('Selected resource point', { permanent: false, direction: 'top' });

          const popupGridContext: PopupGridContext = {
            nearestSubstation: nearestSubstation ? { name: nearestSubstation.item.properties.label, distance: nearestSubstation.distance } : null,
            nearestTransformer: nearestTransformer ? { name: nearestTransformer.item.properties.label, distance: nearestTransformer.distance } : null,
          };
          showAnalysisPopup(point, windAnalysisPopup(coordinateKey, point, null, popupGridContext));

          const nearby: NearbyAsset[] = [
            nearestTurbine && { kind: 'Wind point', name: nearestTurbine.item.name, distance: nearestTurbine.distance, latitude: nearestTurbine.item.lat, longitude: nearestTurbine.item.lon },
            nearestSubstation && { kind: 'Substation', name: nearestSubstation.item.properties.label, distance: nearestSubstation.distance, latitude: Number(nearestSubstation.item.properties.measure_lat), longitude: Number(nearestSubstation.item.properties.measure_lon) },
            nearestTransformer && { kind: 'Transformer', name: nearestTransformer.item.properties.label, distance: nearestTransformer.distance, latitude: Number(nearestTransformer.item.properties.measure_lat), longitude: Number(nearestTransformer.item.properties.measure_lon) },
            nearestOverhead && { kind: 'Overhead line', name: nearestOverhead.item.properties.label || 'Overhead route', distance: nearestOverhead.distance, latitude: nearestOverhead.latitude, longitude: nearestOverhead.longitude },
            nearestCable && { kind: 'Underground cable', name: nearestCable.item.properties.label || 'Cable route', distance: nearestCable.distance, latitude: nearestCable.latitude, longitude: nearestCable.longitude },
          ].filter((item): item is NearbyAsset => Boolean(item));

          const infrastructureRows: Array<[string, string]> = [
            ['Coordinates', `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`],
            ['Nearest wind point', nearestTurbine ? `${nearestTurbine.item.name} · ${distanceLabel(nearestTurbine.distance)}` : 'Not available'],
            ['Nearest substation', nearestSubstation ? `${nearestSubstation.item.properties.label} · ${distanceLabel(nearestSubstation.distance)}` : 'Not available'],
            ['Nearest transformer', nearestTransformer ? `${nearestTransformer.item.properties.label} · ${distanceLabel(nearestTransformer.distance)}` : 'Not available'],
            ['Nearest overhead line', nearestOverhead ? `${nearestOverhead.item.properties.label || 'Overhead route'} · ${distanceLabel(nearestOverhead.distance)}` : 'Not available'],
            ['Nearest cable', nearestCable ? `${nearestCable.item.properties.label || 'Cable route'} · ${distanceLabel(nearestCable.distance)}` : 'Not available'],
          ];
          setSelection({
            label: 'POINT WIND ANALYSIS',
            title: coordinateKey,
            note: 'Retrieving the seven-day live, mast and forecast comparison…',
            rows: infrastructureRows,
            latitude: point.lat,
            longitude: point.lng,
            nearby,
          });
          const [resourceResult, locationResult, windResult] = await Promise.allSettled([
            json(`/api/environment/wind-resource?lat=${point.lat.toFixed(5)}&lon=${point.lng.toFixed(5)}`, { headers: { Authorization: `Bearer ${token}` } }),
            json(`/api/environment/location?lat=${point.lat.toFixed(5)}&lon=${point.lng.toFixed(5)}`, { headers: { Authorization: `Bearer ${token}` } }),
            json(`/api/environment/wind-summary?lat=${point.lat.toFixed(5)}&lon=${point.lng.toFixed(5)}`, { headers: { Authorization: `Bearer ${token}` } }),
          ]);
          if (disposed || inspectionId !== inspectionSequence) return;

          const resource = resourceResult.status === 'fulfilled' ? resourceResult.value : null;
          const location = locationResult.status === 'fulfilled' ? locationResult.value as OsmLocation : null;
          const windSummary = windResult.status === 'fulfilled' ? windResult.value as EnvironmentWindSummary : null;
          const windSpeed = Number(resource?.wind_speed_ms);
          const locationTitle = location?.name || coordinateKey;
          if (analysisPoint?.equals(point)) {
            showAnalysisPopup(point, windAnalysisPopup(locationTitle, point, windSummary, popupGridContext, false));
          }
          const locationRows: Array<[string, string]> = location ? [
            ['OpenStreetMap location', location.name || 'Unnamed mapped feature'],
            ['Detailed OSM address', location.display_name || location.name || 'Not available'],
          ] : [['OpenStreetMap location', 'Not available']];
          const windRows: Array<[string, string]> = windSummary ? [
            ['Live · previous 7 days', windWindowLabel(windSummary.observed.live)],
            ['ZESA mast · latest 7 days', windWindowLabel(windSummary.observed.mast)],
            ['Best estimate · next 7 days', windWindowLabel(windSummary.forecast.blended)],
            ['Forecast blend', windSummary.method.live_available ? `${windSummary.method.live_weight_pct}% live model · ${windSummary.method.mast_weight_pct}% mast calibration` : 'Mast model fallback'],
          ] : [['Seven-day wind analysis', 'Temporarily unavailable']];
          const note = windSummary
            ? `Seven-day wind context for this location, calibrated with ${windSummary.closest_wind_point.name}.${resource ? ' IRENA annual screening is included below.' : ''}`
            : `The seven-day wind comparison could not be retrieved.${resource ? ' IRENA annual screening remains available.' : ''}`;
          setSelection({
            label: 'POINT WIND ANALYSIS',
            title: locationTitle,
            note,
            rows: [
              ...windRows,
              ...(windSummary ? [
                ['ZESA region', windSummary.point.region || 'Not available'],
                ['ZESA district', windSummary.point.district || 'Not available'],
              ] as Array<[string, string]> : []),
              ...(Number.isFinite(windSpeed) ? [
                ['Wind resource', `${windSpeed.toFixed(2)} m/s`],
                ['Screening band', resourceBand(windSpeed)],
              ] as Array<[string, string]> : []),
              ...locationRows,
              ...infrastructureRows,
            ],
            latitude: point.lat,
            longitude: point.lng,
            nearby,
          });
        };

        map.on('click', event => inspectPoint(event.latlng));

        setStatus(liveStations.length ? 'Annual, live, mast and grid layers loaded' : 'Annual, mast and grid layers loaded · live wind unavailable');
        requestAnimationFrame(() => map?.invalidateSize());
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        setStatus('Wind Map layers could not be loaded');
        setSelection({ label: 'MAP STATUS', title: 'Layer loading failed', note: error instanceof Error ? error.message : 'The Wind Map is unavailable.', rows: [] });
      }
    };

    initialise();
    return () => {
      disposed = true;
      controller.abort();
      window.removeEventListener('resize', positionAnalysisPopup);
      closeAnalysisPopup();
      windLayerRef.current = null;
      mapLayersRef.current = {};
      queryMarkerRef.current = null;
      leafletMapRef.current = null;
      map.remove();
    };
  }, [token]);

  const changeOpacity = (value: number) => {
    setOpacity(value);
    windLayerRef.current?.setOpacity(value / 100);
  };

  const setLayer = (key: LayerKey, visible: boolean) => {
    const map = leafletMapRef.current;
    const layer = mapLayersRef.current[key];
    if (map && layer) {
      if (visible && !map.hasLayer(layer)) layer.addTo(map);
      if (!visible && map.hasLayer(layer)) layer.removeFrom(map);
    }
    setLayerVisibility(current => ({ ...current, [key]: visible }));
  };

  const setAllLayers = (visible: boolean) => {
    layerLabels.forEach(item => {
      const map = leafletMapRef.current;
      const layer = mapLayersRef.current[item.key];
      if (!map || !layer) return;
      if (visible && !map.hasLayer(layer)) layer.addTo(map);
      if (!visible && map.hasLayer(layer)) layer.removeFrom(map);
    });
    setLayerVisibility(Object.fromEntries(layerLabels.map(item => [item.key, visible])) as Record<LayerKey, boolean>);
  };

  const copySelection = async () => {
    const text = [selection.title, selection.note, ...selection.rows.map(([label, value]) => `${label}: ${value}`)].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('Copied');
    } catch {
      setCopyStatus('Copy unavailable');
    }
    window.setTimeout(() => setCopyStatus(''), 1800);
  };

  const zoomTo = (latitude: number, longitude: number, zoom = 11) => {
    leafletMapRef.current?.flyTo([latitude, longitude], zoom, { duration: .7 });
  };

  return <main className="content environment-host">
    <div className="environment-heading">
      <div><p className="eyebrow">WIND RESOURCE &amp; GRID INTELLIGENCE</p><h1>Zimbabwe Wind Map</h1><p>Live wind conditions and ZESA mast observations combined with annual resource and grid infrastructure.</p></div>
      <a href="https://globalatlas.irena.org/" target="_blank" rel="noreferrer">Open IRENA Global Atlas ↗</a>
    </div>

    <section className="environment-kpis" aria-label="Wind Map layer totals">
      <article><small>ZESA mast points</small><strong>{summary.mastPoints.toLocaleString()}</strong><span>Latest logger observations</span></article>
      <article><small>Live wind points</small><strong>{summary.livePoints.toLocaleString()}</strong><span>Current hourly conditions</span></article>
      <article><small>Substations &amp; stations</small><strong>{summary.stations.toLocaleString()}</strong><span>ZESA spatial register</span></article>
      <article><small>Transformers</small><strong>{summary.transformers.toLocaleString()}</strong><span>Mapped grid assets</span></article>
      <article><small>Power routes</small><strong>{summary.routes.toLocaleString()}</strong><span>Overhead and underground</span></article>
    </section>

    <section className="environment-workspace">
      <div className="environment-map-panel">
        <header>
          <div><p className="eyebrow">INTERACTIVE NATIONAL VIEW</p><h2>Wind resource and grid connection context</h2></div>
          <div className="environment-map-actions">
            <button type="button" onClick={() => leafletMapRef.current && focusZimbabwe(leafletMapRef.current)}>Reset Zimbabwe view</button>
          </div>
        </header>
        <div className="environment-map-wrap"><div ref={mapElementRef} className="environment-map" aria-label="Interactive Zimbabwe wind resource and ZESA infrastructure map"/><span className="environment-map-status"><i/>{status}</span></div>
      </div>

      <aside className="environment-inspector">
        <section className="environment-filters" aria-label="Wind Map filters">
          <div className="environment-filter-heading"><div><p className="eyebrow">MAP FILTERS</p><h2>Visible layers</h2></div><div><button type="button" onClick={() => setAllLayers(true)}>All</button><button type="button" onClick={() => setAllLayers(false)}>None</button></div></div>
          <label className="environment-opacity"><span>Annual wind opacity</span><input type="range" min="20" max="90" value={opacity} onChange={event => changeOpacity(Number(event.target.value))}/><b>{opacity}%</b></label>
          <div className="environment-layer-list">{layerLabels.map(item => <label key={item.key}><input type="checkbox" checked={layerVisibility[item.key]} onChange={event => setLayer(item.key, event.target.checked)}/><i className={`symbol ${item.className}`}/><span>{item.label}</span></label>)}</div>
        </section>

        <section className="environment-inspection-result">
        <p className="eyebrow">{selection.label}</p>
        <h2>{selection.title}</h2>
        <p>{selection.note}</p>
        {selection.latitude != null && selection.longitude != null && <div className="environment-query-actions"><button type="button" onClick={() => zoomTo(selection.latitude!, selection.longitude!, 12)}>Zoom to point</button><button type="button" onClick={copySelection}>{copyStatus || 'Copy analysis'}</button></div>}
        <div className="environment-selection-rows">{selection.rows.map(([label, value]) => <span key={label}><small>{label}</small><b>{value}</b></span>)}</div>
        {selection.nearby && selection.nearby.length > 0 && <div className="environment-nearby"><h3>Zoom to nearest infrastructure</h3>{selection.nearby.map(asset => <button type="button" key={asset.kind} onClick={() => zoomTo(asset.latitude, asset.longitude)}><span><small>{asset.kind}</small><b>{asset.name}</b></span><em>{distanceLabel(asset.distance)} ↗</em></button>)}</div>}
        </section>

        <div className="environment-legend">
          <h3>Annual mean wind speed</h3>
          <p>IRENA Global Atlas · 100 m above ground</p>
          <div className="wind-gradient" aria-hidden="true"/>
          <div className="wind-gradient-labels"><span>0</span><span>3.75</span><span>7.5</span><span>11.25</span><span>15 m/s</span></div>
          <h3 className="live-wind-legend-title">Live wind speed</h3>
          <p>Open-Meteo hourly conditions · 10 m above ground</p>
          <div className="live-wind-bands"><span><i className="low"/>0–4</span><span><i className="moderate"/>4–6</span><span><i className="good"/>6–7.5</span><span><i className="strong"/>7.5+ m/s</span></div>
        </div>

        <div className="environment-symbols">
          <h3>Map symbols</h3>
          <span><i className="symbol live-wind"/>Live wind conditions (colour = speed)</span>
          <span><i className="symbol turbine"/>ZESA mast observation</span>
          <span><i className="symbol station"/>Substation / station</span>
          <span><i className="symbol transformer"/>Transformer</span>
          <span><i className="symbol overhead overhead-11"/>11 kV overhead lines</span>
          <span><i className="symbol overhead overhead-33"/>33 kV overhead lines</span>
          <span><i className="symbol overhead overhead-high"/>88–330 kV overhead lines</span>
          <span><i className="symbol cable"/>Underground cable</span>
        </div>
      </aside>
    </section>

    <div ref={analysisPopupRef} className="environment-analysis-overlay" role="dialog" aria-live="polite" aria-label="Selected point wind analysis" hidden/>

    <p className="environment-source-note"><b>Wind sources:</b> live 10 m hourly conditions from Open-Meteo, measured observations from ZESA wind masts, and the Vortex annual average at 100 m from the IRENA Global Atlas. Live/modelled and mast heights differ, so compare them as context rather than like-for-like measurements.</p>
  </main>;
}
