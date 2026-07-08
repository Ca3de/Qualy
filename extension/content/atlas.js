// atlas.js
// Runs on the ATLAS OpenSearch Dashboards pages (Pick Rejects / Unverified
// Shorts). Adds a floating panel that scrapes the visible error table, then
// hands the rows to the extension's Pick Path page.
//
// Primary extraction = DOM scrape of the saved-search table, mapping columns by
// their header name (robust to column reordering). If scraping finds nothing,
// the Pick Path page offers a CSV/TSV paste fallback (matches the existing
// TamperMonkey CSV export).

(function () {
  'use strict';

  const DEBUG = true;
  function log(...a) { if (DEBUG) console.log('[Qualy-Atlas]', ...a); }

  // Field names we care about, normalised (lowercase, spaces->underscore).
  // Prefer the *_raw variants because the visible cells wrap/truncate.
  const FIELD_ALIASES = {
    time: 'time',
    timestamp: 'timestamp',
    warehouse_id: 'warehouseId',
    bin: 'bin',
    bin_raw: 'binRaw',
    fnsku: 'fnsku',
    asin: 'asin',
    asin_raw: 'asinRaw',
    item_name: 'itemName',
    quantity: 'quantity',
    reject_reason: 'rejectReason',
    binding_name: 'binding',
    user_id: 'aa',
    user_login: 'aa',
    user_: 'aa',
    login: 'aa',
    lpn: 'lpn'
  };

  function normHeader(text) {
    return String(text || '').trim().toLowerCase().replace(/\s+/g, '_');
  }

  function detectWarehouseId() {
    const hash = decodeURIComponent(location.hash || '');
    const m = hash.match(/warehouse_id[:%]*\s*([A-Z0-9]{3,5})/i) ||
              hash.match(/warehouseId[=:]\s*([A-Z0-9]{3,5})/i);
    if (m) return m[1].toUpperCase();
    // Fall back to a warehouse_id cell if present later; default IND8.
    return 'IND8';
  }

  // ---- Scrape ---------------------------------------------------------------

  // Scrape every table that looks like an error table and merge the rows.
  function scrapeErrors() {
    const tables = Array.from(document.querySelectorAll('table'));
    const errors = [];
    let scannedTables = 0;

    for (const table of tables) {
      const headerCells = Array.from(
        table.querySelectorAll('thead th, thead td')
      );
      let cells = headerCells;
      if (!cells.length) {
        // Some DocTables put headers in the first tbody row.
        const firstRow = table.querySelector('tr');
        if (firstRow) cells = Array.from(firstRow.querySelectorAll('th, td'));
      }
      if (!cells.length) continue;

      // Map column index -> our field key.
      const colMap = {};
      cells.forEach((c, i) => {
        const key = FIELD_ALIASES[normHeader(c.textContent)];
        if (key) colMap[i] = key;
      });

      const keys = Object.values(colMap);
      const looksLikeErrors = keys.includes('bin') || keys.includes('binRaw');
      const hasItemId = keys.includes('fnsku') || keys.includes('asin') || keys.includes('asinRaw');
      if (!looksLikeErrors || !hasItemId) continue;

      scannedTables++;
      const colCount = cells.length;
      const bodyRows = Array.from(table.querySelectorAll('tbody tr'));

      for (const tr of bodyRows) {
        const tds = Array.from(tr.querySelectorAll('td'));
        // Skip expanded detail rows (single wide cell) & header echoes.
        if (tds.length < Math.max(2, Math.floor(colCount / 2))) continue;
        if (tds.some(td => td.hasAttribute('colspan') && parseInt(td.getAttribute('colspan'), 10) > 2)) continue;

        const rec = {};
        tds.forEach((td, i) => {
          const key = colMap[i];
          if (!key) return;
          rec[key] = cellText(td);
        });

        const bin = rec.binRaw || rec.bin;
        const fnsku = rec.fnsku;
        const asin = rec.asinRaw || rec.asin;
        if (!bin || (!fnsku && !asin)) continue;

        errors.push({
          bin: bin,
          fnsku: fnsku || '',
          asin: asin || '',
          itemName: rec.itemName || '',
          quantity: rec.quantity || '',
          rejectReason: rec.rejectReason || '',
          binding: rec.binding || '',
          aa: rec.aa || '',
          lpn: rec.lpn || '',
          time: rec.time || rec.timestamp || '',
          source: rec.rejectReason ? 'reject' : 'short'
        });
      }
    }

    // De-dupe on bin+fnsku+time.
    const seen = new Set();
    const unique = [];
    for (const e of errors) {
      const k = `${e.bin}|${e.fnsku || e.asin}|${e.time}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(e);
    }

    log(`scraped ${unique.length} unique errors from ${scannedTables} table(s)`);
    return unique;
  }

  function cellText(td) {
    // innerText collapses layout but keeps wrapped fragments joined by \n.
    return (td.innerText || td.textContent || '')
      .replace(/\s*\n\s*/g, '')   // rejoin wrapped values like "P-1-A243D5\n21"
      .trim();
  }

  // ---- Panel ----------------------------------------------------------------

  function buildPanel() {
    if (document.getElementById('qualy-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'qualy-panel';
    panel.innerHTML = `
      <div class="qualy-hd">
        <span>🧭 Qualy Pick Path</span>
        <button id="qualy-min" title="Minimise">–</button>
      </div>
      <div class="qualy-bd">
        <label class="qualy-lbl">Start bin / aisle</label>
        <input id="qualy-start" type="text" placeholder="e.g. P-1-A200C300" autocomplete="off" />
        <div class="qualy-inline">
          <label class="qualy-lbl2">Errors
            <select id="qualy-types">
              <option value="both">Shorts + Rejects</option>
              <option value="short">Shorts</option>
              <option value="reject">Rejects</option>
            </select>
          </label>
          <label class="qualy-lbl2">Time
            <select id="qualy-timemode">
              <option value="hours">Last X hrs</option>
              <option value="night">Night shift</option>
              <option value="day">Day shift</option>
              <option value="custom">Custom…</option>
            </select>
          </label>
        </div>
        <label class="qualy-lbl2" id="qualy-hourswrap">Lookback hrs
          <input id="qualy-hours" type="number" min="1" max="336" value="12" />
        </label>
        <label class="qualy-chk"><input id="qualy-enrich" type="checkbox" checked /> Pull FC Research images</label>
        <button id="qualy-go" class="qualy-btn">Pull from ATLAS &amp; build path</button>
        <a id="qualy-scrape" class="qualy-alt" href="#">or scrape this page instead</a>
        <div id="qualy-status" class="qualy-status">Ready.</div>
      </div>`;
    document.body.appendChild(panel);

    const status = panel.querySelector('#qualy-status');
    panel.querySelector('#qualy-min').addEventListener('click', () => {
      panel.classList.toggle('qualy-collapsed');
    });

    async function openPath(payload) {
      try {
        await browser.storage.local.set({ qualyPayload: { ...payload, ts: Date.now() } });
        window.open(browser.runtime.getURL('page/path.html'), '_blank');
      } catch (err) {
        status.textContent = 'Error: ' + err.message;
      }
    }

    // Show the hours input only in "last X hours" mode.
    const timeSel = panel.querySelector('#qualy-timemode');
    const hoursWrap = panel.querySelector('#qualy-hourswrap');
    timeSel.addEventListener('change', () => {
      hoursWrap.style.display = timeSel.value === 'hours' ? '' : 'none';
    });

    // Primary: direct ATLAS API pull (done on the path page).
    panel.querySelector('#qualy-go').addEventListener('click', () => {
      status.textContent = 'Opening path (ATLAS pull)…';
      openPath({
        mode: 'api',
        startBin: panel.querySelector('#qualy-start').value.trim(),
        warehouseId: detectWarehouseId(),
        types: panel.querySelector('#qualy-types').value,
        timeMode: timeSel.value,
        hoursBack: parseInt(panel.querySelector('#qualy-hours').value, 10) || 12,
        enrich: panel.querySelector('#qualy-enrich').checked
      });
    });

    // Secondary: scrape the currently-rendered dashboard table.
    panel.querySelector('#qualy-scrape').addEventListener('click', (e) => {
      e.preventDefault();
      status.textContent = 'Scraping this page…';
      const errors = scrapeErrors();
      status.textContent = errors.length
        ? `Scraped ${errors.length} errors. Opening path…`
        : 'No rows scraped — opening path (use paste fallback).';
      openPath({
        mode: 'rows',
        errors,
        startBin: panel.querySelector('#qualy-start').value.trim(),
        warehouseId: detectWarehouseId(),
        enrich: panel.querySelector('#qualy-enrich').checked
      });
    });

    // Restore last-used start bin.
    browser.storage.local.get('qualyLastStart').then(r => {
      if (r && r.qualyLastStart) panel.querySelector('#qualy-start').value = r.qualyLastStart;
    });
    panel.querySelector('#qualy-start').addEventListener('change', (e) => {
      browser.storage.local.set({ qualyLastStart: e.target.value.trim() });
    });
  }

  function init() {
    if (document.body) buildPanel();
    else document.addEventListener('DOMContentLoaded', buildPanel);
  }

  init();
  log('content script ready on', location.href);
})();
