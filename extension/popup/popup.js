// popup.js — context-aware entry point + cache control.
(function () {
  'use strict';

  const BASE = 'https://moc.prod.atlas-opensearch.qubit.amazon.dev/_dashboards/app/dashboards?security_tenant=global#/view/';
  const SHORTS_ID = '4c8c3d90-445c-11e9-86f1-a72adc4935ed';
  const REJECTS_ID = 'b784a950-445e-11e9-86f1-a72adc4935ed';
  const ATLAS_HOST = 'moc.prod.atlas-opensearch.qubit.amazon.dev';

  const $ = (id) => document.getElementById(id);
  $('openRejects').href = BASE + REJECTS_ID;
  $('openShorts').href = BASE + SHORTS_ID;

  // Decide which view to show based on the active tab.
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const tab = tabs && tabs[0];
    const onAtlas = tab && tab.url && tab.url.indexOf(ATLAS_HOST) !== -1;
    $('onAtlas').hidden = !onAtlas;
    $('offAtlas').hidden = !!onAtlas;

    if (onAtlas) {
      $('openPanel').addEventListener('click', () => {
        browser.tabs.sendMessage(tab.id, { type: 'qualyOpenPanel' })
          .then(() => window.close())
          .catch(() => {
            $('status').textContent = 'Reload the ATLAS tab, then try again.';
          });
      });
    }
  }).catch(() => {
    // If we can't read the tab, fall back to the instructions view.
    $('offAtlas').hidden = false;
  });

  $('clearCache').addEventListener('click', () => {
    browser.runtime.sendMessage({ type: 'clearCache' })
      .then(() => { $('status').textContent = 'FC Research cache cleared.'; })
      .catch((e) => { $('status').textContent = 'Error: ' + e.message; });
  });
})();
