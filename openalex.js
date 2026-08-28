/* openalex.js -- icon fixes for Research CRM
 * Ported from netherlands-crm. Only the icon-injection and corrupt-text-fix
 * logic — the original also had an "Open Access DB" evidence-column feature
 * for the Subscription Matrix table, keyed by a hardcoded NL-institution
 * OpenAlex/ROR lookup table, but that code path is unreachable dead code
 * even in netherlands-crm (it gates on the page title containing
 * "Subscription", which no longer matches since the page was renamed to
 * "Competitor Matrix" — addColumns() never actually runs), so it wasn't
 * ported: nothing to key it off of, and no real ids to populate it with.
 */
(function () {
  'use strict';

  /* -- CSS ---------------------------------------------------------------- */
  var style = document.createElement('style');
  style.textContent = [
    '.stat-card[onclick*="pipeline"]{display:none!important}',
    '.stat-icon-box svg{width:20px;height:20px;display:block}',
    '.ic-icon svg{display:block}',
  ].join('');
  document.head.appendChild(style);

  /* -- SVG helpers -------------------------------------------------------- */
  function stroke(p) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">' + p + '</svg>';
  }
  function filled(p) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="22" height="22">' + p + '</svg>';
  }

  /* -- Nav icon map ------------------------------------------------------- */
  var NAV = {
    dashboard:     stroke('<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9,22 9,12 15,12 15,22"/>'),
    institutions:  stroke('<path d="M3 21h18M3 10h18M5 10V21M19 10V21M9 10V21M15 10V21M12 3L3 10h12L12 3z"/>'),
    contacts:      stroke('<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>'),
    map:           stroke('<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>'),
    news:          stroke('<path d="M4 22h16a2 2 0 002-2V4a2 2 0 00-2-2H8a2 2 0 00-2 2v16a4 4 0 01-4-4V6a2 2 0 012-2"/><path d="M18 14h-8M15 18h-5"/><rect x="10" y="6" width="8" height="4"/>'),
    subscriptions: stroke('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/>'),
    syncContacts:  stroke('<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
    exportCSV:     stroke('<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  };

  /* -- Stat icon map ------------------------------------------------------ */
  var STAT = {
    purple: filled('<path d="M12 2L2 7v2h20V7L12 2z"/><path d="M4 10v10h6v-7h4v7h6V10"/>'),
    teal:   filled('<path d="M19 3H5v18h14V3zm-2 16H7V5h10v14z"/><path d="M10 8h4v3h-4z"/><path d="M11 2v3h2V2z"/><path d="M12 14v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M10 16h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'),
    blue:   filled('<path d="M9 3L7 17h10L15 3H9z"/><path d="M8 17v3h8v-3"/><path d="M10 21v2h4v-2"/><path d="M10.5 7h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M11 10h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'),
    orange: filled('<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>'),
  };
  /* -- Institution card icon map ----------------------------------------- */
  var INST_ICON = {
    university: stroke('<path d="M3 21h18M3 10h18M5 10V21M19 10V21M9 10V21M15 10V21M12 3L3 10h18L12 3z"/>'),
    medical:    stroke('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
    research:   stroke('<path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v11l3 3 3-3V3M3 9h18"/>'),
    ngo:        stroke('<path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/>'),
    hospital:   stroke('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
    institute:  stroke('<path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v11l3 3 3-3V3M3 9h18"/>'),
  };

  /* -- Fix corrupt UTF-8-as-Latin1 text nodes -------------------------------- */
  /* index.html chars stored as raw UTF-8 bytes misread as Latin-1:            */
  /* â = U+2713 checkmark (E2 9C 93 in UTF-8)              */
  /* â = U+2014 em-dash (E2 80 94 in UTF-8)               */
  /* Â·       = U+00B7 middle-dot (C2 B7 in UTF-8)                */
  function fixCorruptText(root) {
    var reChk = /â/g;
    var reEm  = /â/g;
    var reDot = /Â·/g;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      var t = node.nodeValue;
      if (t.indexOf('â') === -1 && t.indexOf('Â') === -1) continue;
      var fixed = t
        .replace(reChk, '✓')
        .replace(reEm,  '—')
        .replace(reDot, '·');
      if (fixed !== t) node.nodeValue = fixed;
    }
  }

  /* -- Fix nav + stat icons ----------------------------------------------- */
  function fixIcons() {
    document.querySelectorAll('.nav-icon-box').forEach(function (box) {
      if (box.querySelector('svg')) return;
      var parent = box.closest('[onclick]');
      var oc = parent ? parent.getAttribute('onclick') : '';
      var m = oc.match(/\('([^']+)'\)/);
      var key = m ? m[1] : oc.split('(')[0];
      if (NAV[key]) box.innerHTML = NAV[key];
    });
    document.querySelectorAll('.stat-icon-box').forEach(function (box) {
      if (box.querySelector('svg')) return;
      var cls = box.className.split(' ').find(function (c) { return c !== 'stat-icon-box'; }) || '';
      if (STAT[cls]) box.innerHTML = STAT[cls];
    });
    /* institution card icons */
    document.querySelectorAll('.ic-icon').forEach(function (box) {
      if (box.querySelector('svg')) return;
      var type = Array.from(box.classList).find(function (c) { return c !== 'ic-icon'; }) || 'university';
      var svg = INST_ICON[type] || INST_ICON.university;
      box.innerHTML = svg;
    });
  }

  /* -- Observer + init ---------------------------------------------------- */
  var content = document.getElementById('content');
  if (!content) return;

  function tryApply() {
    fixIcons();
    fixCorruptText(content);
  }

  var obs = new MutationObserver(function () {
    setTimeout(tryApply, 80);
  });
  obs.observe(content, { childList: true, subtree: true });
  setTimeout(tryApply, 300);
  var _pi = setInterval(fixIcons, 600); setTimeout(function(){ clearInterval(_pi); }, 12000);
})();
