// background.js
// Coordinates the pipeline: ATLAS errors -> FC Research enrichment -> route.
// Runs cross-origin fetches (credentials included) that content scripts can't.
//
// Loaded after lib/binParser.js and lib/pathfinding.js (see manifest).

const DEBUG = true;
function log(...a) { if (DEBUG) console.log('[Qualy-BG]', ...a); }
function logError(...a) { console.error('[Qualy-BG] ERROR:', ...a); }

log('Background starting');

// Cache FC Research lookups (keyed by warehouse:query). 30 min.
const fcCache = new Map();
const CACHE_MS = 30 * 60 * 1000;

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log('message:', message && message.type);
  switch (message.type) {
    case 'buildPath':
      handleBuildPath(message.payload)
        .then(sendResponse)
        .catch(err => { logError('buildPath', err); sendResponse({ error: err.message }); });
      return true; // async

    case 'enrichOne':
      enrichError(message.error, message.warehouseId)
        .then(sendResponse)
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'atlasSearch':
      fetchAtlasErrors(message.opts || {})
        .then(sendResponse)
        .catch(err => { logError('atlasSearch', err); sendResponse({ error: err.message }); });
      return true; // async

    case 'clearCache':
      fcCache.clear();
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});

/**
 * payload: { errors:[{bin,fnsku,asin,itemName,quantity,rejectReason,source,...}],
 *            startBin:string, warehouseId:string, enrich:boolean }
 */
async function handleBuildPath(payload) {
  const { errors = [], startBin = '', warehouseId = 'IND8', enrich = true } = payload || {};
  log(`buildPath: ${errors.length} errors, start=${startBin}, wh=${warehouseId}, enrich=${enrich}`);

  // 1) Route first (fast, no network) so the page can render immediately.
  const route = self.QualyPath.buildRoute(errors, startBin);

  // 2) Enrich each stop with FC Research image + details (bounded concurrency).
  if (enrich) {
    const CONCURRENCY = 4;
    for (let i = 0; i < route.stops.length; i += CONCURRENCY) {
      const slice = route.stops.slice(i, i + CONCURRENCY);
      await Promise.all(slice.map(async (stop) => {
        const q = stop.item.fnsku || stop.item.asin;
        if (!q) { stop.fc = { error: 'no fnsku/asin' }; return; }
        stop.fc = await fetchFCResearch(q, warehouseId);
      }));
      log(`enriched ${Math.min(i + CONCURRENCY, route.stops.length)}/${route.stops.length}`);
    }
  }

  return { route, warehouseId, startBin };
}

async function enrichError(error, warehouseId) {
  const q = error.fnsku || error.asin;
  if (!q) return { error: 'no fnsku/asin' };
  return fetchFCResearch(q, warehouseId || 'IND8');
}

// ---- ATLAS (OpenSearch) direct API -----------------------------------------

const ATLAS_SEARCH_URL =
  'https://moc.prod.atlas-opensearch.qubit.amazon.dev/_dashboards/internal/search/opensearch';

// Maps an error-type selection to an OpenSearch query_string clause.
function typeExpr(types) {
  switch ((types || 'both').toLowerCase()) {
    case 'short':
    case 'shorts': return 'SHORT';
    case 'reject':
    case 'rejects': return 'REJECT';
    default: return 'SHORT OR REJECT';
  }
}

/**
 * opts: { warehouseId, fromISO, toISO, hoursBack, types }
 * Queries the ATLAS `atlas*` index directly (same session cookies) and returns
 * normalised error records: { errors, total, from, to, query }.
 */
async function fetchAtlasErrors(opts) {
  const warehouseId = opts.warehouseId || 'IND8';
  const to = opts.toISO ? new Date(opts.toISO) : new Date();
  const from = opts.fromISO
    ? new Date(opts.fromISO)
    : new Date(to.getTime() - (opts.hoursBack || 12) * 3600 * 1000);
  const fromISO = from.toISOString();
  const toISO = to.toISOString();
  const qs = `warehouse_id:${warehouseId} AND type:(${typeExpr(opts.types)})`;

  const body = {
    params: {
      index: 'atlas*',
      body: {
        version: true,
        size: 5000,
        sort: [{ timestamp: { order: 'desc', unmapped_type: 'boolean' } }],
        _source: { excludes: [] },
        docvalue_fields: [{ field: 'timestamp', format: 'date_time' }],
        query: {
          bool: {
            must: [{
              query_string: { query: qs, analyze_wildcard: true, time_zone: 'America/New_York' }
            }],
            filter: [{
              range: {
                timestamp: { gte: fromISO, lte: toISO, format: 'strict_date_optional_time' }
              }
            }],
            should: [], must_not: []
          }
        }
      }
    }
  };

  log(`ATLAS search: ${qs} [${fromISO} .. ${toISO}]`);
  const resp = await fetch(ATLAS_SEARCH_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'osd-xsrf': 'true'
    },
    body: JSON.stringify(body)
  });

  log(`ATLAS status: ${resp.status}`);
  if (resp.status === 401 || resp.status === 403) {
    return { error: 'Not authenticated to ATLAS. Open an ATLAS dashboard (logged in) in another tab, then retry.' };
  }
  if (!resp.ok) {
    return { error: `ATLAS search failed (HTTP ${resp.status}). Try the scrape/paste fallback.` };
  }

  const json = await resp.json();
  const hits = (json.rawResponse && json.rawResponse.hits && json.rawResponse.hits.hits) ||
               (json.hits && json.hits.hits) ||
               (json.body && json.body.hits && json.body.hits.hits) || [];
  const totalRaw = (json.rawResponse && json.rawResponse.hits && json.rawResponse.hits.total);
  const total = (totalRaw && typeof totalRaw === 'object') ? totalRaw.value : (totalRaw || hits.length);

  const errors = [];
  const seen = new Set();
  for (const h of hits) {
    const s = h._source || {};
    const bin = firstStr(s.bin_raw, s.bin);
    const fnsku = firstStr(s.fnsku);
    const asin = firstStr(s.asin_raw, s.asin);
    if (!bin || (!fnsku && !asin)) continue;

    const type = (firstStr(s.type) || '').toUpperCase();
    const rejectReason = firstStr(s.reject_reason);
    const rec = {
      bin,
      fnsku: fnsku || '',
      asin: asin || '',
      itemName: firstStr(s.item_name, s.title) || '',
      quantity: s.quantity != null ? String(s.quantity) : '',
      rejectReason: rejectReason || '',
      binding: firstStr(s.binding_name, s.binding) || '',
      aa: firstStr(s.user_id, s.user_login, s.login, s.associate_id, s.operator_id),
      manager: firstStr(s.manager, s.manager_login, s.manager_id),
      lpn: pickLpn(s),
      time: firstStr(s.timestamp, s['@timestamp']) || '',
      source: (type === 'REJECT' || rejectReason) ? 'reject' : 'short'
    };
    const k = `${rec.bin}|${rec.fnsku || rec.asin}|${rec.time}`;
    if (seen.has(k)) continue;
    seen.add(k);
    errors.push(rec);
  }

  log(`ATLAS returned ${hits.length} hits, ${errors.length} usable errors (total match ${total})`);
  return { errors, total, from: fromISO, to: toISO, query: qs };
}

