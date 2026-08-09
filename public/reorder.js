// reorder.js
const escapeHtml = (str) => String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

async function loadSuggestions() {
  const res = await fetch('/api/ai/reorder-suggestions');
  const suggestions = await res.json();
  const listEl = document.getElementById('suggestion-list');

  listEl.innerHTML = suggestions.length ? suggestions.map(s => `
    <tr>
      <td>${escapeHtml(s.name)}</td>
      <td>${s.quantity}</td>
      <td>${s.soldLast30Days}</td>
      <td>${s.daysOfStockLeft !== null ? s.daysOfStockLeft + ' ' + I18N.t('reorder.days') : I18N.t('reorder.noRecentSales')}</td>
      <td>${s.suggestedReorderQty > 0
        ? `<strong>${s.suggestedReorderQty} ${I18N.t('reorder.units')}</strong>`
        : '-'}</td>
    </tr>
  `).join('') : `<tr><td colspan="5" class="empty-cart-msg">${I18N.t('reorder.noUrgent')}</td></tr>`;
}

window.addEventListener('languagechange', loadSuggestions);

loadSuggestions();
