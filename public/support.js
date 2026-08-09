// support.js - Help (?) and Contact/Support popups.
// The contact details come from the support_* settings (Settings > Support &
// Help) and fall back to the Mizan Suite defaults below when not configured.
//
// To add tutorial videos later, just fill the array below (or set
// window.TUTORIAL_VIDEOS from another file) with { title, url } objects - each
// entry becomes a clickable link in the Help popup.
(function () {
  const DEFAULT_SUPPORT = {
    company: 'Mizan Suite',
    phone: '0559045755',
    email: 'mizansuite@gmail.com',
    version: '1.0.0'
  };

  const VIDEOS = window.TUTORIAL_VIDEOS || [];

  // Company logo shown in the Support/Help popup header (bundled in public/).
  const COMPANY_LOGO = 'mizan-logo.png';

  let info = Object.assign({}, DEFAULT_SUPPORT);

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);

  async function loadSupportInfo() {
    try {
      const res = await fetch('/api/settings');
      const s = await res.json();
      if (s.support_company) info.company = String(s.support_company).trim();
      if (s.support_phone) info.phone = String(s.support_phone).trim();
      if (s.support_email) info.email = String(s.support_email).trim();
    } catch (e) {
      // keep defaults on failure
    }
  }

  function fmtPhone(p) {
    const d = String(p || '').replace(/\D/g, '');
    return d.length === 10 ? d.replace(/(\d{2})(?=\d)/g, '$1 ') : String(p || '');
  }

  function closeModals() {
    document.querySelectorAll('.support-modal, .help-modal').forEach(m => m.remove());
  }

  function modalShell(kind, title, body) {
    const wrap = document.createElement('div');
    wrap.className = kind;
    wrap.innerHTML = `
      <div class="${kind === 'support-modal' ? 'support-box' : 'help-box'}">
        <button type="button" class="btn btn-ico btn-outline" data-close aria-label="${esc(I18N.t('support.close'))}" style="position:absolute; top:0.6rem; right:0.6rem;">&times;</button>
        <div class="help-head">
          <div class="help-logo"><img src="${esc(COMPANY_LOGO)}" alt="${esc(info.company)}" onerror="this.remove(); this.parentNode.append('${esc(info.company)}');"></div>
          <div class="help-title">${esc(title)}</div>
        </div>
        <div class="help-body">${body}</div>
      </div>`;
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.closest('[data-close]')) closeModals();
    });
    document.body.appendChild(wrap);
    return wrap;
  }

  function akOpenSupport() {
    loadSupportInfo().then(() => {
      const subject = encodeURIComponent(I18N.t('support.mailSubject'));
      const mailto = `mailto:${info.email}?subject=${subject}`;
      const body = `
        <p class="help-intro">${I18N.t('support.intro')}</p>
        <div class="support-row"><span>${I18N.t('support.company')}</span><strong>${esc(info.company)}</strong></div>
        <div class="support-row"><span>${I18N.t('support.phone')}</span><a href="tel:${esc(info.phone)}">${esc(fmtPhone(info.phone))}</a></div>
        <div class="support-row"><span>${I18N.t('support.email')}</span><a href="${mailto}">${esc(info.email)}</a></div>
        <div class="support-row"><span>${I18N.t('support.version')}</span><span>${esc(info.version)}</span></div>
        <div class="help-actions">
          <a class="btn" href="${mailto}">${I18N.t('support.emailUs')}</a>
          <button type="button" class="btn btn-close" data-close>${I18N.t('support.close')}</button>
        </div>
        <p class="hint-text" style="margin-top:0.9rem;">${I18N.t('support.note')}</p>
      `;
      modalShell('support-modal', I18N.t('support.title'), body);
    });
  }

  function akOpenHelp() {
    const videosHtml = VIDEOS.length
      ? VIDEOS.map(v => `<a class="help-video-link" href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.title)}</a>`).join('')
      : `<p class="hint-text">${I18N.t('help.videosNote')}</p>`;
    const body = `
      <div class="help-guide">${I18N.t('help.guide')}</div>
      <div class="help-videos">
        <div class="help-videos-title">${I18N.t('help.videosTitle')}</div>
        ${videosHtml}
      </div>
      <div class="help-actions">
        <button type="button" class="btn" data-open-support>${I18N.t('help.contactSupport')}</button>
        <button type="button" class="btn btn-close" data-close>${I18N.t('support.close')}</button>
      </div>
    `;
    const wrap = modalShell('help-modal', I18N.t('help.title'), body);
    wrap.querySelector('[data-open-support]').addEventListener('click', () => { closeModals(); akOpenSupport(); });
  }

  window.akOpenSupport = akOpenSupport;
  window.akOpenHelp = akOpenHelp;
})();
