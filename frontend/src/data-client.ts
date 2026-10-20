const API = '/api';
const CACHE_MS = 60_000;

type CacheEntry = {expires: number; promise: Promise<unknown>};
const cache = new Map<string, CacheEntry>();

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

export const prefetchAnalytics = (token: string) => Promise.all([
  getApiData('/turbines', token),
  getApiData('/analytics/daily?days=90', token),
]);

export const clearApiCache = () => cache.clear();
