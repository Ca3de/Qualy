// popup.js — quick links + cache control.
(function () {
  'use strict';

  const BASE = 'https://moc.prod.atlas-opensearch.qubit.amazon.dev/_dashboards/app/dashboards?security_tenant=global#/view/';
  // Dashboard object IDs (from the shared ATLAS links).
  const SHORTS_ID = '4c8c3d90-445c-11e9-86f1-a72adc4935ed';
  const REJECTS_ID = 'b784a950-445e-11e9-86f1-a72adc4935ed';

  document.getElementById('openRejects').href = BASE + REJECTS_ID;
  document.getElementById('openShorts').href = BASE + SHORTS_ID;

  document.getElementById('clearCache').addEventListener('click', async () => {
    const status = document.getElementById('status');
    try {
      await browser.runtime.sendMessage({ type: 'clearCache' });
      status.textContent = 'FC Research cache cleared.';
    } catch (e) {
      status.textContent = 'Error: ' + e.message;
    }
  });
})();
