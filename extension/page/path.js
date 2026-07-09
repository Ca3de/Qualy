// path.js — Qualy Pick Path results page.
// Reads the scraped payload, asks the background to route + enrich, renders the
// curated walking path. Also supports a CSV/TSV paste fallback.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let currentErrors = [];
  let warehouseId = 'IND8';
  let lastRoute = null;          // most recently built route
  let confirmState = null;       // { current } during a confirmation walk
  const decisions = new Map();   // errorKey -> { stop, decision, reason }
  const reportedKeys = new Set(); // decisions already written to a report
  let autoTimer = null;          // auto-crawl interval id
  let notifyCfg = { on: false, webhook: '', threshold: 5, varName: 'message' };
  let notifyQueue = [];          // new errors not yet notified
  let notifyArmed = false;       // don't notify for the initial backfill

  function errorKey(e) {
    if (!e) return '';
    return [e.bin || '', e.lpn || e.fnsku || e.asin || '', e.time || ''].join('|');
  }
  const keyOfStop = (s) => errorKey(s && s.item);

  // Decisions that haven't been written to a downloaded report yet.
  function unreported() {
    const out = [];
    decisions.forEach((v, k) => { if (!reportedKeys.has(k)) out.push(v); });
    return out;
  }

  const els = {
    meta: $('meta'), start: $('startBin'), wh: $('warehouse'), enrich: $('enrich'),
    build: $('build'), status: $('status'), stops: $('stops'), mini: $('mini'),
    pasteBox: $('pasteBox'), parsePaste: $('parsePaste'),
    types: $('types'), hours: $('hours'), fetchAtlas: $('fetchAtlas'),
    timeMode: $('timeMode'), hoursWrap: $('hoursWrap'), fromWrap: $('fromWrap'),
    toWrap: $('toWrap'), fromDt: $('fromDt'), toDt: $('toDt'), rangeInfo: $('rangeInfo'),
    autoCrawl: $('autoCrawl'), autoMin: $('autoMin'), autoMinWrap: $('autoMinWrap'),
    clearBtn: $('clearBtn'),
    notifyOn: $('notifyOn'), notifyHook: $('notifyHook'),
    notifyThreshold: $('notifyThreshold'), notifyTest: $('notifyTest'),
    notifyVar: $('notifyVar'), notifyVarWrap: $('notifyVarWrap'),
    showChecked: $('showChecked'), checkedNote: $('checkedNote')
  };

  els.showChecked.addEventListener('change', applyShowChecked);
  els.checkedNote.addEventListener('click', () => {
    els.showChecked.checked = true;
    applyShowChecked();
  });

  // Hide already-checked cards to keep the list uncluttered (toggle to show).
  function applyShowChecked() {
    const show = els.showChecked.checked;
    els.stops.classList.toggle('hide-checked', !show);
    browser.storage.local.set({ qualyShowChecked: show }).catch(() => {});
    updateCheckedNote();
  }

  function updateCheckedNote() {
    const checked = currentErrors.filter(e => decisions.has(errorKey(e))).length;
    if (!els.showChecked.checked && checked > 0) {
      els.checkedNote.hidden = false;
      els.checkedNote.textContent = `✓ ${checked} checked error${checked > 1 ? 's' : ''} hidden — click to show`;
    } else {
      els.checkedNote.hidden = true;
    }
  }

  els.autoCrawl.addEventListener('change', toggleAutoCrawl);
  els.autoMin.addEventListener('change', () => { if (els.autoCrawl.checked) toggleAutoCrawl(); });
  els.clearBtn.addEventListener('click', clearChecklist);

  ['change', 'input'].forEach(ev => {
    els.notifyOn.addEventListener(ev, saveNotifyCfg);
    els.notifyHook.addEventListener(ev, saveNotifyCfg);
    els.notifyThreshold.addEventListener(ev, saveNotifyCfg);
    els.notifyVar.addEventListener(ev, saveNotifyCfg);
  });
  els.notifyTest.addEventListener('click', () => {
    saveNotifyCfg();
    if (!notifyCfg.webhook) { els.status.textContent = 'Enter a Slack webhook URL first.'; return; }
    const text = `:white_check_mark: Qualy Pick Path test — notifications working for ${els.wh.value.trim() || 'IND8'}.`;
    els.status.textContent = 'Sending Slack test…';
    postSlack(text).then(r => {
      els.status.textContent = (r && r.error) ? 'Slack test failed: ' + r.error : 'Slack test sent ✓';
    });
  });

  function saveNotifyCfg() {
    notifyCfg = {
      on: els.notifyOn.checked,
      webhook: els.notifyHook.value.trim(),
      threshold: Math.max(1, parseInt(els.notifyThreshold.value, 10) || 5),
      varName: (els.notifyVar.value || 'message').trim() || 'message'
    };
    browser.storage.local.set({ qualyNotify: notifyCfg }).catch(() => {});
    els.notifyVarWrap.hidden = !/\/triggers\//.test(notifyCfg.webhook);
    maybeNotify(); // in case the threshold was lowered below the queue
  }

  function clearChecklist() {
    if (decisions.size && !window.confirm('Clear the checklist and all un-downloaded decisions?')) return;
    currentErrors = [];
    decisions.clear();
    reportedKeys.clear();
    notifyQueue = [];
    persistSession();
    updateMeta();
    clearView();
    els.status.textContent = 'Checklist cleared.';
  }

  // ---- Time range handling --------------------------------------------------

  els.timeMode.addEventListener('change', onTimeModeChange);
  ['input', 'change'].forEach(ev => {
    els.hours.addEventListener(ev, previewRange);
    els.fromDt.addEventListener(ev, previewRange);
    els.toDt.addEventListener(ev, previewRange);
  });

  function onTimeModeChange() {
    const mode = els.timeMode.value;
    els.hoursWrap.hidden = mode !== 'hours';
    els.fromWrap.hidden = mode !== 'custom';
    els.toWrap.hidden = mode !== 'custom';
    if (mode === 'custom' && !els.fromDt.value) {
      // Seed custom inputs with the last 12h so they're not empty.
      const now = new Date();
      const twelve = new Date(now.getTime() - 12 * 3600 * 1000);
      els.fromDt.value = toLocalInput(twelve);
      els.toDt.value = toLocalInput(now);
    }
    previewRange();
  }

  // Returns { fromISO, toISO, label } for the current time-range selection,
  // or { hoursBack } for the rolling-hours mode.
  function resolveTimeRange() {
    const mode = els.timeMode.value;
    if (mode === 'hours') {
      const h = parseInt(els.hours.value, 10) || 12;
      return { hoursBack: h, label: `last ${h}h` };
    }
    if (mode === 'custom') {
      const from = els.fromDt.value ? new Date(els.fromDt.value) : null;
      const to = els.toDt.value ? new Date(els.toDt.value) : new Date();
      if (!from) return { error: 'Set a "From" date/time.' };
      return { fromISO: from.toISOString(), toISO: to.toISOString(),
               label: `${fmt(from)} → ${fmt(to)}` };
    }
    // Shift windows, computed against the wall clock (associate's local = FC time).
    const { from, to } = computeShiftRange(mode);
    return { fromISO: from.toISOString(), toISO: to.toISOString(),
             label: `${mode} shift · ${fmt(from)} → ${fmt(to)}` };
  }

  // Day shift: 06:00–18:00 today. Night shift (overnight): 18:00→06:00 spanning
  // midnight — the window that contains (or most recently contained) "now".
  function computeShiftRange(mode) {
    const now = new Date();
    const h = now.getHours();
    const atToday = (hour) => {
      const d = new Date(now); d.setHours(hour, 0, 0, 0); return d;
    };
    const shift = (d, days) => new Date(d.getTime() + days * 86400000);

    if (mode === 'day') {
      return { from: atToday(6), to: atToday(18) };
    }
    // night
    if (h >= 18) {
      // Evening: tonight 18:00 -> tomorrow 06:00.
      return { from: atToday(18), to: shift(atToday(6), 1) };
    }
    if (h < 6) {
      // After midnight: yesterday 18:00 -> today 06:00.
      return { from: shift(atToday(18), -1), to: atToday(6) };
    }
    // Daytime but night selected: use the most recent completed night
    // (yesterday 18:00 -> today 06:00).
    return { from: shift(atToday(18), -1), to: atToday(6) };
  }

  function previewRange() {
    const r = resolveTimeRange();
    if (r.error) { els.rangeInfo.textContent = r.error; return; }
    if (r.hoursBack) {
      const to = new Date();
      const from = new Date(to.getTime() - r.hoursBack * 3600000);
      els.rangeInfo.textContent = `Window: ${fmt(from)} → ${fmt(to)} (${r.label})`;
    } else {
      els.rangeInfo.textContent = `Window: ${r.label}`;
    }
  }

  function toLocalInput(d) {
    // Format a Date as a datetime-local value (local time, no seconds).
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fmt(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---- Load payload ---------------------------------------------------------

  browser.storage.local.get(['qualyPayload', 'qualySession', 'qualyAuto', 'qualyNotify', 'qualyShowChecked']).then((r) => {
    const p = (r && r.qualyPayload) || {};
    const hadSession = restoreSession(r && r.qualySession);

    els.showChecked.checked = !!(r && r.qualyShowChecked);
    applyShowChecked();

    // Restore notification config.
    if (r && r.qualyNotify) {
      notifyCfg = Object.assign(notifyCfg, r.qualyNotify);
      els.notifyOn.checked = !!notifyCfg.on;
      els.notifyHook.value = notifyCfg.webhook || '';
      els.notifyThreshold.value = notifyCfg.threshold || 5;
      els.notifyVar.value = notifyCfg.varName || 'message';
      els.notifyVarWrap.hidden = !/\/triggers\//.test(notifyCfg.webhook || '');
    }

    warehouseId = p.warehouseId || warehouseId || 'IND8';
    els.wh.value = warehouseId;
    if (p.startBin) els.start.value = p.startBin;
    if (typeof p.enrich === 'boolean') els.enrich.checked = p.enrich;
    if (p.types) els.types.value = p.types;
    if (p.hoursBack) els.hours.value = p.hoursBack;
    if (p.timeMode) els.timeMode.value = p.timeMode;
    onTimeModeChange();

    // Restore auto-crawl toggle.
    const auto = r && r.qualyAuto;
    if (auto) {
      els.autoCrawl.checked = !!auto.on;
      if (auto.min) els.autoMin.value = auto.min;
    }

    if (p.mode === 'api') {
      fetchFromAtlas();                     // pull + merge into the checklist
    } else if (p.mode === 'rows' && Array.isArray(p.errors)) {
      mergeErrors(p.errors);
      updateMeta();
      if (currentErrors.length) build(); else showEmpty();
    } else if (hadSession && currentErrors.length) {
      updateMeta();
      build();                              // resume the outstanding checklist
    } else {
      updateMeta();
      showEmpty();
    }

    if (els.autoCrawl.checked) toggleAutoCrawl();
  });

  function showEmpty() {
    els.stops.innerHTML = '<div class="empty">No errors loaded. Click <b>Fetch from ATLAS</b> above, paste the CSV/TSV export, or go back to the dashboard and open the panel.</div>';
    $('pasteWrap').open = true;
  }

  // ---- Direct ATLAS pull (OpenSearch API via background) --------------------

  els.fetchAtlas.addEventListener('click', fetchFromAtlas);

  async function fetchFromAtlas() {
    warehouseId = els.wh.value.trim() || 'IND8';
    const types = els.types.value;
    const range = resolveTimeRange();
    if (range.error) { els.status.textContent = range.error; return; }
    els.status.textContent = `Querying ATLAS (${range.label})…`;
    els.fetchAtlas.disabled = true;
    try {
      const opts = { warehouseId, types };
      if (range.hoursBack) opts.hoursBack = range.hoursBack;
      else { opts.fromISO = range.fromISO; opts.toISO = range.toISO; }
      const resp = await browser.runtime.sendMessage({ type: 'atlasSearch', opts });
      if (!resp || resp.error) throw new Error(resp ? resp.error : 'no response');
      const added = mergeErrors(resp.errors || []);
      updateMeta();
      if (!currentErrors.length) {
        els.status.textContent = `ATLAS returned 0 usable errors for that window (matched ${resp.total || 0} docs).`;
        els.stops.innerHTML = '<div class="empty">No errors in that time window. Widen the lookback, change the error type, or use the paste fallback.</div>';
      } else {
        els.status.textContent = `Pulled ${resp.errors ? resp.errors.length : 0} · +${added} new · ${currentErrors.length} in checklist.`;
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
    const checked = currentErrors.filter(e => decisions.has(errorKey(e))).length;
    els.meta.textContent =
      `${currentErrors.length} errors (${rejects} rej, ${shorts} short) · ${checked} checked · ${warehouseId}`;
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
      updateMeta();
      persistSession();
      notifyArmed = true; // initial backfill shown; notify only from here on
      const x = resp.route.crossings || 0;
      els.status.textContent = `Done — ${resp.route.stops.length} stops · ${x} green-mile crossing${x === 1 ? '' : 's'}.`;
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
    applyDecisionMarks();
    updateCheckedNote();
  }

  function renderStop(s) {
    const it = s.item || {};
    const fc = s.fc || {};
    const idForLinks = it.fnsku || it.asin || '';
    const img = fc.imageDataUrl || fc.imageUrl;

    const wrap = document.createElement('div');
    wrap.className = 'stop';
    wrap.dataset.key = keyOfStop(s);

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
          <span class="aisle-tag">aisle ${escapeHtml(s.aisle || '?')}${s.level ? ' · level ' + escapeHtml(s.level) : ''}${s.slot != null ? ' · slot ' + s.slot : ''}</span>
          ${badge}
          ${s.locked ? '<span class="badge locked" title="Top/bottom shelf — key needed">🔒 locked</span>' : ''}
          <span class="stop-status"></span>
        </div>
        ${name ? `<div class="name">${escapeHtml(name)}</div>` : ''}
        <div class="kv">${qty}<b>LPN</b> ${escapeHtml(it.lpn || '—')} · <b>AA</b> ${escapeHtml(it.aa || '—')}${it.manager ? ' · <b>Mgr</b> ' + escapeHtml(it.manager) : ''}</div>
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

  // ---- Guided confirmation walk (key-based, live checklist) ----------------

  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'startConfirm') startConfirm();
  });

  // Stops still needing a decision, in route order.
  function pendingStops() {
    return lastRoute ? lastRoute.stops.filter(s => !decisions.has(keyOfStop(s))) : [];
  }

  function startConfirm() {
    if (!lastRoute || !lastRoute.stops.length) return;
    confirmState = {};
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
    const pend = pendingStops();
    if (!pend.length) {
      // Auto-crawl mode: finish the batch by auto-downloading the report, then
      // wait for the next crawl to bring new errors (a fresh report).
      if (els.autoCrawl.checked && unreported().length) {
        finalizeReport(true);
        return renderAutoWaiting();
      }
      return renderConfirmSummary();
    }

    const s = pend[0];
    confirmState.current = s;
    const total = lastRoute.stops.length;
    const done = total - pend.length;

    const it = s.item || {};
    const fc = s.fc || {};
    const img = fc.imageDataUrl || fc.imageUrl;
    const isReject = it.source === 'reject';
    const name = it.itemName || fc.title || '';

    $('ovCard').innerHTML = `
      <div class="ov-top">
        <span class="ov-prog">Location ${done + 1} of ${total}${pend.length > 1 ? ` · ${pend.length} left` : ''}</span>
        <button class="ov-x" id="ovClose" title="Exit">✕</button>
      </div>
      <div class="ov-bin">${escapeHtml(s.bin)}</div>
      <div class="ov-sub">aisle ${escapeHtml(s.aisle || '?')}${s.level ? ' · level ' + escapeHtml(s.level) : ''}${s.slot != null ? ' · slot ' + s.slot : ''}
        <span class="badge ${isReject ? 'reject' : 'short'}">${isReject ? 'REJECT' : 'SHORT'}</span>
        ${s.locked ? '<span class="badge locked">🔒 locked shelf</span>' : ''}
      </div>
      <div class="ov-body">
        ${img ? `<img class="ov-img" src="${escapeAttr(img)}" alt="" />`
              : `<div class="ov-img ph">no image</div>`}
        <div class="ov-info">
          ${name ? `<div class="ov-name">${escapeHtml(name)}</div>` : ''}
          <div class="ov-kv"><span>LPN</span><b>${escapeHtml(it.lpn || '—')}</b></div>
          <div class="ov-kv"><span>AA (login)</span><b>${escapeHtml(it.aa || '—')}${it.manager ? ' · mgr ' + escapeHtml(it.manager) : ''}</b></div>
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
        <label id="ovReasonLabel">Reason</label>
        <input id="ovReason" type="text" placeholder="type a reason…" />
        <div class="ov-deny-actions">
          <button class="btn" id="ovDenyCancel">Back</button>
          <button class="btn primary" id="ovDenySave">Save</button>
        </div>
      </div>`;

    // Rejects need a reason on BOTH confirm and deny; shorts only on deny.
    function openReason(decision, label) {
      confirmState.reasonFor = decision;
      $('ovReasonLabel').textContent = label;
      $('ovReason').value = '';
      $('ovReason').classList.remove('err');
      $('ovActions').hidden = true;
      $('ovDenyBox').hidden = false;
      $('ovReason').focus();
    }

    $('ovClose').onclick = () => confirmExitGuard();
    $('ovConfirm').onclick = () => {
      if (isReject) openReason('confirmed', 'Reason for confirming this reject');
      else recordDecision('confirmed', '');
    };
    $('ovDeny').onclick = () => openReason('denied', 'Reason for denial');
    $('ovDenyCancel').onclick = () => {
      $('ovDenyBox').hidden = true;
      $('ovActions').hidden = false;
    };
    $('ovDenySave').onclick = () => {
      const reason = $('ovReason').value.trim();
      if (!reason) { $('ovReason').focus(); $('ovReason').classList.add('err'); return; }
      recordDecision(confirmState.reasonFor || 'denied', reason);
    };
    $('ovReason').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('ovDenySave').click(); });
  }

  function recordDecision(decision, reason) {
    const s = confirmState.current;
    if (!s) return;
    decisions.set(keyOfStop(s), { stop: slimStop(s), decision, reason });
    persistSession();
    markStopCard(s);
    renderConfirmStep();
  }

  function confirmExitGuard() {
    // Everything is saved as you go, so exiting is safe.
    closeConfirm();
  }

  function renderConfirmSummary() {
    const results = unreported();          // only the not-yet-reported batch
    const confirmed = results.filter(r => r.decision === 'confirmed').length;
    const denied = results.length - confirmed;
    const msg = results.length ? 'All checked' : 'Nothing new to report';

    $('ovCard').innerHTML = `
      <div class="ov-top">
        <span class="ov-prog">${msg} — ${results.length} in this report</span>
        <button class="ov-x" id="ovClose" title="Close">✕</button>
      </div>
      <div class="ov-summary">
        <div class="sum-tile ok"><div class="n">${confirmed}</div><div>Confirmed</div></div>
        <div class="sum-tile no"><div class="n">${denied}</div><div>Denied</div></div>
        <div class="sum-tile"><div class="n">${results.length}</div><div>Total</div></div>
      </div>
      <div class="ov-actions">
        <button class="btn" id="ovCloseBtn">Close</button>
        <button class="btn primary" id="ovDownload"${results.length ? '' : ' disabled'}>⬇ Download report &amp; start new</button>
      </div>
      <div class="ov-note" id="ovNote"></div>`;

    $('ovClose').onclick = closeConfirm;
    $('ovCloseBtn').onclick = closeConfirm;
    $('ovDownload').onclick = () => { finalizeReport(); closeConfirm(); };
  }

  function renderAutoWaiting() {
    $('ovCard').innerHTML = `
      <div class="ov-top">
        <span class="ov-prog">Report saved · auto-crawl on</span>
        <button class="ov-x" id="ovClose" title="Close">✕</button>
      </div>
      <div class="ov-summary">
        <div class="sum-tile ok"><div class="n">✓</div><div>Report downloaded</div></div>
      </div>
      <p class="ov-wait">Waiting for new errors from ATLAS. When the next crawl finds any, they're added to the checklist and you can keep checking — a fresh report starts automatically.</p>
      <div class="ov-actions"><button class="btn" id="ovCloseBtn">Close</button></div>`;
    $('ovClose').onclick = closeConfirm;
    $('ovCloseBtn').onclick = closeConfirm;
  }

  // ---- Report ---------------------------------------------------------------

  // Download the not-yet-reported decisions, then MARK them reported. Decisions
  // and their errors stay in the checklist (shown with ✓/✕) so a crawl never
  // re-surfaces a checked error. The next batch of decisions is a fresh report.
  function finalizeReport(auto) {
    const results = unreported();
    if (!results.length) return false;
    downloadReport(results, auto);
    results.forEach(r => reportedKeys.add(keyOfStop(r.stop)));
    persistSession();
    updateMeta();
    return true;
  }

  function clearView() {
    lastRoute = null;
    els.stops.innerHTML = '<div class="empty">Checklist empty. Fetch or auto-crawl errors to begin.</div>';
    els.mini.innerHTML = '';
    const bar = $('confirmBar'); if (bar) bar.hidden = true;
  }

  function downloadReport(results, auto) {
    const md = buildReportMarkdown(results);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fname = `pick-verification-${warehouseId}-${stamp}.md`;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    els.status.textContent = `${auto ? 'Auto-saved' : 'Saved'} report: ${fname}`;
    const note = $('ovNote'); if (note) note.textContent = `Saved ${fname}`;
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
    lines.push('| # | Result | Bin | Aisle | Lvl | Error | LPN | AA | Mgr | ASIN | FNSKU | Item | Qty | Reason |');
    lines.push('|---|--------|-----|-------|-----|-------|-----|----|-----|------|-------|------|-----|--------|');
    results.forEach((r, idx) => {
      const it = r.stop.item || {};
      const cells = [
        idx + 1,
        r.decision === 'confirmed' ? '✅ confirmed' : '❌ denied',
        (r.stop.locked ? '🔒 ' : '') + (r.stop.bin || ''),
        r.stop.aisle || '',
        (r.stop.level || '') + (r.stop.locked ? ' (locked)' : ''),
        (it.source === 'reject' ? 'reject' : 'short'),
        it.lpn || '',
        it.aa || '',
        it.manager || '',
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

  // ---- Auto-crawl + session persistence ------------------------------------

  // A route stop without the (heavy) FC image — safe to persist and enough for
  // the report.
  function slimStop(s) {
    return {
      order: s.order, bin: s.bin, aisle: s.aisle, mod: s.mod, floor: s.floor,
      slot: s.slot, level: s.level, locked: s.locked, item: s.item
    };
  }

  // Merge freshly-crawled errors into the working checklist (dedup by key,
  // skipping anything already decided). Returns how many were added.
  function mergeErrors(incoming) {
    const known = new Set(currentErrors.map(errorKey));
    let added = 0;
    for (const e of incoming || []) {
      const k = errorKey(e);
      if (!k || known.has(k) || decisions.has(k)) continue;
      known.add(k); currentErrors.push(e); added++;
      if (notifyArmed && notifyCfg.on) notifyQueue.push(e);
    }
    maybeNotify();
    return added;
  }

  // Slack ping every `threshold` new pick errors. Coalesces a big batch into a
  // single message rather than one per 5.
  function maybeNotify() {
    if (!notifyCfg.on || !notifyCfg.webhook) return;
    const t = Math.max(1, parseInt(notifyCfg.threshold, 10) || 5);
    if (notifyQueue.length < t) return;
    const batch = notifyQueue.splice(0, notifyQueue.length);
    sendSlack(batch);
    persistSession();
  }

  function sendSlack(batch) {
    const lines = batch.slice(0, 12).map(e =>
      `• ${e.bin || '?'} — ${(e.itemName || '').slice(0, 60)} (${e.source || 'error'}${e.lpn ? ', ' + e.lpn : ''})`);
    if (batch.length > 12) lines.push(`…and ${batch.length - 12} more`);
    const text = `:rotating_light: ${batch.length} new pick errors at ${warehouseId} `
      + `(checklist now ${currentErrors.length})\n` + lines.join('\n');
    postSlack(text);
  }

  // Shape the body for the webhook type.
  // /triggers/  → Slack Workflow Builder: one flat variable { <varName>: text }
  // /services/  → classic Incoming Webhook: { text }
  function slackBody(text) {
    if (/\/triggers\//.test(notifyCfg.webhook || '')) {
      const v = (notifyCfg.varName || 'message').trim() || 'message';
      return { [v]: text };
    }
    return { text };
  }

  function postSlack(text) {
    if (!notifyCfg.webhook) return Promise.resolve({ error: 'no webhook' });
    return browser.runtime.sendMessage({ type: 'notify', webhook: notifyCfg.webhook, body: slackBody(text) })
      .then(r => { if (r && r.error) els.status.textContent = 'Slack: ' + r.error; return r; })
      .catch(e => ({ error: e.message }));
  }

  async function autoCrawl() {
    if (!els.autoCrawl.checked) return;
    const range = resolveTimeRange();
    if (range.error) { els.status.textContent = 'Auto-crawl: ' + range.error; return; }
    warehouseId = els.wh.value.trim() || 'IND8';
    try {
      const opts = { warehouseId, types: els.types.value };
      if (range.hoursBack) opts.hoursBack = range.hoursBack;
      else { opts.fromISO = range.fromISO; opts.toISO = range.toISO; }
      const resp = await browser.runtime.sendMessage({ type: 'atlasSearch', opts });
      if (!resp || resp.error) { els.status.textContent = 'Auto-crawl: ' + (resp ? resp.error : 'no response'); return; }
      const added = mergeErrors(resp.errors || []);
      const t = new Date().toLocaleTimeString();
      if (added) {
        await build();
        els.status.textContent = `Auto-crawl: +${added} new error(s) added to checklist (${t})`;
        // If a walk is open and idle on the summary, advance into the new items.
        if (confirmState && !$('overlay').hidden) renderConfirmStep();
      } else {
        els.status.textContent = `Auto-crawl: no new errors (${t})`;
      }
    } catch (err) {
      els.status.textContent = 'Auto-crawl error: ' + err.message;
    }
  }

  function toggleAutoCrawl() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    els.autoMinWrap.hidden = !els.autoCrawl.checked;
    if (els.autoCrawl.checked) {
      const min = Math.max(1, parseInt(els.autoMin.value, 10) || 5);
      autoCrawl();
      autoTimer = setInterval(autoCrawl, min * 60000);
    }
    browser.storage.local.set({
      qualyAuto: { on: els.autoCrawl.checked, min: parseInt(els.autoMin.value, 10) || 5 }
    }).catch(() => {});
  }

  // ---- Decision marks on the list ------------------------------------------

  function applyDecClass(card, dec) {
    card.classList.remove('done-confirm', 'done-deny');
    const st = card.querySelector('.stop-status');
    if (!dec) { if (st) st.textContent = ''; return; }
    card.classList.add(dec.decision === 'confirmed' ? 'done-confirm' : 'done-deny');
    if (st) st.textContent = dec.decision === 'confirmed' ? '✓ confirmed' : '✕ denied';
  }

  function markStopCard(s) {
    const k = keyOfStop(s);
    els.stops.querySelectorAll('.stop').forEach(c => {
      if (c.dataset.key === k) applyDecClass(c, decisions.get(k));
    });
    updateMeta();
    updateCheckedNote();
  }

  function applyDecisionMarks() {
    els.stops.querySelectorAll('.stop').forEach(c => applyDecClass(c, decisions.get(c.dataset.key)));
  }

  // ---- Session persistence --------------------------------------------------

  function persistSession() {
    try {
      const dec = [];
      decisions.forEach((v, k) => dec.push([k, v]));
      browser.storage.local.set({
        qualySession: {
          errors: currentErrors, decisions: dec, reported: [...reportedKeys],
          notifyQueue, warehouseId, startBin: els.start.value.trim(), ts: Date.now()
        }
      }).catch(() => {});
    } catch (e) { /* ignore quota */ }
  }

  function restoreSession(s) {
    if (!s) return false;
    currentErrors = Array.isArray(s.errors) ? s.errors : [];
    decisions.clear();
    (s.decisions || []).forEach(([k, v]) => decisions.set(k, v));
    reportedKeys.clear();
    (s.reported || []).forEach(k => reportedKeys.add(k));
    notifyQueue = Array.isArray(s.notifyQueue) ? s.notifyQueue : [];
    if (s.startBin) els.start.value = s.startBin;
    warehouseId = s.warehouseId || warehouseId;
    return currentErrors.length > 0;
  }

  // ---- CSV / TSV paste fallback --------------------------------------------

  els.parsePaste.addEventListener('click', () => {
    const text = els.pasteBox.value.trim();
    if (!text) { els.status.textContent = 'Paste some rows first.'; return; }
    const rows = parseDelimited(text);
    const errors = rowsToErrors(rows);
    if (!errors.length) { els.status.textContent = 'Could not find bin + fnsku/asin columns in the pasted text.'; return; }
    const added = mergeErrors(errors);
    updateMeta();
    els.status.textContent = `Pasted ${errors.length} rows · +${added} new · ${currentErrors.length} in checklist.`;
    build();
  });

  const FIELD_ALIASES = {
    time: 'time', timestamp: 'timestamp', warehouse_id: 'warehouseId',
    bin: 'bin', bin_raw: 'binRaw', fnsku: 'fnsku', asin: 'asin', asin_raw: 'asinRaw',
    item_name: 'itemName', quantity: 'quantity', reject_reason: 'rejectReason',
    binding_name: 'binding', user_id: 'aa', user_login: 'aa', user_: 'aa',
    login: 'aa', manager: 'manager', lpn: 'lpn'
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
        aa: rec.aa || '', manager: rec.manager || '', lpn: rec.lpn || '',
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
