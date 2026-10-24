const API = '/api';
const CACHE_MS = 10 * 60_000;
const RESOURCE_CACHE_MS = 60 * 60_000;

type CacheEntry = {expires: number; promise: Promise<unknown>};
const cache = new Map<string, CacheEntry>();
const resourceCache = new Map<string, CacheEntry>();

export type LiveRefreshResult = {
  status: 'refreshed' | 'current';
  global: boolean;
  provider: string;
  collected_for: string;
  collected_at: string;
  observed_through: string;
  sites: number;
  history_sites: number;
};

let liveRefreshPromise: Promise<LiveRefreshResult> | null = null;

export const getApiData = <T>(path: string, token: string, maxAge = CACHE_MS): Promise<T> => {
  const key = `${token}:${path}`;
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.promise as Promise<T>;
  const promise = fetch(`${API}${path}`, {headers: {Authorization: `Bearer ${token}`}}).then(response => {
    if (!response.ok) throw new Error(`API request failed: ${response.status}`);
    return response.json() as Promise<T>;
  }).catch(error => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, {expires: Date.now() + maxAge, promise});
  return promise;
};

export const getJsonResource = <T>(url: string, maxAge = RESOURCE_CACHE_MS): Promise<T> => {
  const existing = resourceCache.get(url);
  if (existing && existing.expires > Date.now()) return existing.promise as Promise<T>;
  const promise = fetch(url).then(response => {
    if (!response.ok) throw new Error(`Resource request failed: ${response.status}`);
    return response.json() as Promise<T>;
  }).catch(error => {
    resourceCache.delete(url);
    throw error;
  });
  resourceCache.set(url, {expires: Date.now() + maxAge, promise});
  return promise;
};

export const prefetchAnalytics = (token: string) => Promise.all([
  getApiData('/turbines', token),
  getApiData('/analytics/daily?days=90', token),
]);

export const clearApiCache = () => cache.clear();

export const refreshLiveData = (token: string, trigger: 'system_open' | 'manual' = 'manual') => {
  if (liveRefreshPromise) return liveRefreshPromise;
  window.dispatchEvent(new CustomEvent('zetdc:live-data-refresh-started', {detail: {trigger}}));
  liveRefreshPromise = fetch(`${API}/live-wind/refresh`, {
    method: 'POST',
    headers: {Authorization: `Bearer ${token}`},
  }).then(async response => {
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || `Live refresh failed with status ${response.status}`);
    }
    return response.json() as Promise<LiveRefreshResult>;
  }).then(result => {
    if (result.status === 'refreshed') clearApiCache();
    window.dispatchEvent(new CustomEvent('zetdc:live-data-refreshed', {detail: {...result, trigger}}));
    return result;
  }).catch(error => {
    window.dispatchEvent(new CustomEvent('zetdc:live-data-refresh-error', {
      detail: {trigger, message: error instanceof Error ? error.message : 'Live wind refresh failed'},
    }));
    throw error;
  }).finally(() => {
    liveRefreshPromise = null;
  });
  return liveRefreshPromise;
};
