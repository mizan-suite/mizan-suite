// reports.js
// Fetches report data for viewing, and triggers file downloads for CSV/Excel/PDF export.

const typeSelect = document.getElementById('report-type');
const fromInput = document.getElementById('report-from');
const toInput = document.getElementById('report-to');
const outputEl = document.getElementById('report-output');

let reportData = null;
let reportPage = 1;
const REPORT_PER_PAGE = 50;

function currentParams() {
  const params = new URLSearchParams({ type: typeSelect.value });
  if (fromInput.value) params.set('from', fromInput.value);
  if (toInput.value) params.set('to', toInput.value);
  return params;
}

function renderReport() {
  const data = reportData;
  if (!data) return;
  const pages = Math.max(1, Math.ceil(data.rows.length / REPORT_PER_PAGE));
  if (reportPage > pages) reportPage = pages;
  const start = (reportPage - 1) * REPORT_PER_PAGE;
  const pageRows = data.rows.slice(start, start + REPORT_PER_PAGE);

  outputEl.innerHTML = `
    <h2>${data.title}</h2>
    <table class="product-table">
      <thead><tr>${data.columns.map(c => `<th>${c}</th>`).join('')}</tr></thead>
      <tbody>
        ${pageRows.length
          ? pageRows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')
          : `<tr><td colspan="${data.columns.length}">${I18N.t('reports.noData')}</td></tr>`
        }
      </tbody>
    </table>
  `;

  renderReportPagination(data.rows.length, pages);
}

function renderReportPagination(total, pages) {
  const bar = document.getElementById('report-pagination');
  if (total <= REPORT_PER_PAGE) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const from = total ? (reportPage - 1) * REPORT_PER_PAGE + 1 : 0;
  const to = Math.min(reportPage * REPORT_PER_PAGE, total);
  document.getElementById('report-page-info').textContent =
    I18N.t('reports.pageInfo').replace('{from}', from).replace('{to}', to).replace('{total}', total);
  document.getElementById('report-page-num').textContent =
    I18N.t('reports.pageNum').replace('{page}', reportPage).replace('{pages}', pages);
  document.getElementById('report-page-prev').disabled = reportPage <= 1;
  document.getElementById('report-page-next').disabled = reportPage >= pages;
}

document.getElementById('report-page-prev').addEventListener('click', () => {
  if (reportPage <= 1) return;
  reportPage--;
  renderReport();
});

document.getElementById('report-page-next').addEventListener('click', () => {
  reportPage++;
  renderReport();
});

document.getElementById('generate-btn').addEventListener('click', async () => {
  const res = await fetch(`/api/reports/data?${currentParams()}`);
  const data = await res.json();

  if (!res.ok) {
    outputEl.innerHTML = `<p class="error-msg">${data.error}</p>`;
    return;
  }

  reportData = data;
  reportPage = 1;
  renderReport();
});

// Exports just navigate to the export URL - the browser handles the file download
document.getElementById('export-csv-btn').addEventListener('click', () => {
  window.location.href = `/api/export/csv?${currentParams()}`;
});
document.getElementById('export-excel-btn').addEventListener('click', () => {
  window.location.href = `/api/export/excel?${currentParams()}`;
});
document.getElementById('export-pdf-btn').addEventListener('click', () => {
  window.location.href = `/api/export/pdf?${currentParams()}`;
});

// Generate an initial report on load
document.getElementById('generate-btn').click();
