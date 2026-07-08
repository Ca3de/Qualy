// path.js — Qualy Pick Path results page.
// Reads the scraped payload, asks the background to route + enrich, renders the
// curated walking path. Also supports a CSV/TSV paste fallback.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let currentErrors = [];
  let warehouseId = 'IND8';
  let lastRoute = null;          // most recently built route
  let confirmState = null;       // { i, results:[] } during a confirmation walk

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
    lastRoute = route;
    const bar = $('confirmBar');
    if (bar) bar.hidden = route.stops.length === 0;

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
        <div class="kv">${qty}<b>LPN</b> ${escapeHtml(it.lpn || '—')} · <b>AA</b> ${escapeHtml(it.aa || '—')}</div>
        <div class="kv"><b>ASIN</b> ${escapeHtml(it.asin || fc.asin || '—')} · <b>FNSKU</b> ${escapeHtml(it.fnsku || '—')}</div>
        ${details.length ? `<div class="kv">${details.join(' · ')}</div>` : ''}
        ${reason}
        <div class="links">
          ${fcLink ? `<a href="${escapeAttr(fcLink)}" target="_blank" rel="noopener">FC Research ↗</a>` : ''}
          ${rodeoLink ? `<a href="${escapeAttr(rodeoLink)}" target="_blank" rel="noopener">Rodeo ↗</a>` : ''}
        </div>
      </div>`;
    return wrap;
  }

  // ---- Guided confirmation walk --------------------------------------------

  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'startConfirm') startConfirm();
  });

  function startConfirm() {
    if (!lastRoute || !lastRoute.stops.length) return;
    confirmState = { i: 0, results: [] };
    $('overlay').hidden = false;
    document.body.style.overflow = 'hidden';
    renderConfirmStep();
  }

  function closeConfirm() {
    $('overlay').hidden = true;
    document.body.style.overflow = '';
    confirmState = null;
  }

  function renderConfirmStep() {
    const stops = lastRoute.stops;
    const i = confirmState.i;
    if (i >= stops.length) return renderConfirmSummary();

    const s = stops[i];
    const it = s.item || {};
    const fc = s.fc || {};
    const img = fc.imageDataUrl || fc.imageUrl;
    const isReject = it.source === 'reject';
    const name = it.itemName || fc.title || '';

    $('ovCard').innerHTML = `
      <div class="ov-top">
        <span class="ov-prog">Location ${i + 1} of ${stops.length}</span>
        <button class="ov-x" id="ovClose" title="Exit">✕</button>
      </div>
      <div class="ov-bin">${escapeHtml(s.bin)}</div>
      <div class="ov-sub">aisle ${escapeHtml(s.aisle || '?')}${s.slot != null ? ' · slot ' + s.slot : ''}
        <span class="badge ${isReject ? 'reject' : 'short'}">${isReject ? 'REJECT' : 'SHORT'}</span>
      </div>
      <div class="ov-body">
        ${img ? `<img class="ov-img" src="${escapeAttr(img)}" alt="" />`
              : `<div class="ov-img ph">no image</div>`}
        <div class="ov-info">
          ${name ? `<div class="ov-name">${escapeHtml(name)}</div>` : ''}
          <div class="ov-kv"><span>LPN</span><b>${escapeHtml(it.lpn || '—')}</b></div>
          <div class="ov-kv"><span>AA (login)</span><b>${escapeHtml(it.aa || '—')}</b></div>
          <div class="ov-kv"><span>Qty</span><b>${escapeHtml(String(it.quantity || '—'))}</b></div>
          <div class="ov-kv"><span>ASIN / FNSKU</span><b>${escapeHtml(it.asin || fc.asin || '—')} / ${escapeHtml(it.fnsku || '—')}</b></div>
          ${it.rejectReason ? `<div class="ov-kv"><span>Reject reason</span><b>${escapeHtml(it.rejectReason)}</b></div>` : ''}
        </div>
      </div>
      <div class="ov-actions" id="ovActions">
        <button class="btn deny" id="ovDeny">✕ Deny</button>
        <button class="btn primary confirm" id="ovConfirm">✓ Confirm error</button>
      </div>
      <div class="ov-deny" id="ovDenyBox" hidden>
        <label>Reason for denial</label>
        <input id="ovReason" type="text" placeholder="e.g. item present and scannable" />
        <div class="ov-deny-actions">
          <button class="btn" id="ovDenyCancel">Back</button>
          <button class="btn primary" id="ovDenySave">Save denial</button>
        </div>
      </div>`;

    $('ovClose').onclick = () => confirmExitGuard();
    $('ovConfirm').onclick = () => recordDecision('confirmed', '');
    $('ovDeny').onclick = () => {
      $('ovActions').hidden = true;
      $('ovDenyBox').hidden = false;
      $('ovReason').focus();
    };
    $('ovDenyCancel').onclick = () => {
      $('ovDenyBox').hidden = true;
      $('ovActions').hidden = false;
    };
    $('ovDenySave').onclick = () => {
      const reason = $('ovReason').value.trim();
      if (!reason) { $('ovReason').focus(); $('ovReason').classList.add('err'); return; }
      recordDecision('denied', reason);
    };
    $('ovReason').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('ovDenySave').click(); });
  }

  function recordDecision(decision, reason) {
    const s = lastRoute.stops[confirmState.i];
    confirmState.results.push({ stop: s, decision, reason });
    confirmState.i++;
    renderConfirmStep();
  }

  function confirmExitGuard() {
    const done = confirmState.results.length;
    if (done > 0 && done < lastRoute.stops.length &&
        !window.confirm(`Exit the walk? ${done} of ${lastRoute.stops.length} recorded — you can still download a partial report.`)) {
      return;
    }
    if (done > 0) renderConfirmSummary();
    else closeConfirm();
  }

  function renderConfirmSummary() {
    const results = confirmState.results;
    const confirmed = results.filter(r => r.decision === 'confirmed').length;
    const denied = results.length - confirmed;

    $('ovCard').innerHTML = `
      <div class="ov-top">
        <span class="ov-prog">Walk complete — ${results.length} checked</span>
        <button class="ov-x" id="ovClose" title="Close">✕</button>
      </div>
      <div class="ov-summary">
        <div class="sum-tile ok"><div class="n">${confirmed}</div><div>Confirmed</div></div>
        <div class="sum-tile no"><div class="n">${denied}</div><div>Denied</div></div>
        <div class="sum-tile"><div class="n">${results.length}</div><div>Total</div></div>
      </div>
      <div class="ov-actions">
        <button class="btn" id="ovCloseBtn">Close</button>
        <button class="btn primary" id="ovDownload">⬇ Download report (.md)</button>
      </div>
      <div class="ov-note" id="ovNote"></div>`;

    $('ovClose').onclick = closeConfirm;
    $('ovCloseBtn').onclick = closeConfirm;
    $('ovDownload').onclick = () => downloadReport(results);
  }

  // ---- Report ---------------------------------------------------------------

  function downloadReport(results) {
    const md = buildReportMarkdown(results);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fname = `pick-verification-${warehouseId}-${stamp}.md`;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    const note = $('ovNote');
    if (note) note.textContent = `Saved ${fname}`;
  }

  function buildReportMarkdown(results) {
    const now = new Date();
    const confirmed = results.filter(r => r.decision === 'confirmed').length;
    const denied = results.length - confirmed;
    const startBin = $('startBin').value.trim() || '(not set)';

    const lines = [];
    lines.push(`# Pick Error Verification Report — ${warehouseId}`);
    lines.push('');
    lines.push(`- **Generated:** ${now.toString()}`);
    lines.push(`- **Warehouse:** ${warehouseId}`);
    lines.push(`- **Start location:** ${startBin}`);
    lines.push(`- **Checked:** ${results.length}  ·  **Confirmed:** ${confirmed}  ·  **Denied:** ${denied}`);
    lines.push('');
    lines.push('| # | Result | Bin | Aisle | Error | LPN | AA | ASIN | FNSKU | Item | Qty | Reason |');
    lines.push('|---|--------|-----|-------|-------|-----|----|------|-------|------|-----|--------|');
    results.forEach((r, idx) => {
      const it = r.stop.item || {};
      const cells = [
        idx + 1,
        r.decision === 'confirmed' ? '✅ confirmed' : '❌ denied',
        r.stop.bin || '',
        r.stop.aisle || '',
        (it.source === 'reject' ? 'reject' : 'short'),
        it.lpn || '',
        it.aa || '',
        it.asin || '',
        it.fnsku || '',
        mdCell(it.itemName || ''),
        it.quantity || '',
        mdCell(r.reason || '')
      ];
      lines.push('| ' + cells.map(c => String(c)).join(' | ') + ' |');
    });
    lines.push('');

    if (denied) {
      lines.push('## Denied items');
      lines.push('');
      results.filter(r => r.decision === 'denied').forEach(r => {
        const it = r.stop.item || {};
        lines.push(`- **${r.stop.bin}** (${it.source === 'reject' ? 'reject' : 'short'}) — LPN ${it.lpn || '—'}, AA ${it.aa || '—'} — reason: ${r.reason}`);
      });
      lines.push('');
    }

    lines.push('---');
    lines.push('_Generated by Qualy Pick Path._');
    return lines.join('\n');
  }

  function mdCell(s) {
    // Keep table cells single-line and pipe-safe.
    return String(s || '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
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
    binding_name: 'binding', user_id: 'aa', user_login: 'aa', user_: 'aa',
    login: 'aa', lpn: 'lpn'
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
        aa: rec.aa || '', lpn: rec.lpn || '',
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
