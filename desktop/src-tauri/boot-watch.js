// boot-watch.js — injected into the main WebUI window (windows.rs
// create_main_window), runs once per document before page scripts. Upstream
// dsh source untouched.
//
// Single-splash gate: the main window is created HIDDEN while the WebUI's
// own boot chain renders its loading page ("HARNESS" wordmark + spinner +
// "Loading plugins…"). This script watches #root for the boot page to
// settle (loading hint disappears → real UI) or fail loudly ("Failed to
// load plugins" report stays up), then POSTs /_desktop/boot-settled to the
// shell's control service so the shell swaps the splash for the real UI.
// The user therefore never sees the WebUI's duplicate boot page — only the
// shell splash (pages/splash.html), which is pixel-matched to it.
//
// Detection is TEXT-based on purpose: the boot page's classes are
// CSS-module-hashed per build (`.boot` → `._boot_9gj4p_6`, …), so class
// selectors would silently break on the next dsh ref. The strings below are
// stable upstream UI copy.
//
// No-ops in a plain browser (no __DSHD_BOOT_WATCH__ config). Fail-safes:
// a local timeout reveals the window if the page is alive but never settles
// (or never shows the loading page at all); the shell also has a 60s
// watchdog (windows.rs arm_boot_watchdog). A page whose #root NEVER gains
// content (dead/error page) is deliberately NOT reported — the shell's own
// crash/startup-timeout flows own that case.
(function () {
  'use strict';
  var cfg = window.__DSHD_BOOT_WATCH__;
  if (!cfg || !cfg.ctlPort) return;

  var ctlUrl = 'http://127.0.0.1:' + cfg.ctlPort +
    '/_desktop/boot-settled?token=' + encodeURIComponent(cfg.token || '');
  var notified = false;

  function notify() {
    if (notified) return;
    notified = true;
    try {
      // no-cors: delivered without preflight, response is opaque — we only
      // need the request to reach the shell.
      fetch(ctlUrl, { method: 'POST', mode: 'no-cors' }).catch(function () {});
    } catch (e) { /* best-effort; the shell watchdog covers a lost signal */ }
  }

  // Boot page state from #root text:
  //   -1 → not mounted yet (no content)
  //    0 → loading page visible
  //    1 → settled (real UI) or failed loudly — either way the splash's job
  //        is done (a failed boot keeps the page up so the user can read the
  //        report; the success case unmounts the boot page entirely).
  function state() {
    var root = document.getElementById('root');
    if (!root || root.childElementCount === 0) return -1;
    var text = root.innerText || '';
    if (text.indexOf('Failed to load plugins') !== -1) return 1;
    if (text.indexOf('Loading plugins') !== -1) return 0;
    return 1;
  }

  function start() {
    var root = document.getElementById('root');
    if (!root) return;
    var last = state();
    if (last === 1) { notify(); return; } // settled before we attached

    var deadline = Date.now() + 20000; // 20s local fail-safe
    var timer = setInterval(function () {
      var s = state();
      if (s !== -1) last = s;
      if (last === 1) {
        clearInterval(timer);
        notify();
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        // Page alive but never settled (stuck boot, future dsh changes) →
        // show whatever is there; #root never appeared → stay silent and
        // let the shell's error flows / 60s watchdog decide.
        if (s !== -1) notify();
      }
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
