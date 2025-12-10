(function(){
  const rupiah = (n) => new Intl.NumberFormat('id-ID', { style:'currency', currency:'IDR', maximumFractionDigits:0 }).format(Math.round(Number(n||0)));
  const el = (id) => document.getElementById(id);
  const fromEl = el('fromDate');
  const toEl = el('toDate');
  const groupSel = el('groupSelect');
  const qEl = el('searchInput');
  const btnRefresh = el('btnRefresh');
  const btnXlsx = el('btnExportXlsx');
  const btnPdf = el('btnExportPdf');
  const presetToday = el('presetToday');
  const presetMonth = el('presetThisMonth');
  const presetYear = el('presetThisYear');
  const summaryBox = el('summaryBox');
  const groupTableBody = document.querySelector('#groupTable tbody');
  const txTableBody = document.querySelector('#txTable tbody');
  const groupLabel = el('groupLabel');

  // Helpers
  function dateToMs(dateStr, end){
    if (!dateStr) return 0;
    const d = new Date(dateStr + (end ? 'T23:59:59.999' : 'T00:00:00.000'));
    return d.getTime();
  }
  function fmtDateTime(ms){
    const d = new Date(Number(ms||0));
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${m}/${y} ${hh}:${mm}`;
  }
  function setPresetToday(){
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    fromEl.value = `${y}-${m}-${dd}`;
    toEl.value = `${y}-${m}-${dd}`;
  }
  function setPresetMonth(){
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2, '0');
    const last = new Date(y, d.getMonth()+1, 0).getDate();
    fromEl.value = `${y}-${m}-01`;
    toEl.value = `${y}-${m}-${String(last).padStart(2,'0')}`;
  }
  function setPresetYear(){
    const d = new Date();
    const y = d.getFullYear();
    fromEl.value = `${y}-01-01`;
    toEl.value = `${y}-12-31`;
  }

  // State
  let lastData = { summary: null, grouped: [], transactions: [], group: 'day' };

  async function fetchData(){
    const from = dateToMs(fromEl.value, false);
    const to = dateToMs(toEl.value, true) || Date.now();
    const q = (qEl.value || '').trim();
    const group = (groupSel.value || 'day');

    const params = new URLSearchParams();
    if (from) params.set('from', String(from));
    if (to) params.set('to', String(to));
    if (q) params.set('q', q);
    params.set('group', group);

    summaryBox.innerHTML = '<div class="text-muted">Memuat...</div>';
    groupTableBody.innerHTML = '';
    txTableBody.innerHTML = '';
    groupLabel.textContent = group === 'year' ? 'Tahunan' : group === 'month' ? 'Bulanan' : 'Harian';

    try {
      const res = await fetch(`/api/transactions/query?${params.toString()}`, { credentials:'same-origin' });
      if (!res.ok) throw new Error('Request gagal');
      const data = await res.json();
      lastData = data || lastData;
      renderSummary(data.summary || {});
      renderGrouped(data.grouped || []);
      renderTransactions(data.transactions || []);
    } catch (e) {
      summaryBox.innerHTML = '<div class="text-danger">Gagal memuat data</div>';
    }
  }

  function renderSummary(s){
    const subtotal = rupiah(s.subtotal||0);
    const disc = rupiah(s.discountAmount||0);
    const total = rupiah(s.totalAmount||0);
    const tax = rupiah(s.taxAmount||0);
    const svc = rupiah(s.serviceAmount||0);
    const cogs = rupiah(s.cogs||0);
    const profit = rupiah(s.profit||0);
    summaryBox.innerHTML = `
      <div class="row g-3">
        <div class="col-6 col-md-4">
          <div class="border rounded p-2">
            <div class="text-muted small">Transaksi</div>
            <div class="h5 mb-0">${Number(s.count||0)}</div>
          </div>
        </div>
        <div class="col-6 col-md-4">
          <div class="border rounded p-2">
            <div class="text-muted small">Subtotal</div>
            <div class="h5 mb-0">${subtotal}</div>
          </div>
        </div>
        <div class="col-6 col-md-4">
          <div class="border rounded p-2">
            <div class="text-muted small">Diskon</div>
            <div class="h5 mb-0">${disc}</div>
          </div>
        </div>
        <div class="col-6 col-md-4">
          <div class="border rounded p-2">
            <div class="text-muted small">Pajak</div>
            <div class="h5 mb-0">${tax}</div>
          </div>
        </div>
        <div class="col-6 col-md-4">
          <div class="border rounded p-2">
            <div class="text-muted small">Service</div>
            <div class="h5 mb-0">${svc}</div>
          </div>
        </div>
        <div class="col-6 col-md-4">
          <div class="border rounded p-2">
            <div class="text-muted small">HPP</div>
            <div class="h5 mb-0">${cogs}</div>
          </div>
        </div>
        <div class="col-6 col-md-4">
          <div class="border rounded p-2">
            <div class="text-muted small">Laba</div>
            <div class="h5 mb-0">${profit}</div>
          </div>
        </div>
        <div class="col-6 col-md-4">
          <div class="border rounded p-2">
            <div class="text-muted small">Total</div>
            <div class="h5 mb-0">${total}</div>
          </div>
        </div>
      </div>`;
  }

  function renderGrouped(rows){
    const html = rows.map(r => `
      <tr>
        <td>${r.label}</td>
        <td class="text-end">${Number(r.count||0)}</td>
        <td class="text-end">${rupiah(r.subtotal||0)}</td>
        <td class="text-end">${rupiah(r.discountAmount||0)}</td>
        <td class="text-end">${rupiah(r.cogs||0)}</td>
        <td class="text-end">${rupiah(r.profit||0)}</td>
        <td class="text-end">${rupiah(r.totalAmount||0)}</td>
      </tr>
    `).join('');
    groupTableBody.innerHTML = html || '<tr><td colspan="7" class="text-center text-muted">Tidak ada data</td></tr>';
  }

  function renderTransactions(rows){
    const html = rows.map(tx => `
      <tr>
        <td>${fmtDateTime(tx.timestamp)}</td>
        <td>${tx.id}</td>
        <td>${(tx.customerName||'')}</td>
        <td class="text-end">${Array.isArray(tx.items) ? tx.items.length : 0}</td>
        <td class="text-end">${rupiah(tx.subtotal||0)}</td>
        <td class="text-end">${rupiah(tx.discountAmount||0)}</td>
        <td class="text-end">${rupiah(tx.profit||0)}</td>
        <td class="text-end">${rupiah(tx.totalAmount||0)}</td>
        <td>${tx.paymentMethod||''}</td>
      </tr>
    `).join('');
    txTableBody.innerHTML = html || '<tr><td colspan="9" class="text-center text-muted">Tidak ada transaksi</td></tr>';
  }

  function exportXlsx(){
    try {
      const wb = XLSX.utils.book_new();
      // Sheet Ringkasan
      const s = lastData.summary || {};
      const summaryAoA = [
        ['Metrix','Nilai'],
        ['Transaksi', s.count||0],
        ['Subtotal', s.subtotal||0],
        ['Diskon', s.discountAmount||0],
        ['Pajak', s.taxAmount||0],
        ['Service', s.serviceAmount||0],
        ['HPP', s.cogs||0],
        ['Laba', s.profit||0],
        ['Total', s.totalAmount||0],
      ];
      const wsSum = XLSX.utils.aoa_to_sheet(summaryAoA);
      XLSX.utils.book_append_sheet(wb, wsSum, 'Ringkasan');

      // Sheet Rekap
      const grouped = lastData.grouped || [];
      const rekapAoA = [ ['Periode','Transaksi','Subtotal','Diskon','HPP','Laba','Total'] ];
      for (const r of grouped) {
        rekapAoA.push([r.label, Number(r.count||0), Number(r.subtotal||0), Number(r.discountAmount||0), Number(r.cogs||0), Number(r.profit||0), Number(r.totalAmount||0)]);
      }
      const wsGrp = XLSX.utils.aoa_to_sheet(rekapAoA);
      XLSX.utils.book_append_sheet(wb, wsGrp, 'Rekap');

      // Sheet Transaksi
      const txs = lastData.transactions || [];
      const txAoA = [['Tanggal','ID','Pelanggan','Jumlah Item','Subtotal','Diskon','Laba','Total','Metode']];
      for (const t of txs) {
        txAoA.push([fmtDateTime(t.timestamp), t.id, t.customerName||'', (Array.isArray(t.items)?t.items.length:0), Number(t.subtotal||0), Number(t.discountAmount||0), Number(t.profit||0), Number(t.totalAmount||0), t.paymentMethod||'']);
      }
      const wsTx = XLSX.utils.aoa_to_sheet(txAoA);
      XLSX.utils.book_append_sheet(wb, wsTx, 'Transaksi');

      const now = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      XLSX.writeFile(wb, `pendapatan-${now}.xlsx`);
    } catch (e) {
      alert('Gagal export XLSX');
    }
  }

  function exportPdf(){
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF('p','pt','a4');
      const s = lastData.summary || {};
      doc.setFontSize(14);
      doc.text('Laporan Pendapatan', 40, 40);
      doc.setFontSize(10);
      doc.text(`Rentang: ${fromEl.value || '-'} s/d ${toEl.value || '-'}`, 40, 58);
      doc.text(`Group: ${groupSel.value}`, 40, 72);

      // Ringkasan
      doc.autoTable({
        startY: 90,
        head: [['Metrix','Nilai']],
        body: [
          ['Transaksi', String(s.count||0)],
          ['Subtotal', rupiah(s.subtotal||0)],
          ['Diskon', rupiah(s.discountAmount||0)],
          ['Pajak', rupiah(s.taxAmount||0)],
          ['Service', rupiah(s.serviceAmount||0)],
          ['HPP', rupiah(s.cogs||0)],
          ['Laba', rupiah(s.profit||0)],
          ['Total', rupiah(s.totalAmount||0)],
        ],
        styles: { fontSize: 9 }
      });

      // Rekap
      doc.autoTable({
        startY: doc.lastAutoTable.finalY + 16,
        head: [['Periode','Transaksi','Subtotal','Diskon','HPP','Laba','Total']],
        body: (lastData.grouped||[]).map(r => [r.label, String(r.count||0), rupiah(r.subtotal||0), rupiah(r.discountAmount||0), rupiah(r.cogs||0), rupiah(r.profit||0), rupiah(r.totalAmount||0)]),
        styles: { fontSize: 9 }
      });

      // Transaksi (truncate if too many)
      const txRows = (lastData.transactions||[]).slice(0, 300).map(t => [
        fmtDateTime(t.timestamp), t.id, (t.customerName||''), String(Array.isArray(t.items)?t.items.length:0), rupiah(t.subtotal||0), rupiah(t.discountAmount||0), rupiah(t.profit||0), rupiah(t.totalAmount||0), (t.paymentMethod||'')
      ]);
      doc.autoTable({
        startY: doc.lastAutoTable.finalY + 16,
        head: [['Tanggal','ID','Pelanggan','Item','Subtotal','Diskon','Laba','Total','Metode']],
        body: txRows,
        styles: { fontSize: 8 }
      });

      const now = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      doc.save(`pendapatan-${now}.pdf`);
    } catch (e) {
      alert('Gagal export PDF');
    }
  }

  // Events
  presetToday?.addEventListener('click', (e)=>{ e.preventDefault(); setPresetToday(); fetchData(); });
  presetMonth?.addEventListener('click', (e)=>{ e.preventDefault(); setPresetMonth(); fetchData(); });
  presetYear?.addEventListener('click', (e)=>{ e.preventDefault(); setPresetYear(); fetchData(); });
  btnRefresh?.addEventListener('click', ()=> fetchData());
  btnXlsx?.addEventListener('click', exportXlsx);
  btnPdf?.addEventListener('click', exportPdf);
  qEl?.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') fetchData(); });
  groupSel?.addEventListener('change', ()=> fetchData());

  // Init default dates and load
  if (!fromEl.value || !toEl.value) setPresetToday();
  fetchData();
})();
