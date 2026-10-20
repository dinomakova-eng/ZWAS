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
  latest_wind_speed?: number;
  latest_wind_direction?: number;
  latest_temperature?: number;
  latest_humidity?: number;
  latest_air_pressure?: number;
  latest_air_density?: number;
  latest_power_output?: number;
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

const valueLabel = (value: number | undefined, decimals: number, unit: string) =>
  Number.isFinite(Number(value)) ? `${Number(value).toFixed(decimals)} ${unit}` : 'Not available';

const timestampLabel = (value?: string) => {
  if (!value) return 'Not available';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('en-ZW', { dateStyle: 'medium', timeStyle: 'short' });
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
    let map: L.Map | null = null;

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
        const liveById = new Map(liveStations.map(station => [station.id, station]));

        const gridFeatures: any[] = grid.features || [];
        const stations = gridFeatures.filter(feature => feature.properties?.asset_type === 'station');
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

        map = L.map(mapElementRef.current, {
          zoomControl: true,
          minZoom: 5,
          maxZoom: 16,
          zoomSnap: .25,
          preferCanvas: true,
        });
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

        const baseMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
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
          marker.bindPopup(`<div class="environment-popup live"><small>LIVE WIND CONDITIONS · 10 M</small><strong>${safeText(station.name)}</strong><span>Wind speed <b>${windSpeed.toFixed(2)} m/s</b></span><span>Direction <b>${valueLabel(station.latest_wind_direction, 0, '°')}</b></span><span>Temperature <b>${valueLabel(station.latest_temperature, 1, '°C')}</b></span><span>Updated <b>${safeText(timestampLabel(station.last_reading_at))}</b></span></div>`);
          marker.on('click', () => {
            const mast = turbines.find(item => item.id === station.id);
            setSelection({
              label: 'LIVE WIND CONDITIONS',
              title: station.name,
              note: `${liveResponse?.metadata?.provider || 'Open-Meteo'} hourly conditions at 10 m${liveResponse?.metadata?.stale ? ' · cached data' : ''}.`,
              rows: [
                ['Live wind speed', valueLabel(station.latest_wind_speed, 2, 'm/s')],
                ['Live direction', valueLabel(station.latest_wind_direction, 0, '°')],
                ['Live temperature', valueLabel(station.latest_temperature, 1, '°C')],
                ['Live humidity', valueLabel(station.latest_humidity, 0, '%')],
                ['Live air pressure', valueLabel(station.latest_air_pressure, 1, 'hPa')],
                ['Live air density', valueLabel(station.latest_air_density, 4, 'kg/m³')],
                ['Estimated generation', valueLabel(Number(station.latest_power_output || 0) / 1000, 2, 'MW')],
                ['Observation time', timestampLabel(station.last_reading_at)],
                ['ZESA mast latest', mast ? valueLabel(mast.latest_wind_speed, 2, 'm/s') : 'Not available'],
              ],
              latitude: station.lat,
              longitude: station.lon,
            });
          });
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
          const averageWind = Number(turbine.average_wind_speed || 0).toFixed(2);
          const generation = (Number(turbine.latest_power_output || 0) / 1000).toFixed(2);
          const marker = L.marker([turbine.lat, turbine.lon], { icon, pane: 'windSites', title: turbine.name });
          marker.bindTooltip(`ZESA mast · ${turbine.name} · ${wind} m/s`, { direction: 'top' });
          marker.bindPopup(`<div class="environment-popup turbine"><small>ZESA WIND MAST OBSERVATION</small><strong>${safeText(turbine.name)}</strong><span>Latest measured wind <b>${wind} m/s</b></span><span>24-hour average <b>${averageWind} m/s</b></span><span>Estimated generation <b>${generation} MW</b></span><span>Observed <b>${safeText(timestampLabel(turbine.last_reading_at))}</b></span><span>${safeText(turbine.region)} · ${safeText(turbine.district)}</span></div>`);
          marker.on('click', () => setSelection({
            label: 'ZESA WIND MAST OBSERVATION',
            title: turbine.name,
            note: `${turbine.region || 'ZETDC'} · ${turbine.district || 'Zimbabwe'} · measured logger telemetry.`,
            rows: [
              ['Latest mast wind', `${wind} m/s`],
              ['24-hour mast average', `${averageWind} m/s`],
              ['Mast direction', valueLabel(turbine.latest_wind_direction, 0, '°')],
              ['Mast temperature', valueLabel(turbine.latest_temperature, 1, '°C')],
              ['Mast humidity', valueLabel(turbine.latest_humidity, 0, '%')],
              ['Mast air pressure', valueLabel(turbine.latest_air_pressure, 1, 'hPa')],
              ['Estimated generation', `${generation} MW`],
              ['Observation time', timestampLabel(turbine.last_reading_at)],
              ['Live wind at site', liveById.has(turbine.id) ? valueLabel(liveById.get(turbine.id)?.latest_wind_speed, 2, 'm/s') : 'Not available'],
              ['Logger', turbine.source_id || 'Not listed'],
              ['Status', turbine.status || 'Not listed'],
            ],
            latitude: turbine.lat,
            longitude: turbine.lon,
          }));
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

        L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
        focusZimbabwe(map);

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

        map.on('click', async event => {
          const inspectionId = ++inspectionSequence;
          const point = event.latlng;
          const nearestTurbine = nearest(turbines, item => item.lat, item => item.lon, point);
          const nearestLiveStation = nearest(liveStations, item => item.lat, item => item.lon, point);
          const nearestStation = nearest(stations, item => Number((item as any).properties.measure_lat), item => Number((item as any).properties.measure_lon), point);
          const nearestTransformer = nearest(transformers, item => Number((item as any).properties.measure_lat), item => Number((item as any).properties.measure_lon), point);
          const nearestOverhead = nearestRoute(overheadRoutes, point);
          const nearestCable = nearestRoute(cableRoutes, point);
          const coordinateKey = `${point.lat.toFixed(4)},${point.lng.toFixed(4)}`;

          queryMarkerRef.current?.remove();
          queryMarkerRef.current = L.circleMarker(point, {
            pane: 'windSites', radius: 9, color: '#ffffff', weight: 3, fillColor: '#00d5ff', fillOpacity: .92,
          }).addTo(map!).bindTooltip('Selected resource point', { permanent: false, direction: 'top' });

          const nearby: NearbyAsset[] = [
            nearestTurbine && { kind: 'Wind point', name: nearestTurbine.item.name, distance: nearestTurbine.distance, latitude: nearestTurbine.item.lat, longitude: nearestTurbine.item.lon },
            nearestStation && { kind: 'Station', name: nearestStation.item.properties.label, distance: nearestStation.distance, latitude: Number(nearestStation.item.properties.measure_lat), longitude: Number(nearestStation.item.properties.measure_lon) },
            nearestTransformer && { kind: 'Transformer', name: nearestTransformer.item.properties.label, distance: nearestTransformer.distance, latitude: Number(nearestTransformer.item.properties.measure_lat), longitude: Number(nearestTransformer.item.properties.measure_lon) },
            nearestOverhead && { kind: 'Overhead line', name: nearestOverhead.item.properties.label || 'Overhead route', distance: nearestOverhead.distance, latitude: nearestOverhead.latitude, longitude: nearestOverhead.longitude },
            nearestCable && { kind: 'Underground cable', name: nearestCable.item.properties.label || 'Cable route', distance: nearestCable.distance, latitude: nearestCable.latitude, longitude: nearestCable.longitude },
          ].filter((item): item is NearbyAsset => Boolean(item));

          const infrastructureRows: Array<[string, string]> = [
            ['Coordinates', `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`],
            ['Nearest wind point', nearestTurbine ? `${nearestTurbine.item.name} · ${distanceLabel(nearestTurbine.distance)}` : 'Not available'],
            ['Nearest mast wind', nearestTurbine ? valueLabel(nearestTurbine.item.latest_wind_speed, 2, 'm/s') : 'Not available'],
            ['Live wind at nearest site', nearestLiveStation ? `${nearestLiveStation.item.name} · ${valueLabel(nearestLiveStation.item.latest_wind_speed, 2, 'm/s')} · ${distanceLabel(nearestLiveStation.distance)}` : 'Not available'],
            ['Nearest station', nearestStation ? `${nearestStation.item.properties.label} · ${distanceLabel(nearestStation.distance)}` : 'Not available'],
            ['Nearest transformer', nearestTransformer ? `${nearestTransformer.item.properties.label} · ${distanceLabel(nearestTransformer.distance)}` : 'Not available'],
            ['Nearest overhead line', nearestOverhead ? `${nearestOverhead.item.properties.label || 'Overhead route'} · ${distanceLabel(nearestOverhead.distance)}` : 'Not available'],
            ['Nearest cable', nearestCable ? `${nearestCable.item.properties.label || 'Cable route'} · ${distanceLabel(nearestCable.distance)}` : 'Not available'],
          ];
          setSelection({
            label: 'IRENA RESOURCE QUERY',
            title: coordinateKey,
            note: 'Retrieving the long-term annual mean wind resource at 100 m…',
            rows: infrastructureRows,
            latitude: point.lat,
            longitude: point.lng,
            nearby,
          });
          const [resourceResult, locationResult] = await Promise.allSettled([
            json(`/api/environment/wind-resource?lat=${point.lat.toFixed(5)}&lon=${point.lng.toFixed(5)}`, { headers: { Authorization: `Bearer ${token}` } }),
            json(`/api/environment/location?lat=${point.lat.toFixed(5)}&lon=${point.lng.toFixed(5)}`, { headers: { Authorization: `Bearer ${token}` } }),
          ]);
          if (disposed || inspectionId !== inspectionSequence) return;

          const resource = resourceResult.status === 'fulfilled' ? resourceResult.value : null;
          const location = locationResult.status === 'fulfilled' ? locationResult.value as OsmLocation : null;
          const windSpeed = Number(resource?.wind_speed_ms);
          const locationRows: Array<[string, string]> = location ? [
            ['OpenStreetMap location', location.name || 'Unnamed mapped feature'],
            ['Detailed OSM address', location.display_name || location.name || 'Not available'],
          ] : [['OpenStreetMap location', 'Not available']];
          const note = resource
            ? `IRENA Global Atlas · Vortex long-term annual average at 100 m.${location ? ' Location identified from OpenStreetMap.' : ' The OSM place name could not be retrieved.'}`
            : `The IRENA point value could not be retrieved.${location ? ' Location identified from OpenStreetMap.' : ' The OSM place name is also unavailable.'}`;
          setSelection({
            label: 'IRENA RESOURCE QUERY',
            title: location?.name || coordinateKey,
            note,
            rows: [
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
        });

        setStatus(liveStations.length ? 'Annual, live, mast and grid layers loaded' : 'Annual, mast and grid layers loaded · live wind unavailable');
        requestAnimationFrame(() => map?.invalidateSize());
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        setStatus('Environment layers could not be loaded');
        setSelection({ label: 'MAP STATUS', title: 'Layer loading failed', note: error instanceof Error ? error.message : 'The environment map is unavailable.', rows: [] });
      }
    };

    initialise();
    return () => {
      disposed = true;
      controller.abort();
      windLayerRef.current = null;
      mapLayersRef.current = {};
      queryMarkerRef.current = null;
      leafletMapRef.current = null;
      map?.remove();
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
      <div><p className="eyebrow">ENVIRONMENT &amp; GRID INTELLIGENCE</p><h1>Zimbabwe Wind Resource Map</h1><p>Live wind conditions and ZESA mast observations combined with annual resource and grid infrastructure.</p></div>
      <a href="https://globalatlas.irena.org/" target="_blank" rel="noreferrer">Open IRENA Global Atlas ↗</a>
    </div>

    <section className="environment-kpis" aria-label="Environment map layer totals">
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
        <section className="environment-filters" aria-label="Environment map filters">
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

    <p className="environment-source-note"><b>Wind sources:</b> live 10 m hourly conditions from Open-Meteo, measured observations from ZESA wind masts, and the Vortex annual average at 100 m from the IRENA Global Atlas. Live/modelled and mast heights differ, so compare them as context rather than like-for-like measurements.</p>
  </main>;
}
