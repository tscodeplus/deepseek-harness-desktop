// Injected titlebar overlay for the frameless dsh shell (Windows/Linux).
//
// The dsh WebUI is a plain browser app with no self-drawn title bar, so the
// shell replicates the Electron titleBarOverlay pattern used by
// anywhere-labs/deepseek-harness-desktop (frame hidden + native buttons
// floating over the content, WebUI reserving a 44px inset):
//   · an invisible 44px strip at the top of the window acts as the drag
//     region (data-tauri-drag-region) and pushes the app frame down by the
//     inset, exactly like that project's --dsh-desktop-titlebar-inset
//     (32px here — the native Windows caption height — so the page is not
//     pushed down more than a normal title bar would);
//   · minimize/maximize/close buttons float at the top-right, styled like
//     the native overlay symbols (neutral color, subtle hover, red close);
//   · while a modal is mounted ([aria-modal]), the strip stops intercepting
//     pointer events so the modal's own top controls stay reachable — the
//     same fix that project applies via :has([aria-modal]).
// The strip has no background of its own: the page background shows through
// (html background is pinned to the dsh theme token below), so there is no
// visible toolbar. macOS keeps the native traffic lights
// (TitleBarStyle::Overlay) and never receives this script (see windows.rs).
//
// Runs as a Tauri initialization_script: once per document, before page
// scripts. No-ops in a plain browser (no __TAURI_INTERNALS__).
(function () {
  'use strict';
  if (!window.__TAURI_INTERNALS__ || !window.__TAURI_INTERNALS__.invoke) return;

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  ready(function () {
    var CAPTION_H = 32;
    var zh = (navigator.language || '').toLowerCase().indexOf('zh') === 0;
    var T = zh
      ? { min: '最小化', max: '最大化', restore: '还原', close: '关闭' }
      : { min: 'Minimize', max: 'Maximize', restore: 'Restore', close: 'Close' };

    // Styles are id-scoped; init scripts run once per document, so no
    // cleanup is needed across navigations.
    var style = document.createElement('style');
    style.id = 'dshd-caption-style';
    style.textContent = [
      '#dshd-caption{position:fixed;top:0;left:0;right:0;height:' + CAPTION_H + 'px;' +
        'z-index:2147483647;display:flex;align-items:center;' +
        'user-select:none;-webkit-user-select:none;' +
        'color:var(--dsw-alias-label-tertiary,#7f858f)}',
      '#dshd-caption-buttons{height:100%;display:flex;align-items:stretch;margin-left:auto}',
      '#dshd-caption button{width:46px;height:100%;border:0;padding:0;margin:0;' +
        'background:transparent;display:flex;align-items:center;justify-content:center;' +
        'color:inherit;cursor:default}',
      '#dshd-caption button:hover{background:rgba(128,128,128,.18)}',
      '#dshd-caption button.dshd-close:hover{background:#e81123;color:#fff}',
      'html.dshd-modal-open #dshd-caption{pointer-events:none}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);

    // Push the app frame below the strip. dsh's base.css pins
    // html/body/#root heights to 100%; inline styles win over stylesheets.
    document.body.style.marginTop = CAPTION_H + 'px';
    document.body.style.height = 'calc(100% - ' + CAPTION_H + 'px)';
    document.body.style.minHeight = 'calc(100% - ' + CAPTION_H + 'px)';

    function icon(inner) {
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
        'stroke-linejoin="round">' + inner + '</svg>';
    }
    var ICON_MIN = icon('<path d="M5 12h14"/>');
    var ICON_MAX = icon('<rect x="5" y="5" width="14" height="14" rx="1"/>');
    var ICON_RESTORE = icon('<rect x="9" y="9" width="11" height="11" rx="1"/>' +
      '<path d="M5 15V5a2 2 0 0 1 2-2h10"/>');
    var ICON_CLOSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
      'stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

    var caption = document.createElement('div');
    caption.id = 'dshd-caption';
    caption.setAttribute('data-tauri-drag-region', 'deep');
    // The strip takes the theme background itself. The --dsw-* tokens are
    // defined on <body> (light) and <body data-ds-dark-theme> (dark), and
    // CSS custom properties only inherit DOWNWARD — an html-level lookup
    // can never see them. The caption is a body child, so var() resolves
    // from body's scope and follows light/dark correctly.
    caption.style.background = 'var(--dsw-alias-bg-base,#f9fafb)';

    var buttons = document.createElement('div');
    buttons.id = 'dshd-caption-buttons';
    buttons.setAttribute('data-tauri-drag-region', 'false');

    function mkButton(title, html, cls, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.setAttribute('data-tauri-drag-region', 'false');
      if (cls) b.className = cls;
      b.innerHTML = html;
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        onClick();
      });
      return b;
    }

    // NOTE: core window commands must be invoked as `plugin:window|<cmd>` —
    // tauri's ACL allowed-commands map keys core-plugin permissions in that
    // form (tauri-utils acl/build.rs), and the raw invoke string is matched
    // against it; the `core:window:<cmd>` form is denied ("not allowed by
    // ACL"). Tauri's own drag-region script uses the same `plugin:window|`
    // form.
    var invoke = function (cmd) {
      return window.__TAURI_INTERNALS__.invoke('plugin:window|' + cmd);
    };
    buttons.appendChild(mkButton(T.min, ICON_MIN, '', function () {
      invoke('minimize');
    }));
    var maxBtn = mkButton(T.max, ICON_MAX, '', function () {
      invoke('toggle_maximize');
    });
    buttons.appendChild(maxBtn);
    buttons.appendChild(mkButton(T.close, ICON_CLOSE, 'dshd-close', function () {
      invoke('close');
    }));

    // The maximize button doubles as restore: re-query the window state on
    // resize (fires when the OS window is maximized/restored).
    function refreshMax() {
      try {
        invoke('is_maximized').then(function (v) {
          maxBtn.innerHTML = v ? ICON_RESTORE : ICON_MAX;
          maxBtn.title = v ? T.restore : T.max;
          maxBtn.setAttribute('aria-label', maxBtn.title);
        }).catch(function () {});
      } catch (e) { /* not in a webview context */ }
    }
    window.addEventListener('resize', refreshMax);
    refreshMax();

    // Double-click on the strip (not the buttons) toggles maximize, like
    // the native title bar.
    caption.addEventListener('dblclick', function (e) {
      if (e.target.closest && e.target.closest('#dshd-caption-buttons')) return;
      invoke('toggle_maximize');
    });

    caption.appendChild(buttons);
    (document.body || document.documentElement).appendChild(caption);

    // While a modal is mounted, stop intercepting pointer events at the top
    // of the page (same fix as anywhere-labs' :has([aria-modal]) rule) so
    // the modal's own header controls remain clickable. Buttons stay
    // visible and clickable (they are children with pointer-events:auto).
    function syncModal() {
      var open = document.querySelector('[aria-modal="true"]') !== null;
      document.documentElement.classList.toggle('dshd-modal-open', open);
    }
    syncModal();
    var modalObserver = new MutationObserver(function () {
      requestAnimationFrame(syncModal);
    });
    modalObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-modal']
    });
  });
})();
