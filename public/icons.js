// icons.js - tiny inline-SVG icon set (no external fonts/CDN, works offline).
// Use in JS templates: AKIcons.icon('camera')
// Use in static HTML: <span data-icon="camera"></span>Label   (auto-filled on load)
(function () {
  const PATHS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
    cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/><path d="M3 4h2l2.4 12h9.4L21 7H7"/>',
    package: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M3 21h18"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    truck: '<path d="M1 7h13v9H1zM14 10h4l4 4v2h-3"/><circle cx="5.5" cy="19" r="1.6"/><circle cx="18.5" cy="19" r="1.6"/>',
    refresh: '<path d="M20 12a8 8 0 11-2.3-5.6M20 4v4h-4"/>',
    coins: '<ellipse cx="9" cy="9" rx="5" ry="3.5"/><path d="M4 9v6c0 1.9 2.2 3.5 5 3.5s5-1.6 5-3.5V9"/><path d="M14 5c2.8 0 5 1.6 5 3.5 0 1.3-1 2.5-2.5 3M14 9.5c2.8 0 5-1 5-2.5"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M15 5.5a3.5 3.5 0 010 6.9M17.5 14.6c2 .8 3.5 2.5 3.5 5.4"/>',
    rotate: '<path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.8L3 8"/><path d="M3 3v5h5"/>',
    filetext: '<path d="M14 3H6a1 1 0 00-1 1v16a1 1 0 001 1h12a1 1 0 001-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    chartline: '<path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/>',
    wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18"/><circle cx="16" cy="15" r="1.4"/>',
    pie: '<circle cx="12" cy="12" r="8"/><path d="M12 12V4a8 8 0 016.9 4.1z"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    camera: '<path d="M3 8h3l2-3h8l2 3h3v12H3z"/><circle cx="12" cy="13" r="4"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    scan: '<path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3M12 10v4M10 12h4"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 13l4 4L19 7"/>',
    chevrondown: '<path d="M6 9l6 6 6-6"/>',
    chevronup: '<path d="M6 15l6-6 6 6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.4-4.4"/>',
    arrowright: '<path d="M4 12h16M14 6l6 6-6 6"/>',
    sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
    banknote: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
    alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17h.01"/>',
    bell: '<path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2 2 0 004 0"/>',
    globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13 0 16M12 4c-2.5 2.5-2.5 13 0 16"/>',
    wifi: '<path d="M2 9a14 14 0 0120 0M6 13a9 9 0 0112 0M10 17a4 4 0 014 0"/>',
    gift: '<rect x="3" y="8" width="18" height="4"/><path d="M5 12v9h14v-9M12 8v13M12 8c-1.5 0-4-1-4-3 0-1.5 1.5-2.5 3-2S12 8 12 8zm0 0c1.5 0 4-1 4-3 0-1.5-1.5-2.5-3-2s-1 5-1 5z"/>',
    dots: '<circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/>',
    pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
    archive: '<path d="M4 7h16v13H4zM4 7l1-4h14l1 4M9 12h6"/>',
    tag: '<path d="M3 11V4h7l10 10-7 7z"/><circle cx="8" cy="8" r="1.5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/>',
    edit: '<path d="M17 3l4 4L8 20l-5 1 1-5z"/><path d="M14.5 5.5l4 4"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'
  };

  function icon(name, size) {
    const path = PATHS[name];
    if (!path) return '';
    const s = size || 18;
    return '<svg class="icon" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }

  window.AKIcons = { icon, paths: PATHS };

  // Auto-fill <span data-icon="name"> placeholders already present in the HTML.
  function fill() {
    document.querySelectorAll('[data-icon]').forEach(el => {
      if (!el.querySelector('svg')) el.innerHTML = icon(el.dataset.icon, parseInt(el.dataset.size, 10) || 18);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fill);
  } else {
    fill();
  }
})();
