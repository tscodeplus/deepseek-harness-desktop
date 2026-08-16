// theme-watch.js — mirrors the dsh WebUI's rendered theme into
// desktop-config.json so the shell chrome, the About dialog and the updater
// dialogs all follow the same appearance as the WebUI.
//
// dsh marks dark mode with `data-ds-dark-theme` on <body> (absent in light
// mode); the attribute updates live when the user switches the theme in the
// WebUI or the OS appearance changes under "system" theme. This script
// watches that attribute and PUTs the resolved "dark" / "light" value to the
// sidecar's /_desktop/config endpoint (the sidecar persists the file; the
// Rust shell polls mtime and re-themes windows; the updater dialogs read the
// same config). Injected as a Tauri initialization_script — upstream dsh
// source untouched. No-ops in a plain browser (no __DSHD_THEME_WATCH__).
(function () {
  'use strict';
  var cfg = window.__DSHD_THEME_WATCH__;
  if (!cfg || !cfg.sidecarPort) return;

  var api = 'http://127.0.0.1:' + cfg.sidecarPort +
    '/_desktop/config?token=' + encodeURIComponent(cfg.token || '');
  var lastSent = null;
  var timer = null;

  function report() {
    var dark = document.body &&
      document.body.hasAttribute('data-ds-dark-theme');
    var value = dark ? 'dark' : 'light';
    if (value === lastSent) return;
    lastSent = value;
    try {
      fetch(api, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'theme', value: value })
      }).catch(function () {});
    } catch (e) { /* best effort */ }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(report, 300);
  }

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  ready(function () {
    report();
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(schedule).observe(document.body, {
        attributes: true,
        attributeFilter: ['data-ds-dark-theme']
      });
    } else {
      // Fallback poll (all bundled WebViews support MutationObserver, but
      // keep a degraded path rather than going silent).
      setInterval(schedule, 2000);
    }
  });
})();