// LPN — the ATLAS field is `lpn` (confirmed). Fallbacks kept for safety.
function pickLpn(s) {
  return firstStr(s.lpn, s.LPN, s.pick_lpn, s.from_lpn, s.container_lpn);
}

function firstStr(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = Array.isArray(v) ? v[0] : v;
    if (s != null && String(s).trim() !== '') return String(s).trim();
  }
  return '';
}

// ---- FC Research -----------------------------------------------------------

async function fetchFCResearch(query, warehouseId) {
  const key = `${warehouseId}:${query}`;
  const cached = fcCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_MS) {
    log(`FC cache hit ${query}`);
    return { ...cached.data, fromCache: true };
  }

  const endpoints = [
    `https://fcresearch-na.aka.amazon.com/${warehouseId}/results/product`,
    `https://fcresearch.aka.amazon.com/${warehouseId}/results/product`
  ];

  for (const url of endpoints) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Accept': 'text/html, */*; q=0.01',
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: `s=${encodeURIComponent(query)}`
      });
      log(`FC ${query} <- ${url}: ${resp.status}`);
      if (!resp.ok) continue;
      const html = await resp.text();
      if (html.includes('Sign in') || html.includes('Login') || html.length < 80) continue;

      const data = parseFCResearch(html);
      if (data.imageUrl || data.title || data.asin) {
        // Fetch the image as a data URL so it renders even under strict CSP.
        if (data.imageUrl) {
          data.imageDataUrl = await fetchImageDataUrl(data.imageUrl).catch(() => null);
        }
        fcCache.set(key, { ts: Date.now(), data });
        return data;
      }
    } catch (err) {
      logError(`FC fetch ${query}`, err);
    }
  }
  return { error: 'FC Research lookup failed', query };
}

/**
 * Parse the FC Research /results/product fragment. Structure (confirmed):
 *   <div class="a-column a-span4"><img src="https://m.media-amazon.com/..."></div>
 *   <table class="a-keyvalue" data-row-id="ASIN">
 *     <tr><th>ASIN</th><td><a>...</a></td></tr>
 *     <tr><th>Title</th>...  <tr><th>Weight</th><td>4.03 pounds</td></tr> ...
 */
function parseFCResearch(html) {
  const out = {
    imageUrl: null, imageFullUrl: null, asin: null, title: null,
    weight: null, dimensions: null, binding: null, listPrice: null
  };

  // Image: first amazon media/CDN image in the product block.
  const imgMatch = html.match(
    /<img[^>]+src="(https:\/\/(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com)\/images\/[^"]+)"/i
  );
  if (imgMatch) {
    out.imageUrl = imgMatch[1];
    // Full-res: strip the "._SCLZZZ...__" size token (…/ID._SC...__.jpg -> …/ID.jpg)
    out.imageFullUrl = out.imageUrl.replace(/\._[A-Z0-9,_]+_(\.[a-z]+)$/i, '$1');
  }

  // data-row-id carries the ASIN.
  const rowId = html.match(/data-row-id="([^"]+)"/i);
  if (rowId) out.asin = rowId[1];

  // Key/value rows: <tr><th>Label</th><td>...value...</td></tr>
  const rowRe = /<tr[^>]*>\s*<th[^>]*>([^<]+)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const label = m[1].trim().toLowerCase();
    const valueHtml = m[2];
    const text = stripTags(valueHtml).trim();
    switch (label) {
      case 'asin': if (!out.asin) out.asin = text; break;
      case 'title': out.title = text; break;
      case 'binding': out.binding = text; break;
      case 'weight': {
        const w = text.match(/([\d.]+)\s*(?:pounds?|lbs?)/i);
        out.weight = w ? parseFloat(w[1]) : (text || null);
        break;
      }
      case 'dimensions': out.dimensions = text; break;
      case 'list price': out.listPrice = text; break;
      default: break;
    }
  }
  return out;
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
             .replace(/\s+/g, ' ');
}

async function fetchImageDataUrl(url) {
  const resp = await fetch(url, { credentials: 'omit' });
  if (!resp.ok) throw new Error('img ' + resp.status);
  const blob = await resp.blob();
  return await blobToDataUrl(blob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

log('Background ready');
