(function(){
  let __csrf = '';
  async function getCsrf(){
    try {
      const r = await fetch('/api/csrf', { cache: 'no-store' });
      if (r && r.ok) { const j = await r.json(); __csrf = j?.csrfToken || ''; }
    } catch {}
  }
  function jsonHeaders(){
    const h = { 'Content-Type': 'application/json' };
    if (__csrf) h['x-csrf-token'] = __csrf;
    return h;
  }
  function setButtonsDisabled(disabled){
    ['syncStatusBtn','syncPushBtn','syncPullBtn','syncNowBtn','saveSyncCfgBtn','loadChecksumsBtn'].forEach(id=>{
      const b = document.getElementById(id); if (b) b.disabled = !!disabled;
    });
  }
  function setBadge(state){
    const el = document.getElementById('syncStatusBadge'); if (!el) return;
    const map = { idle:'bg-secondary', running:'bg-info', success:'bg-success', error:'bg-danger' };
    el.className = 'badge ' + (map[state]||'bg-secondary');
    el.textContent = state === 'running' ? 'Running' : state.charAt(0).toUpperCase()+state.slice(1);
  }
  function setProgress(percent, label){
    const bar = document.getElementById('syncProgressBar');
    const lab = document.getElementById('syncPhaseLabel');
    if (bar) {
      bar.style.width = `${Math.max(0, Math.min(100, percent||0))}%`;
      // Clean any detailed item names from progress bar content
      if (bar.textContent) {
        let cleanContent = bar.textContent;
        cleanContent = cleanContent.replace(/\s*\d+%\s*\[.*?\]/g, ''); // Remove "76% [Item Name]"
        cleanContent = cleanContent.replace(/\s*\[.*?\]/g, ''); // Remove any [bracketed text]
        cleanContent = cleanContent.replace(/\s*\d+%/g, ''); // Remove standalone percentages
        bar.textContent = cleanContent;
      }
    }
    if (lab) {
      // Strip any detailed item names in brackets [like this] and percentage details
      let cleanLabel = label || '';
      cleanLabel = cleanLabel.replace(/\s*\d+%\s*\[.*?\]/g, ''); // Remove "76% [Item Name]"
      cleanLabel = cleanLabel.replace(/\s*\[.*?\]/g, ''); // Remove any [bracketed text]
      cleanLabel = cleanLabel.replace(/\s*\d+%/g, ''); // Remove standalone percentages
      lab.textContent = cleanLabel;
    }
  }
  function showToast(message, variant='success'){
    try {
      const c = document.getElementById('toastContainer');
      if (!c) return;
      const id = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const bg = variant==='success' ? 'bg-success' : variant==='error' ? 'bg-danger' : 'bg-secondary';
      const el = document.createElement('div');
      el.className = `toast align-items-center text-white ${bg} border-0`;
      el.id = id;
      el.role = 'alert';
      el.ariaLive = 'assertive';
      el.ariaAtomic = 'true';
      el.innerHTML = `<div class="d-flex"><div class="toast-body">${message}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
      c.appendChild(el);
      const t = new bootstrap.Toast(el, { delay: 2500 });
      t.show();
      el.addEventListener('hidden.bs.toast', ()=>{ try { el.remove(); } catch {} });
    } catch {}
  }
  async function loadConfig(){
    try {
      const res = await fetch('/api/sync/status', { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      document.getElementById('syncEnabled')?.setAttribute('checked', j.enabled? 'checked': '');
      const se = document.getElementById('syncEnabled'); if (se) se.checked = !!j.enabled;
      const base = document.getElementById('syncBaseUrl'); if (base) base.value = j.baseUrl || '';
      const tok = document.getElementById('syncToken'); if (tok) tok.value = j.token || '';
      // try to fetch sync_config for extra fields
      try {
        const cfgRes = await fetch('/api/settings', { cache: 'no-store' });
        if (cfgRes.ok) {
          const s = await cfgRes.json();
          const chunkSize = s?.sync?.chunkSize || 1000;
          const integrity = !!s?.sync?.integrityVerify;
          const cs = document.getElementById('syncChunkSize'); if (cs) cs.value = chunkSize;
          const iv = document.getElementById('integrityVerify'); if (iv) iv.checked = integrity;
        }
      } catch {}
    } catch {}
  }

  async function saveConfig(){
    const syncEnabled = !!document.getElementById('syncEnabled')?.checked;
    const syncBaseUrl = document.getElementById('syncBaseUrl')?.value?.trim() || '';
    const syncToken = document.getElementById('syncToken')?.value || '';
    const chunkSize = parseInt(document.getElementById('syncChunkSize')?.value || '1000', 10) || 1000;
    const integrity = !!document.getElementById('integrityVerify')?.checked;
    await fetch('/api/settings', { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ sync: { enabled: syncEnabled, baseUrl: syncBaseUrl, token: syncToken, chunkSize, integrityVerify: integrity } }) });
  }

  function bindActions(){
    const statusEl = document.getElementById('syncStatusText');
    const detailEl = document.getElementById('syncStatusDetail');
    const statOutbox = document.getElementById('statOutbox');
    const statRemote = document.getElementById('statRemote');
    const remoteSummary = document.getElementById('remoteSummary');
    document.getElementById('saveSyncCfgBtn')?.addEventListener('click', async()=>{
      try { await saveConfig(); if (statusEl) statusEl.textContent = 'Pengaturan tersimpan.'; showToast('Pengaturan sinkron berhasil disimpan','success'); }
      catch { showToast('Gagal menyimpan pengaturan','error'); }
    });
    document.getElementById('syncStatusBtn')?.addEventListener('click', async()=>{
      try {
        const res = await fetch('/api/sync/status', { cache: 'no-store' });
        const j = await res.json();
        if (statusEl) statusEl.textContent = `Enabled: ${j.enabled ? 'Ya' : 'Tidak'} | BaseURL: ${j.baseUrl || '-'} | Outbox: ${j.outboxSize} | Last Push: ${j.lastPushAt || 0} | Last Pull: ${j.lastPullAt || 0}`;
        if (statOutbox) statOutbox.textContent = j.outboxSize ?? '-';
        if (remoteSummary) remoteSummary.textContent = j.remote?.reachable ? `Remote OK (ts: ${j.remote.latestTs||'-'})` : 'Remote tidak terjangkau';
        if (statRemote) statRemote.textContent = j.remote?.reachable ? 'Online' : 'Offline';
      } catch { if (statusEl) statusEl.textContent = 'Gagal membaca status'; }
    });
    document.getElementById('syncPushBtn')?.addEventListener('click', async()=>{
      if (statusEl) statusEl.textContent = 'Mengirim data...'; setBadge('running'); setButtonsDisabled(true); setProgress(10,'Push starting');
      try {
        await saveConfig();
        const res = await fetch('/api/sync/push-local', { method: 'POST', headers: jsonHeaders() });
        const j = await res.json();
        if (statusEl) statusEl.textContent = `Pushed: ${j?.pushed?.pushed ?? 0}`; setBadge('success'); setProgress(100,'Push done');
      } catch { if (statusEl) statusEl.textContent = 'Gagal push'; setBadge('error'); }
      finally { setButtonsDisabled(false); }
    });
    document.getElementById('syncPullBtn')?.addEventListener('click', async()=>{
      if (statusEl) statusEl.textContent = 'Menarik data...'; setBadge('running'); setButtonsDisabled(true); setProgress(10,'Pull starting');
      try {
        await saveConfig();
        const res = await fetch('/api/sync/pull-remote', { method: 'POST', headers: jsonHeaders() });
        const j = await res.json();
        if (statusEl) statusEl.textContent = `Pulled: ${j?.pulled?.pulled ?? 0}`; setBadge('success'); setProgress(100,'Pull done');
      } catch { if (statusEl) statusEl.textContent = 'Gagal pull'; setBadge('error'); }
      finally { setButtonsDisabled(false); }
    });
    document.getElementById('syncNowBtn')?.addEventListener('click', async()=>{
      if (statusEl) statusEl.textContent = 'Menjalankan sinkronisasi...'; setBadge('running'); setButtonsDisabled(true); setProgress(5,'Starting');
      let stop = false;
      const poll = async ()=>{
        while(!stop){
          try {
            const r = await fetch('/api/sync/progress', { cache: 'no-store' });
            if (r && r.ok) {
              const j = await r.json();
              const p = j?.progress || {};
              const phase = p.phase || '';
              if (phase === 'pull1') { if (detailEl) detailEl.textContent = 'Menarik data dari server...'; setProgress(25,'Menarik data'); }
              else if (phase === 'push') {
                if (detailEl) detailEl.textContent = `Mengirim data ke server: batch ${p.batchIndex||0}/${p.batches||0}`;
                const pct = p.total ? Math.min(99, Math.floor(25 + (p.sent/p.total)*50)) : 50;
                setProgress(pct, `Mengirim data ${p.batchIndex||0}/${p.batches||0}`);
              }
              else if (phase === 'pull2') { if (detailEl) detailEl.textContent = 'Menarik data dari server...'; setProgress(90,'Menarik data'); }
              else { if (detailEl) detailEl.textContent = ''; }
            }
          } catch {}
          await new Promise(r=>setTimeout(r, 800));
        }
      };
      poll();
      try {
        await saveConfig();
        const res = await fetch('/api/sync/now', { method: 'POST', headers: jsonHeaders() });
        stop = true;
        const j = await res.json();
        if (statusEl) statusEl.textContent = `Selesai. Pushed: ${j?.pushed?.pushed ?? 0}, Pulled: ${j?.pulled?.pulled ?? 0}`; setBadge('success'); setProgress(100,'Selesai');
      } catch (e) {
        stop = true;
        if (statusEl) statusEl.textContent = 'Sinkron gagal.'; setBadge('error'); setProgress(0,'');
      }
      finally { setButtonsDisabled(false); }
    });
    document.getElementById('loadChecksumsBtn')?.addEventListener('click', async()=>{
      try {
        const r = await fetch('/api/sync/checksums');
        const j = await r.json();
        const pre = document.getElementById('checksumsPre');
        if (pre) pre.textContent = JSON.stringify(j?.checksums||{}, null, 2);
      } catch { showToast('Gagal memuat checksum','error'); }
    });
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    getCsrf();
    loadConfig();
    bindActions();
  });
})();
