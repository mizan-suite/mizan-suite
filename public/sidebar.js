// sidebar.js - single source of truth for the app's navigation. Included on every
// page (which has a <div id="app-sidebar"></div>). Keeps all links in one place
// so adding a page means editing this file, not a dozen HTML headers.
// Renders after auth.js resolves so it can hide links the current user has not
// been granted access to (the owner always sees everything).
(function () {
  const groups = [
    {
      label: 'nav.store',
      items: [
        { href: 'dashboard.html', label: 'nav.dashboard', perm: 'dashboard' },
        { href: 'cashier.html', label: 'nav.cashier', perm: 'cashier' },
        { href: 'index.html', label: 'nav.inventory', perm: 'inventory' },
        { href: 'labels.html', label: 'nav.labels', perm: 'labels' },
        { href: 'stock.html', label: 'nav.stock', perm: 'stock' },
        { href: 'expiry.html', label: 'nav.expiry', perm: 'expiry', tier: 'pro' }
      ]
    },
    {
      label: 'nav.billing',
      items: [
        { href: 'facturation.html', label: 'nav.facturation', perm: 'facturation', tier: 'pro' }
      ]
    },
    {
      label: 'nav.supply',
      items: [
        { href: 'purchasing.html', label: 'nav.purchasing', perm: 'purchasing', tier: 'pro' },
        { href: 'reorder.html', label: 'nav.reorder', perm: 'reorder', tier: 'pro' },
        { href: 'debts.html', label: 'nav.debts', perm: 'debts', tier: 'pro' },
        { href: 'clients.html', label: 'nav.clients', perm: 'clients', tier: 'pro' },
        { href: 'refunds.html', label: 'nav.refunds', perm: 'refunds' }
      ]
    },
    {
      label: 'nav.reports',
      items: [
        { href: 'financial.html', label: 'nav.financial', perm: 'financial', tier: 'pro' },
        { href: 'reports.html', label: 'nav.reports_page', perm: 'reports', tier: 'pro' },
        { href: 'analytics.html', label: 'nav.analytics', perm: 'analytics', tier: 'pro' }
      ]
    },
    {
      label: 'nav.administration',
      items: [
        { href: 'staff.html', label: 'nav.staff', perm: 'staff', tier: 'pro' },
        { href: 'pointage.html', label: 'nav.pointage', perm: 'pointage', tier: 'pro' },
        { href: 'payroll.html', label: 'nav.payroll', perm: 'payroll', tier: 'pro' }
      ]
    },
    {
      label: 'nav.system',
      items: [
        { href: 'settings.html', label: 'nav.settings', perm: 'settings' },
        { href: 'connect.html', label: 'nav.mobile', perm: 'mobile' }
      ]
    }
  ];

  const current = (window.location.pathname.split('/').pop() || 'index.html');

  const esc = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);

  function brandLogoHtml() {
    const name = (window.akBranding && window.akBranding.name) ? window.akBranding.name : 'Mizan Suite';
    const words = name.trim().split(/\s+/).filter(Boolean);
    return words.length > 1
      ? `<div class="sidebar-logo">${esc(words.slice(0, -1).join(' '))} <span>${esc(words[words.length - 1])}</span></div>`
      : `<div class="sidebar-logo">${esc(words[0] || 'Mizan Suite')}</div>`;
  }

  function tierVisible() {
    return window.AK_TIER_LOADED && window.AK_TIER === 'basic';
  }

  function render() {
    let visible = window.AK_ROLE === 'owner'
      ? groups
      : groups.map(g => ({ label: g.label, items: g.items.filter(i => window.hasPerm(i.perm)) })).filter(g => g.items.length);

    if (tierVisible()) {
      visible = visible.map(g => ({ label: g.label, items: g.items.filter(i => i.tier !== 'pro') })).filter(g => g.items.length);
    }

    let html = brandLogoHtml();
    html += '<nav class="sidebar-nav">';
    for (const group of visible) {
      if (!group.items.length) continue;
      html += `<div class="sidebar-group">${I18N.t(group.label)}</div>`;
      for (const item of group.items) {
        const active = current === item.href ? ' class="active"' : '';
        html += `<a href="${item.href}"${active}>${I18N.t(item.label)}</a>`;
      }
    }
    html += '</nav>';
    html += '<div class="sidebar-footer">';
    html += '<div class="sidebar-user" id="sidebar-user"></div>';
    html += `<button id="logout-btn" class="sidebar-logout" type="button">${I18N.t('nav.logout')}</button>`;
    html += '</div>';

    document.getElementById('app-sidebar').innerHTML = html;
    document.body.classList.add('has-sidebar');

    // Force the nav logo to the current shop name (in case branding.js resolved
    // before the sidebar existed, or the user changed the shop name elsewhere).
    if (window.akApplyBrand) window.akApplyBrand();

    if (window.AK_NAME) {
      const userEl = document.getElementById('sidebar-user');
      if (userEl) userEl.textContent = `${window.AK_NAME} \u00B7 ${window.AK_ROLE === 'owner' ? I18N.t('role.owner') : I18N.t('role.cashier')}`;
    }

    // Floating "Print" button removed (user didn't want it).

    document.getElementById('logout-btn').addEventListener('click', async () => {
      try { localStorage.removeItem('mizan_session'); } catch (e) {}
      await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      window.location.href = 'login.html';
    });
  }

  window.renderSidebar = render;

  (window.AK_AUTH || Promise.resolve({ accounts_exist: false, role: 'owner' })).then(() => render());
  // Re-render once the license edition is known so PRO links drop out for Basic.
  if (window.AK_LICENSE) window.AK_LICENSE.then(() => render());
})();
