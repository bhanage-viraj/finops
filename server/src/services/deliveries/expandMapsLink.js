import { coordsFromMapsUrl } from './locationResolver.js';

/**
 * Follow a Google Maps short link and read coordinates from the final URL.
 * No API key. Uses HEAD/GET redirect chain.
 */
export async function expandMapsLink(url, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop < 6; hop += 1) {
      const fromCurrent = coordsFromMapsUrl(current);
      if (fromCurrent) return { ...fromCurrent, finalUrl: current };

      const res = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'FinOps-Deliveries/1.0' },
      });
      const loc = res.headers.get('location');
      if (loc) {
        current = new URL(loc, current).toString();
        continue;
      }
      // Some servers return 200 with a meta refresh or the final maps page URL.
      if (res.url && res.url !== current) {
        current = res.url;
        const fromRes = coordsFromMapsUrl(current);
        if (fromRes) return { ...fromRes, finalUrl: current };
      }
      const text = await res.text().catch(() => '');
      const fromBody = coordsFromMapsUrl(text.slice(0, 5000));
      if (fromBody) return { ...fromBody, finalUrl: current };
      break;
    }
    return coordsFromMapsUrl(current) ? { ...coordsFromMapsUrl(current), finalUrl: current } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
