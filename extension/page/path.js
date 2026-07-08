// path.js — Qualy Pick Path results page.
// Reads the scraped payload, asks the background to route + enrich, renders the
// curated walking path. Also supports a CSV/TSV paste fallback.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let currentErrors = [];
  let warehouseId = 'IND8';

  const els = {
    meta: $('meta'), start: $('startBin'), wh: $('warehouse'), enrich: $('enrich'),
    build: $('build'), status: $('status'), stops: $('stops'), mini: $('mini'),
    pasteBox: $('pasteBox'), parsePaste: $('parsePaste'),
    types: $('types'), hours: $('hours'), fetchAtlas: $('fetchAtlas')
  };

  // ---- Load payload ---------------------------------------------------------

  browser.storage.local.get('qualyPayload').then((r) => {
    const p = (r && r.qualyPayload) || {};
    currentErrors = Array.isArray(p.errors) ? p.errors : [];
    warehouseId = p.warehouseId || 'IND8';
    els.wh.value = warehouseId;
    els.start.value = p.startBin || '';
    if (typeof p.enrich === 'boolean') els.enrich.checked = p.enrich;
    if (p.types) els.types.value = p.types;
    if (p.hoursBack) els.hours.value = p.hoursBack;

    if (p.mode === 'api') {
      fetchFromAtlas(); // pull errors directly, then auto-build
    } else if (currentErrors.length) {
      updateMeta();
      build();
    } else {
      updateMeta();
      els.stops.innerHTML = '<div class="empty">No errors loaded. Click <b>Fetch from ATLAS</b> above, paste the CSV/TSV export, or go back to the dashboard and click “Pull errors &amp; build path”.</div>';
      $('pasteWrap').open = true;
    }
  });

  // ---- Direct ATLAS pull (OpenSearch API via background) --------------------

  els.fetchAtlas.addEventListener('click', fetchFromAtlas);

  async function fetchFromAtlas() {
    warehouseId = els.wh.value.trim() || 'IND8';
    const types = els.types.value;
    const hoursBack = parseInt(els.hours.value, 10) || 12;
    els.status.textContent = 'Querying ATLAS…';
    els.fetchAtlas.disabled = true;
    try {
      const resp = await browser.runtime.sendMessage({
        type: 'atlasSearch',
        opts: { warehouseId, types, hoursBack }
      });
      if (!resp || resp.error) throw new Error(resp ? resp.error : 'no response');
      currentErrors = resp.errors || [];
      updateMeta();
      if (!currentErrors.length) {
        els.status.textContent = `ATLAS returned 0 usable errors for that window (matched ${resp.total || 0} docs).`;
        els.stops.innerHTML = '<div class="empty">No errors in that time window. Widen the lookback, change the error type, or use the paste fallback.</div>';
      } else {
        els.status.textContent = `Pulled ${currentErrors.length} errors from ATLAS.`;
        build();
      }
    } catch (err) {
      els.status.textContent = 'ATLAS error: ' + err.message + ' — try the CSV/TSV paste fallback.';
      $('pasteWrap').open = true;
    } finally {
      els.fetchAtlas.disabled = false;
    }
  }

  function updateMeta() {
    const rejects = currentErrors.filter(e => e.source === 'reject').length;
    const shorts = currentErrors.length - rejects;
    els.meta.textContent = `${currentErrors.length} errors (${rejects} rejects, ${shorts} shorts) · ${warehouseId}`;
  }

  // ---- Build (route + enrich via background) --------------------------------

  els.build.addEventListener('click', build);
  els.start.addEventListener('keydown', (e) => { if (e.key === 'Enter') build(); });

  async function build() {
    if (!currentErrors.length) { els.status.textContent = 'No errors to route.'; return; }
    warehouseId = els.wh.value.trim() || 'IND8';
    const startBin = els.start.value.trim();
    const enrich = els.enrich.checked;
    els.status.textContent = enrich ? 'Routing & pulling FC Research images…' : 'Routing…';
    els.build.disabled = true;

    try {
      const resp = await browser.runtime.sendMessage({
        type: 'buildPath',
        payload: { errors: currentErrors, startBin, warehouseId, enrich }
      });
      if (!resp || resp.error) throw new Error(resp ? resp.error : 'no response');
      render(resp.route, startBin);
      els.status.textContent = `Done — ${resp.route.stops.length} stops.`;
    } catch (err) {
      els.status.textContent = 'Error: ' + err.message;
    } finally {
      els.build.disabled = false;
    }
  }

  // ---- Render ---------------------------------------------------------------

  function render(route, startBin) {
    // Mini aisle strip (unique aisles in visit order).
    const aisleSeq = [];
    for (const s of route.stops) {
      const a = s.aisle || s.bin;
      if (aisleSeq[aisleSeq.length - 1] !== a) aisleSeq.push(a);
    }
    els.mini.innerHTML = aisleSeq.map((a, i) =>
      `<span class="aisle-chip">${escapeHtml(a)}</span>` +
      (i < aisleSeq.length - 1 ? '<span class="arrow">→</span>' : '')
    ).join('');

    const frag = document.createDocumentFragment();
    for (const s of route.stops) frag.appendChild(renderStop(s));

    if (route.unrouted && route.unrouted.length) {
      const note = document.createElement('div');
      note.className = 'empty';
      note.textContent = `${route.unrouted.length} error(s) had unparseable bins and were left out of the route.`;
      frag.appendChild(note);
    }
    els.stops.innerHTML = '';
    els.stops.appendChild(frag);
  }

  function renderStop(s) {
    const it = s.item || {};
    const fc = s.fc || {};
    const idForLinks = it.fnsku || it.asin || '';
    const img = fc.imageDataUrl || fc.imageUrl;

    const wrap = document.createElement('div');
    wrap.className = 'stop';

    const badge = it.source === 'reject'
      ? `<span class="badge reject">reject</span>`
      : `<span class="badge short">short</span>`;

    const name = it.itemName || fc.title || '';
    const reason = it.rejectReason ? `<div class="kv"><b>Reason:</b> ${escapeHtml(it.rejectReason)}</div>` : '';
    const qty = it.quantity ? `<b>Qty ${escapeHtml(String(it.quantity))}</b> · ` : '';
    const details = [];
    if (fc.weight) details.push(`${escapeHtml(String(fc.weight))} lb`);
    if (fc.dimensions) details.push(escapeHtml(fc.dimensions));
    if (fc.binding) details.push(escapeHtml(fc.binding));

    const fcLink = idForLinks
      ? `https://fcresearch-na.aka.amazon.com/${encodeURIComponent(warehouseId)}/results?s=${encodeURIComponent(idForLinks)}`
      : null;
    const rodeoLink = idForLinks
      ? `https://rodeo-iad.amazon.com/${encodeURIComponent(warehouseId)}/Search?searchKey=${encodeURIComponent(idForLinks)}`
      : null;

    wrap.innerHTML = `
      <div class="order">${s.order}</div>
      ${img
        ? `<img class="thumb" src="${escapeAttr(img)}" alt="" loading="lazy" />`
        : `<div class="thumb ph">${fc.error ? 'no image' : '—'}</div>`}
      <div class="info">
        <div>
          <span class="bin">${escapeHtml(s.bin)}</span>
          <span class="aisle-tag">aisle ${escapeHtml(s.aisle || '?')}${s.slot != null ? ' · slot ' + s.slot : ''}</span>
          ${badge}
        </div>
        ${name ? `<div class="name">${escapeHtml(name)}</div>` : ''}
        <div class="kv">${qty}<b>ASIN</b> ${escapeHtml(it.asin || fc.asin || '—')} · <b>FNSKU</b> ${escapeHtml(it.fnsku || '—')}</div>
        ${details.length ? `<div class="kv">${details.join(' · ')}</div>` : ''}
        ${reason}
        <div class="links">
          ${fcLink ? `<a href="${escapeAttr(fcLink)}" target="_blank" rel="noopener">FC Research ↗</a>` : ''}
          ${rodeoLink ? `<a href="${escapeAttr(rodeoLink)}" target="_blank" rel="noopener">Rodeo ↗</a>` : ''}
        </div>
      </div>`;
    return wrap;
  }

  // ---- CSV / TSV paste fallback --------------------------------------------

  els.parsePaste.addEventListener('click', () => {
    const text = els.pasteBox.value.trim();
    if (!text) { els.status.textContent = 'Paste some rows first.'; return; }
    const rows = parseDelimited(text);
    const errors = rowsToErrors(rows);
    if (!errors.length) { els.status.textContent = 'Could not find bin + fnsku/asin columns in the pasted text.'; return; }
    currentErrors = errors;
    updateMeta();
    els.status.textContent = `Loaded ${errors.length} rows from paste.`;
    build();
  });

  const FIELD_ALIASES = {
    time: 'time', timestamp: 'timestamp', warehouse_id: 'warehouseId',
    bin: 'bin', bin_raw: 'binRaw', fnsku: 'fnsku', asin: 'asin', asin_raw: 'asinRaw',
    item_name: 'itemName', quantity: 'quantity', reject_reason: 'rejectReason',
    binding_name: 'binding'
  };

  function parseDelimited(text) {
    const firstLine = text.split(/\r?\n/, 1)[0];
    const delim = firstLine.includes('\t') ? '\t' : ',';
    return parseCSV(text, delim);
  }

  // Minimal CSV/TSV parser with quote handling.
  function parseCSV(text, delim) {
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function rowsToErrors(rows) {
    if (rows.length < 2) return [];
    const header = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
    const colMap = {};
    header.forEach((h, i) => { if (FIELD_ALIASES[h]) colMap[i] = FIELD_ALIASES[h]; });

    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      if (!cells || !cells.length) continue;
      const rec = {};
      cells.forEach((v, i) => { if (colMap[i]) rec[colMap[i]] = (v || '').trim(); });
      const bin = rec.binRaw || rec.bin;
      const id = rec.fnsku || rec.asinRaw || rec.asin;
      if (!bin || !id) continue;
      out.push({
        bin, fnsku: rec.fnsku || '', asin: rec.asinRaw || rec.asin || '',
        itemName: rec.itemName || '', quantity: rec.quantity || '',
        rejectReason: rec.rejectReason || '', binding: rec.binding || '',
        time: rec.time || rec.timestamp || '',
        source: rec.rejectReason ? 'reject' : 'short'
      });
    }
    return out;
  }

  // ---- helpers --------------------------------------------------------------

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }
})();
