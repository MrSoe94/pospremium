var salesTrendChart = null;
var topProductsChart = null;
var categoryDistChart = null;
var revenueByMethodChart = null;
var appSettings = null;

// --- PERBAIKAN: Stabilitas & Performance ---
var searchDebounceTimers = {};
var isRendering = { products: false, categories: false, transactions: false, users: false, customers: false };
var isLoading = false;

// --- Security: CSRF token handling ---
var __csrfToken = null;
try {
  (async function initCsrf(){
    try {
      const r = await fetch('/api/csrf', { cache: 'no-store' });
      const j = await r.json().catch(()=>({}));
      if (j && j.csrfToken) __csrfToken = j.csrfToken;
    } catch {}

    // Digital clock on admin navbar
    try {
        const clockEl = document.getElementById('adminClock');
        if (clockEl) {
            const daysId = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
            function updateClockAdmin() {
                const now = new Date();
                const hh = String(now.getHours()).padStart(2, '0');
                const mm = String(now.getMinutes()).padStart(2, '0');
                const ss = String(now.getSeconds()).padStart(2, '0');
                const day = daysId[now.getDay()] || '';
                clockEl.textContent = (day ? day + ', ' : '') + hh + ':' + mm + ':' + ss;
            }
            updateClockAdmin();
            setInterval(updateClockAdmin, 1000);
        }
    } catch {}
  })();

// Helper to ensure CSRF token is available before making state-changing API calls
async function ensureCsrfTokenReady(){
  try {
    if (__csrfToken) return __csrfToken;
    const r = await fetch('/api/csrf', { cache: 'no-store' });
    const j = await r.json().catch(()=>({}));
    if (j && j.csrfToken) { __csrfToken = j.csrfToken; return __csrfToken; }
  } catch {}
  return __csrfToken;
}
  // Wrap fetch to append X-CSRF-Token for state-changing /api requests
  (function(){
    const of = window.fetch;
    window.fetch = async function(input, init){
      init = init || {};
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      const method = String((init.method || 'GET')).toUpperCase();
      const needs = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
      const isApi = typeof url === 'string' && url.indexOf('/api/') !== -1 && url.startsWith('/');
      if (needs && isApi && __csrfToken) {
        init.headers = Object.assign({}, init.headers, { 'X-CSRF-Token': __csrfToken });
      }
      return of(input, init);
    };
  })();
} catch {}

// Fallback: ensure the helper exists in global scope
if (typeof window.ensureCsrfTokenReady !== 'function') {
  window.ensureCsrfTokenReady = async function(){
    try {
      if (window.__csrfToken) return window.__csrfToken;
      const r = await fetch('/api/csrf', { cache: 'no-store' });
      const j = await r.json().catch(()=>({}));
      if (j && j.csrfToken) { window.__csrfToken = j.csrfToken; return window.__csrfToken; }
    } catch {}
    return window.__csrfToken;
  };
}

// ====== Camera scan for Product Modal (fill SKU/QR) [GLOBAL SCOPE] ======
var adminCamStream = null; var adminCamReader = null; var adminDetectorActive = false; var adminScanTargetInputId = null;
// Remember desired product category ID to select after async load
var __desiredCategoryId = null;

async function ensureZXing(){
  if ((window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader) || (window.ZXing && window.ZXing.BrowserMultiFormatReader)) return true;
  const candidates = [
    'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/index.min.js',
    'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.4/umd/index.min.js',
    'https://unpkg.com/@zxing/browser@0.1.5/umd/index.min.js',
    'https://unpkg.com/@zxing/browser@0.1.4/umd/index.min.js',
    // User-specified alternative: core library UMD that also exposes BrowserMultiFormatReader
    'https://unpkg.com/@zxing/library@0.12.3/umd/index.min.js',
    '/js/vendor/zxing-browser.min.js'
  ];
  for (const url of candidates){
    try {
      await new Promise((res,rej)=>{ const s=document.createElement('script'); s.src=url; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
      if ((window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader) || (window.ZXing && window.ZXing.BrowserMultiFormatReader)) return true;
    } catch {}
  }
  return false;
}

function populateProductCategorySelect() {
    try {
        const sel = document.getElementById('productCategory');
        if (!sel) return;
        const current = String(sel.value || '');
        const opts = Array.isArray(categories) ? categories : [];
        const html = ['<option value="">Pilih Kategori</option>']
            .concat(opts.map(c => `<option value="${c.id}">${c.name || c.id}</option>`))
            .join('');
        sel.innerHTML = html;
        if (current) sel.value = current; // keep current if any
    } catch {}
}

function getZXingReaderCtor(){
  if (window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader) return window.ZXingBrowser.BrowserMultiFormatReader;
  if (window.ZXing && window.ZXing.BrowserMultiFormatReader) return window.ZXing.BrowserMultiFormatReader;
  return null;
}

async function startNativeDetector(videoEl, onText){
  if (!('BarcodeDetector' in window)) return false;
  try {
    const detector = new window.BarcodeDetector({ formats:['qr_code','ean_13','ean_8','code_128','code_39','upc_a','upc_e'] });
    adminDetectorActive = true;
    const loop = async ()=>{
      if (!adminDetectorActive) return;
      try {
        const codes = await detector.detect(videoEl);
        if (codes && codes.length){ const t = String(codes[0].rawValue||codes[0].rawText||''); if (t){ onText(t); return; } }
      } catch {}
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop); return true;
  } catch { return false; }
}

async function stopAdminCamera(){
  adminDetectorActive = false;
  try { if (adminCamReader){ if (typeof adminCamReader.reset==='function') adminCamReader.reset(); adminCamReader=null; } } catch {}
  try { if (adminCamStream){ adminCamStream.getTracks().forEach(t=>t.stop()); adminCamStream=null; } } catch {}
  const v = document.getElementById('adminScanVideo'); if (v) v.srcObject=null;
  const ov = document.getElementById('adminScanOverlay'); if (ov && ov.parentNode) ov.remove();
}

function parseScanPayloadToCode(raw){
  try {
    const code = String(raw||'').trim(); if (!code) return '';
    const candidates = new Set(); const push=(v)=>{ if(v!=null && String(v).trim()!=='') candidates.add(String(v).trim()); };
    push(code);
    try { const u=new URL(code); ['sku','qr','q','code','barcode','id','product','p']
      .forEach(k=>push(u.searchParams.get(k))); const parts=u.pathname.split('/').filter(Boolean); if(parts.length>0) push(parts.at(-1)); } catch{}
    try { const obj = JSON.parse(code); ['sku','qrCode','code','id','productId'].forEach(k=>push(obj?.[k])); } catch{}
    Array.from(candidates).forEach(v=>{ const compact=v.replace(/[\s-]+/g,''); if(compact!==v) push(compact); });
    for (const c of candidates){ if (!/^https?:\/\//i.test(c)) return c; }
    return Array.from(candidates)[0] || '';
  } catch { return String(raw||''); }
}

async function openAdminCameraScan(targetInputId){
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ alert('Peramban Anda tidak mendukung akses kamera. Gunakan browser terbaru.'); return; }
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'){ alert('Kamera hanya dapat diakses di HTTPS atau localhost. Akses admin via HTTPS atau localhost.'); return; }
    const modalEl = document.getElementById('adminCameraModal');
    const useModal = !!(modalEl && window.bootstrap && typeof bootstrap.Modal !== 'undefined');
    adminScanTargetInputId = targetInputId;
    if (useModal){
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      const onShown = async ()=>{
        try {
          const videoEl = document.getElementById('adminCameraVideo');
          if (!videoEl){ alert('Video element tidak ditemukan'); return; }
          videoEl.setAttribute('playsinline',''); videoEl.setAttribute('webkit-playsinline',''); videoEl.muted=true; videoEl.playsInline=true; videoEl.autoplay=true;
          if (videoEl.srcObject){ try{ videoEl.srcObject.getTracks().forEach(t=>t.stop()); }catch{} videoEl.srcObject=null; }
          let constraints={ video:{ facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720} }, audio:false };
          try { adminCamStream = await navigator.mediaDevices.getUserMedia(constraints); }
          catch{ try { adminCamStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false }); } catch(e3){ alert('Gagal mengakses kamera'); modal.hide(); return; } }
          videoEl.srcObject = adminCamStream; try { videoEl.load(); } catch{}
          await new Promise((resolve)=>{ if (videoEl.readyState>=2) return resolve(); const ok=()=>{ cleanup(); resolve(); }; const cleanup=()=>{ videoEl.removeEventListener('loadedmetadata',ok); videoEl.removeEventListener('loadeddata',ok); }; videoEl.addEventListener('loadedmetadata',ok); videoEl.addEventListener('loadeddata',ok); setTimeout(()=>{cleanup(); resolve();}, 2000); });
          try { if (videoEl.paused) await videoEl.play(); } catch { videoEl.controls=true; alert('Video autoplay diblokir. Klik play.'); }
          const onDetected = (text)=>{ const input = document.getElementById(adminScanTargetInputId); if (input) input.value = parseScanPayloadToCode(text); stopAdminCamera(); modal.hide(); };
          const ok = await ensureZXing(); const Ctor = getZXingReaderCtor();
          if (ok && Ctor){
            adminCamReader = new Ctor();
            if (typeof adminCamReader.decodeFromVideoDevice==='function'){
              adminCamReader.decodeFromVideoDevice(null, videoEl, (result,err)=>{ if (err) return; if (result&&result.getText) onDetected(String(result.getText())); });
            } else if (typeof adminCamReader.decodeFromVideoElement==='function'){
              adminCamReader.decodeFromVideoElement(videoEl, (result,err)=>{ if (err) return; if (result&&result.getText) onDetected(String(result.getText())); });
            } else if (!(await startNativeDetector(videoEl, onDetected))){ alert('Scanner tidak tersedia (metode ZXing tidak didukung dan BarcodeDetector tidak tersedia).'); stopAdminCamera(); modal.hide(); return; }
          } else if (!(await startNativeDetector(videoEl, onDetected))){ alert('Scanner tidak tersedia (ZXing gagal dimuat dan BarcodeDetector tidak didukung).'); stopAdminCamera(); modal.hide(); return; }
        } catch(e){ alert('Gagal membuka scanner: ' + (e.message||e)); stopAdminCamera(); modal.hide(); }
      };
      modalEl.addEventListener('shown.bs.modal', onShown, { once: true });
      modalEl.addEventListener('hidden.bs.modal', ()=>{ stopAdminCamera(); }, { once:true });
      modal.show(); return;
    }
    // Fallback overlay (jika modal tidak ada)
    let overlay = document.getElementById('adminScanOverlay');
    if (!overlay){ overlay = document.createElement('div'); overlay.id='adminScanOverlay'; overlay.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1060;display:flex;align-items:center;justify-content:center;">
        <div style="background:#111;border-radius:8px;padding:12px;max-width:90vw;width:640px;color:#fff;">
          <div class=\"d-flex justify-content-between align-items-center mb-2\"><strong>Scan Kamera</strong><button class=\"btn btn-sm btn-outline-light\" id=\"adminScanCloseBtn\">Tutup</button></div>
          <video id=\"adminScanVideo\" style=\"width:100%;max-height:60vh;background:#000\" autoplay muted playsinline webkit-playsinline></video>
          <small class=\"text-muted\">Arahkan barcode/QR ke kamera. Deteksi otomatis.</small>
        </div>
      </div>`; document.body.appendChild(overlay); }
    const videoEl = document.getElementById('adminScanVideo'); const closeBtn = document.getElementById('adminScanCloseBtn'); if (closeBtn) closeBtn.onclick = stopAdminCamera; if (!videoEl) return;
    videoEl.setAttribute('playsinline',''); videoEl.setAttribute('webkit-playsinline',''); videoEl.muted=true; videoEl.playsInline=true;
    let constraints={ video:{ facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720} }, audio:false };
    try { adminCamStream = await navigator.mediaDevices.getUserMedia(constraints); }
    catch{ try { adminCamStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false }); } catch(e3){ alert('Gagal mengakses kamera'); stopAdminCamera(); return; } }
    videoEl.srcObject = adminCamStream; try { videoEl.load(); } catch {}
    await new Promise((resolve)=>{ if (videoEl.readyState >= 2) return resolve(); const onLoaded = ()=>{ cleanup(); resolve(); }; const cleanup = ()=>{ videoEl.removeEventListener('loadedmetadata', onLoaded); videoEl.removeEventListener('loadeddata', onLoaded); }; videoEl.addEventListener('loadedmetadata', onLoaded); videoEl.addEventListener('loadeddata', onLoaded); setTimeout(()=>{ cleanup(); resolve(); }, 2000); });
    try { if (videoEl.paused) await videoEl.play(); } catch (e) { videoEl.controls = true; alert('Video autoplay diblokir. Klik tombol play untuk memulai kamera.'); }
    const onDetected = (text)=>{ try { const input = document.getElementById(targetInputId); const parsed = parseScanPayloadToCode(text); if (input) input.value = targetInputId === 'productQrCode' ? text : parsed; if (targetInputId === 'productQrCode') { const skuInput = document.getElementById('productSku'); if (skuInput && skuInput.value === '') skuInput.value = parsed; } } catch {} stopAdminCamera(); };
    const ok = await ensureZXing(); const Ctor = getZXingReaderCtor();
    if (ok && Ctor){ adminCamReader = new Ctor(); if (typeof adminCamReader.decodeFromVideoDevice === 'function'){ adminCamReader.decodeFromVideoDevice(null, videoEl, (result,err)=>{ if (err) return; if (result && result.getText) onDetected(String(result.getText())); }); } else if (typeof adminCamReader.decodeFromVideoElement === 'function'){ adminCamReader.decodeFromVideoElement(videoEl, (result,err)=>{ if (err) return; if (result && result.getText) onDetected(String(result.getText())); }); } else if (!(await startNativeDetector(videoEl, onDetected))){ alert('Scanner tidak tersedia di browser ini.'); stopAdminCamera(); return; } } else if (!(await startNativeDetector(videoEl, onDetected))){ alert('Scanner tidak tersedia di browser ini.'); stopAdminCamera(); return; }
  } catch (e) { alert('Gagal membuka scanner: ' + (e.message||e)); stopAdminCamera(); }
}

// Ensure buttons work regardless of modal lifecycle
document.addEventListener('click', (e)=>{
  const sku = e.target.closest && e.target.closest('#scanSkuBtn');
  if (sku){ e.preventDefault(); openAdminCameraScan('productSku'); return; }
  const qr = e.target.closest && e.target.closest('#scanQrBtn');
  if (qr){ e.preventDefault(); openAdminCameraScan('productQrCode'); return; }
});

// Sidebar toggle functionality
function initSidebarToggle() {
    const sidebarToggle = document.getElementById('sidebarToggle');
    if (sidebarToggle && !sidebarToggle.dataset.bound) {
        sidebarToggle.dataset.bound = '1';
        sidebarToggle.addEventListener('click', function(e) {
            e.preventDefault();
            toggleSidebar();
        });
    }
}

function toggleSidebar() {
    const body = document.body;
    const isHidden = body.classList.contains('sidebar-hidden');
    
    if (isHidden) {
        body.classList.remove('sidebar-hidden');
        body.classList.add('sidebar-visible');
        localStorage.setItem('sidebarState', 'visible');
    } else {
        body.classList.remove('sidebar-visible');
        body.classList.add('sidebar-hidden');
        localStorage.setItem('sidebarState', 'hidden');
    }
    
    // Trigger resize event to adjust any responsive elements
    window.dispatchEvent(new Event('resize'));
}

function restoreSidebarState() {
    const savedState = localStorage.getItem('sidebarState');
    const body = document.body;
    
    if (savedState === 'hidden') {
        body.classList.add('sidebar-hidden');
        body.classList.remove('sidebar-visible');
    } else {
        body.classList.remove('sidebar-hidden');
        body.classList.add('sidebar-visible');
    }
}

// Initialize sidebar toggle on DOM ready
document.addEventListener('DOMContentLoaded', function() {
    initSidebarToggle();
    restoreSidebarState();
    loadAppVersion();
});

// Also initialize when script loads (for dynamic content)
initSidebarToggle();

// ======= PRINT CODES HELPERS =======
function getSelectedProductsOnPage() {
    const checkboxes = document.querySelectorAll('#productTableBody .custom-checkbox-input:checked');
    const ids = Array.from(checkboxes).map(cb => cb.getAttribute('data-id'));
    const idSet = new Set(ids.map(String));
        return (products || []).filter(p => idSet.has(String(p.id)));
}

// --- Expired Products (Dashboard) ---
let expiredData = [];
async function loadExpiredProducts() {
    const container = document.getElementById('expiredList');
    if (!container) return;
    container.innerHTML = '<p class="text-muted mb-0">Memuat data produk expired...</p>';
    try {
        const res = await fetch('/api/products', { cache: 'no-store' });

// ====== Camera scan for Product Modal (fill SKU/QR) ======
let adminCamStream = null; let adminCamReader = null; let adminDetectorActive = false; let adminScanTargetInputId = null;

async function ensureZXing(){
  if ((window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader) || (window.ZXing && window.ZXing.BrowserMultiFormatReader)) return true;
  const candidates = [
    'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/index.min.js',
    'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.4/umd/index.min.js',
    'https://unpkg.com/@zxing/browser@0.1.5/umd/index.min.js',
    'https://unpkg.com/@zxing/browser@0.1.4/umd/index.min.js',
    // User-specified alternative: core library UMD that also exposes BrowserMultiFormatReader
    'https://unpkg.com/@zxing/library@0.12.3/umd/index.min.js',
    '/js/vendor/zxing-browser.min.js'
  ];
  for (const url of candidates){
    try {
      await new Promise((res,rej)=>{ const s=document.createElement('script'); s.src=url; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
      if ((window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader) || (window.ZXing && window.ZXing.BrowserMultiFormatReader)) return true;
    } catch {}
  }
  return false;
}

function getZXingReaderCtor(){
  if (window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader) return window.ZXingBrowser.BrowserMultiFormatReader;
  if (window.ZXing && window.ZXing.BrowserMultiFormatReader) return window.ZXing.BrowserMultiFormatReader;
  return null;
}

async function startNativeDetector(videoEl, onText){
  if (!('BarcodeDetector' in window)) return false;
  try {
    const detector = new window.BarcodeDetector({ formats:['qr_code','ean_13','ean_8','code_128','code_39','upc_a','upc_e'] });
    adminDetectorActive = true;
    const loop = async ()=>{
      if (!adminDetectorActive) return;
      try {
        const codes = await detector.detect(videoEl);
        if (codes && codes.length){ const t = String(codes[0].rawValue||codes[0].rawText||''); if (t){ onText(t); return; } }
      } catch {}
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop); return true;
  } catch { return false; }
}

async function stopAdminCamera(){
  adminDetectorActive = false;
  try { if (adminCamReader){ if (typeof adminCamReader.reset==='function') adminCamReader.reset(); adminCamReader=null; } } catch {}
  try { if (adminCamStream){ adminCamStream.getTracks().forEach(t=>t.stop()); adminCamStream=null; } } catch {}
  const v = document.getElementById('adminScanVideo'); if (v) v.srcObject=null;
  const ov = document.getElementById('adminScanOverlay'); if (ov && ov.parentNode) ov.remove();
}

function parseScanPayloadToCode(raw){
  try {
    const code = String(raw||'').trim(); if (!code) return '';
    const candidates = new Set(); const push=(v)=>{ if(v!=null && String(v).trim()!=='') candidates.add(String(v).trim()); };
    push(code);
    try { const u=new URL(code); ['sku','qr','q','code','barcode','id','product','p']
      .forEach(k=>push(u.searchParams.get(k))); const parts=u.pathname.split('/').filter(Boolean); if(parts.length>0) push(parts.at(-1)); } catch{}
    try { const obj = JSON.parse(code); ['sku','qrCode','code','id','productId'].forEach(k=>push(obj?.[k])); } catch{}
    Array.from(candidates).forEach(v=>{ const compact=v.replace(/[\s-]+/g,''); if(compact!==v) push(compact); });
    // return the first non-empty candidate (prefer non-URL looking)
    for (const c of candidates){ if (!/^https?:\/\//i.test(c)) return c; }
    return Array.from(candidates)[0] || '';
  } catch { return String(raw||''); }
}

async function openAdminCameraScan(targetInputId){
  try {
    // Support checks
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      alert('Peramban Anda tidak mendukung akses kamera. Gunakan browser terbaru.');
      return;
    }
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'){
      alert('Kamera hanya dapat diakses di HTTPS atau localhost. Akses admin via HTTPS atau localhost.');
      return;
    }
    // Prefer Bootstrap modal, same as POS
    const modalEl = document.getElementById('adminCameraModal');
    const useModal = !!(modalEl && window.bootstrap && typeof bootstrap.Modal !== 'undefined');
    adminScanTargetInputId = targetInputId;
    if (useModal){
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      const onShown = async ()=>{
        try {
          const videoEl = document.getElementById('adminCameraVideo');
          if (!videoEl){ alert('Video element tidak ditemukan'); return; }
          videoEl.setAttribute('playsinline',''); videoEl.setAttribute('webkit-playsinline',''); videoEl.muted=true; videoEl.playsInline=true; videoEl.autoplay=true;

          // Clear old stream
          if (videoEl.srcObject){ try{ videoEl.srcObject.getTracks().forEach(t=>t.stop()); }catch{} videoEl.srcObject=null; }

          // getUserMedia
          let constraints={ video:{ facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720} }, audio:false };
          try { adminCamStream = await navigator.mediaDevices.getUserMedia(constraints); }
          catch{ try { adminCamStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false }); } catch(e3){ alert('Gagal mengakses kamera'); modal.hide(); return; } }
          videoEl.srcObject = adminCamStream; try { videoEl.load(); } catch{}

          await new Promise((resolve)=>{
            if (videoEl.readyState>=2) return resolve();
            const ok=()=>{ cleanup(); resolve(); }; const cleanup=()=>{ videoEl.removeEventListener('loadedmetadata',ok); videoEl.removeEventListener('loadeddata',ok); };
            videoEl.addEventListener('loadedmetadata',ok); videoEl.addEventListener('loadeddata',ok); setTimeout(()=>{cleanup(); resolve();}, 2000);
          });
          try { if (videoEl.paused) await videoEl.play(); } catch { videoEl.controls=true; alert('Video autoplay diblokir. Klik play.'); }

          const onDetected = (text)=>{
            const input = document.getElementById(adminScanTargetInputId);
            const parsed = parseScanPayloadToCode(text);
            if (input) input.value = adminScanTargetInputId === 'productQrCode' ? text : parsed; // Fill QR with raw, SKU with parsed
            // If scanning QR, also fill SKU with parsed value
            if (adminScanTargetInputId === 'productQrCode') {
              const skuInput = document.getElementById('productSku');
              if (skuInput && skuInput.value === '') skuInput.value = parsed; // Only fill if SKU is empty
            }
            stopAdminCamera(); modal.hide();
          };

          const ok = await ensureZXing(); const Ctor = getZXingReaderCtor();
          if (ok && Ctor){
            adminCamReader = new Ctor();
            if (typeof adminCamReader.decodeFromVideoDevice==='function'){
              adminCamReader.decodeFromVideoDevice(null, videoEl, (result,err)=>{ if (err) return; if (result&&result.getText) onDetected(String(result.getText())); });
            } else if (typeof adminCamReader.decodeFromVideoElement==='function'){
              adminCamReader.decodeFromVideoElement(videoEl, (result,err)=>{ if (err) return; if (result&&result.getText) onDetected(String(result.getText())); });
            } else if (!(await startNativeDetector(videoEl, onDetected))){ alert('Scanner tidak tersedia (metode ZXing tidak didukung dan BarcodeDetector tidak tersedia).'); stopAdminCamera(); modal.hide(); return; }
          } else if (!(await startNativeDetector(videoEl, onDetected))){ alert('Scanner tidak tersedia (ZXing gagal dimuat dan BarcodeDetector tidak didukung).'); stopAdminCamera(); modal.hide(); return; }
        } catch(e){ alert('Gagal membuka scanner: ' + (e.message||e)); stopAdminCamera(); modal.hide(); }
      };
      modalEl.removeEventListener('shown.bs.modal', onShown);
      modalEl.addEventListener('shown.bs.modal', onShown, { once: true });
      modalEl.removeEventListener('hidden.bs.modal', stopAdminCamera);
      modalEl.addEventListener('hidden.bs.modal', ()=>{ stopAdminCamera(); }, { once:true });
      modal.show();
      return;
    }

    // Fallback: overlay way (previous implementation)
    let overlay = document.getElementById('adminScanOverlay');
    if (!overlay){
      overlay = document.createElement('div'); overlay.id='adminScanOverlay';
      overlay.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1060;display:flex;align-items:center;justify-content:center;">
        <div style="background:#111;border-radius:8px;padding:12px;max-width:90vw;width:640px;color:#fff;">
          <div class=\"d-flex justify-content-between align-items-center mb-2\"><strong>Scan Kamera</strong><button class=\"btn btn-sm btn-outline-light\" id=\"adminScanCloseBtn\">Tutup</button></div>
          <video id=\"adminScanVideo\" style=\"width:100%;max-height:60vh;background:#000\" autoplay muted playsinline webkit-playsinline></video>
          <small class=\"text-muted\">Arahkan barcode/QR ke kamera. Deteksi otomatis.</small>
        </div>
      </div>`; document.body.appendChild(overlay);
    }
    const videoEl = document.getElementById('adminScanVideo'); const closeBtn = document.getElementById('adminScanCloseBtn'); if (closeBtn) closeBtn.onclick = stopAdminCamera; if (!videoEl) return;
    videoEl.setAttribute('playsinline',''); videoEl.setAttribute('webkit-playsinline',''); videoEl.muted=true; videoEl.playsInline=true;

    // gUM
    let constraints={ video:{ facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720} }, audio:false };
    try { adminCamStream = await navigator.mediaDevices.getUserMedia(constraints); }
    catch{ try { adminCamStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false }); } catch(e3){ alert('Gagal mengakses kamera'); stopAdminCamera(); return; } }
    videoEl.srcObject = adminCamStream; try { videoEl.load(); } catch {}
    // Wait for metadata/canplay then attempt play
    await new Promise((resolve)=>{
      if (videoEl.readyState >= 2) return resolve();
      const onLoaded = ()=>{ cleanup(); resolve(); };
      const cleanup = ()=>{ videoEl.removeEventListener('loadedmetadata', onLoaded); videoEl.removeEventListener('loadeddata', onLoaded); };
      videoEl.addEventListener('loadedmetadata', onLoaded);
      videoEl.addEventListener('loadeddata', onLoaded);
      setTimeout(()=>{ cleanup(); resolve(); }, 2000);
    });
    try { if (videoEl.paused) await videoEl.play(); } catch (e) {
      // fallback: show controls
      videoEl.controls = true;
      alert('Video autoplay diblokir. Klik tombol play untuk memulai kamera.');
    }

    const onDetected = (text)=>{
      try {
        const input = document.getElementById(targetInputId);
        if (input) input.value = String(text);
      } catch {}
      stopAdminCamera();
    };

    const ok = await ensureZXing(); const Ctor = getZXingReaderCtor();
    if (ok && Ctor){
      adminCamReader = new Ctor();
      if (typeof adminCamReader.decodeFromVideoDevice === 'function'){
        adminCamReader.decodeFromVideoDevice(null, videoEl, (result,err)=>{
          if (err) return; if (result && result.getText) onDetected(String(result.getText()));
        });
      } else if (typeof adminCamReader.decodeFromVideoElement === 'function'){
        adminCamReader.decodeFromVideoElement(videoEl, (result,err)=>{
          if (err) return; if (result && result.getText) onDetected(String(result.getText()));
        });
      } else if (!(await startNativeDetector(videoEl, onDetected))){
        alert('Scanner tidak tersedia (metode ZXing tidak didukung dan BarcodeDetector tidak tersedia).'); stopAdminCamera(); return;
      }
    } else if (!(await startNativeDetector(videoEl, onDetected))){
      alert('Scanner tidak tersedia (ZXing gagal dimuat dan BarcodeDetector tidak didukung).'); stopAdminCamera(); return;
    }
  } catch (e) {
    alert('Gagal membuka scanner: ' + (e.message||e));
    stopAdminCamera();
  }
}

// Bind buttons when product modal shown
document.addEventListener('shown.bs.modal', (e)=>{
  const el = e.target; if (!el || el.id!=='productModal') return;
  loadCategories(); // Ensure categories are loaded
  // Try to apply desired category selection after categories load
  applyDesiredCategorySelection(__desiredCategoryId);
  const skuBtn = document.getElementById('scanSkuBtn');
  const qrBtn = document.getElementById('scanQrBtn');
  if (skuBtn && !skuBtn.dataset.bound){ skuBtn.dataset.bound='1'; skuBtn.addEventListener('click', ()=> openAdminCameraScan('productSku')); }
  if (qrBtn && !qrBtn.dataset.bound){ qrBtn.dataset.bound='1'; qrBtn.addEventListener('click', ()=> openAdminCameraScan('productQrCode')); }
});

// Delegated fallback: ensure clicks always work
document.addEventListener('click', (e)=>{
  const sku = e.target.closest && e.target.closest('#scanSkuBtn');
  if (sku){ e.preventDefault(); openAdminCameraScan('productSku'); return; }
  const qr = e.target.closest && e.target.closest('#scanQrBtn');
  if (qr){ e.preventDefault(); openAdminCameraScan('productQrCode'); return; }
});

        const data = await res.json();
        const arr = Array.isArray(data) ? data : [];
        const today = new Date(); today.setHours(0,0,0,0);

        function parseDateLike(v){
            if (v == null) return null;
            if (typeof v === 'number') { const d=new Date(v); return isNaN(d) ? null : d; }
            const s = String(v).trim();
            if (!s) return null;
            // Try native
            let d = new Date(s);
            if (!isNaN(d.getTime())) return d;
            // Try dd/mm/yyyy or dd-mm-yyyy
            const m1 = s.match(/^([0-3]?\d)[\/-]([01]?\d)[\/-](\d{2,4})$/);
            if (m1){
                const dd = parseInt(m1[1],10), mm = parseInt(m1[2],10)-1, yy = parseInt(m1[3],10);
                const yyyy = yy < 100 ? 2000+yy : yy;
                d = new Date(yyyy, mm, dd);
                if (!isNaN(d.getTime())) return d;
            }
            return null;
        }

        const fieldNames = ['expiryDate','expireDate','exp','expirationDate','expiredAt','expDate'];
        const expired = arr.filter(p => {
            let raw = null;
            for (const k of fieldNames){ if (p[k]) { raw = p[k]; break; } }
            const d = parseDateLike(raw);
            if (!d) return false;
            d.setHours(0,0,0,0);
            return d <= today; // include today as expired
        }).sort((a,b) => {
            function getD(o){
                for (const k of fieldNames){ if (o[k]) { const d=parseDateLike(o[k]); if (d) return d; } }
                return new Date(8640000000000000); // far future
            }
            return getD(a) - getD(b);
        });
        expiredData = expired;
        renderExpiredProducts(expired);
        if ((!expired || expired.length===0) && console && console.warn){
            console.warn('[Dashboard] Tidak ada produk expired. Periksa field expiryDate/expireDate/exp pada /api/products');
        }
    } catch (e) {
        container.innerHTML = '<p class="text-danger mb-0">Gagal memuat produk expired.</p>';
    }
}

async function loadStockInHistory() {
    try {
        const res = await fetch('/api/stock-in', { cache: 'no-store' });

        // Jika file/data tidak ada (404), perlakukan sebagai "belum ada data", bukan error
        if (!res.ok) {
            if (res.status === 404) {
                stockInHistory = [];
                renderStockInHistory();
                return;
            }
            throw new Error('Failed to load stock-in history');
        }

        const data = await res.json().catch(() => []);
        stockInHistory = Array.isArray(data) ? data : [];
        renderStockInHistory();
    } catch (e) {
        console.error('Failed to load stock-in history:', e);
        // Pada error tak terduga, tampilkan pesan gagal memuat
        stockInHistory = [];
        renderStockInHistory(true);
    }
}

function renderStockInHistory(hasError) {
    const tbody = document.getElementById('stockInHistoryBody');
    if (!tbody) return;

    if (hasError) {
        tbody.innerHTML = '<tr><td colspan="11" class="text-center text-danger">Gagal memuat riwayat barang masuk.</td></tr>';
        return;
    }

    if (!stockInHistory.length) {
        tbody.innerHTML = '<tr><td colspan="11" class="text-muted text-center">Belum ada data barang masuk.</td></tr>';
        return;
    }

    const rows = stockInHistory
        .slice()
        .sort((a,b) => (new Date(b.timestamp || b.updatedAt || 0)) - (new Date(a.timestamp || a.updatedAt || 0)))
        .map((rec, idx) => {
            const d = rec.date || (rec.timestamp ? new Date(rec.timestamp).toISOString().slice(0,10) : '');
            const dt = d ? new Date(d).toLocaleDateString('id-ID') : '-';
            const supplierName = rec.supplierName || '-';
            const items = Array.isArray(rec.items) ? rec.items : [];
            const itemCount = items.length;
            const totalQty = items.reduce((sum, it) => sum + (Number(it.qty || 0) || 0), 0);
            const note = rec.note || '';
            // Susun daftar nama produk (nama [qty])
            const prodMap = new Map();
            (stockInProducts || []).forEach(p => { prodMap.set(Number(p.id), p.name || ''); });
            const productSummary = items.map(it => {
                const pid = Number(it.productId);
                const nm = prodMap.get(pid) || `ID: ${pid}`;
                const q = Number(it.qty || 0) || 0;
                return `${nm} [${q}]`;
            }).join(', ');
            // Payment fields
            let tagihan = Number(rec.totalAmount) || 0;
            let dibayar = Number(rec.paidAmount) || 0;
            let sisa = Number(rec.remainingAmount) || 0;
            
            // If totalAmount is not present, calculate from items
            if (!tagihan && items.length > 0) {
                tagihan = items.reduce((sum, it) => sum + (Number(it.purchasePrice || 0) || 0) * (Number(it.qty || 0) || 0), 0);
            }
            // If remainingAmount is not present but we have tagihan and dibayar, calculate it
            if (!sisa && tagihan && dibayar) {
                sisa = tagihan - dibayar;
            }
            const tglBayar = rec.paymentDate ? new Date(rec.paymentDate).toLocaleDateString('id-ID') : '-';
            return `
            <tr>
                <td>${idx + 1}</td>
                <td>${dt}</td>
                <td>${supplierName}</td>
                <td>${itemCount}</td>
                <td>${totalQty}</td>
                <td>
                    <div class="d-flex align-items-center">
                        <div class="me-2">${productSummary || '-'}</div>
                        <button class="btn btn-sm btn-info view-items-btn" data-id="${rec.id}" data-items='${JSON.stringify(items)}' title="Lihat Detail Barang">
                            <i class="fas fa-eye"></i>
                        </button>
                    </div>
                </td>
                <td class="text-end">${formatCurrency(tagihan)}</td>
                <td class="text-end">${formatCurrency(dibayar)}</td>
                <td class="text-end">
                    <span class="sisa-amount">${formatCurrency(sisa)}</span>
                    <button class="btn btn-sm btn-outline-primary ms-1 edit-payment-btn" data-id="${rec.id}" data-tagihan="${tagihan}" data-dibayar="${dibayar}" data-sisa="${sisa}" data-payment-date="${rec.paymentDate || ''}">
                        <i class="fas fa-edit"></i>
                    </button>
                </td>
                <td>${tglBayar}</td>
                <td>${note}</td>
            </tr>`;
        }).join('');

    tbody.innerHTML = rows;

    // Add event listeners for edit payment buttons
    tbody.querySelectorAll('.edit-payment-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const id = this.getAttribute('data-id');
            const tagihan = Number(this.getAttribute('data-tagihan')) || 0;
            const dibayar = Number(this.getAttribute('data-dibayar')) || 0;
            const sisa = Number(this.getAttribute('data-sisa')) || 0;
            const paymentDate = this.getAttribute('data-payment-date') || '';
            openEditPaymentModal(id, tagihan, dibayar, sisa, paymentDate);
        });
    });

    // Add event listeners for view items buttons
    tbody.querySelectorAll('.view-items-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const id = this.getAttribute('data-id');
            const items = JSON.parse(this.getAttribute('data-items') || '[]');
            openViewItemsModal(id, items);
        });
    });
}

// Function to open edit payment modal
function openEditPaymentModal(id, tagihan, dibayar, sisa, paymentDate) {
    const modalHtml = `
        <div class="modal fade" id="editPaymentModal" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Edit Pembayaran</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="mb-3">
                            <label class="form-label">Tagihan</label>
                            <input type="number" class="form-control" id="editTagihan" value="${tagihan}" readonly>
                        </div>
                        <div class="mb-3">
                            <label class="form-label">Jumlah Dibayar</label>
                            <input type="number" class="form-control" id="editDibayar" value="${dibayar}" min="0">
                        </div>
                        <div class="mb-3">
                            <label class="form-label">Sisa</label>
                            <input type="number" class="form-control" id="editSisa" value="${sisa}" readonly>
                        </div>
                        <div class="mb-3">
                            <label class="form-label">Tanggal Pembayaran</label>
                            <input type="date" class="form-control" id="editPaymentDate" value="${paymentDate}">
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Batal</button>
                        <button type="button" class="btn btn-primary" onclick="savePaymentEdit('${id}')">Simpan</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // Remove existing modal if present
    const existingModal = document.getElementById('editPaymentModal');
    if (existingModal) existingModal.remove();
    
    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('editPaymentModal'));
    modal.show();
    
    // Auto-calculate sisa when dibayar changes
    const dibayarInput = document.getElementById('editDibayar');
    const sisaInput = document.getElementById('editSisa');
    dibayarInput.addEventListener('input', function() {
        const newDibayar = Number(this.value) || 0;
        const newSisa = Math.max(0, tagihan - newDibayar);
        sisaInput.value = newSisa;
    });
}

// Function to open view items modal
function openViewItemsModal(id, items) {
    // Get product names
    const prodMap = new Map();
    (stockInProducts || []).forEach(p => { prodMap.set(Number(p.id), p.name || ''); });
    
    // Find the stock-in record to get supplier and date info
    const stockInRecord = stockInHistory.find(record => String(record.id) === String(id));
    const supplierName = stockInRecord ? stockInRecord.supplierName : '-';
    const date = stockInRecord ? stockInRecord.date : '-';
    const formattedDate = date ? new Date(date).toLocaleDateString('id-ID') : '-';
    const note = stockInRecord ? (stockInRecord.note || '-') : '-';
    
    // Calculate totals
    let totalQty = 0;
    let totalAmount = 0;
    
    const itemsHtml = items.map((item, index) => {
        const productId = Number(item.productId);
        const productName = prodMap.get(productId) || `ID: ${productId}`;
        const qty = Number(item.qty || 0) || 0;
        const purchasePrice = Number(item.purchasePrice || 0) || 0;
        const subtotal = qty * purchasePrice;
        
        totalQty += qty;
        totalAmount += subtotal;
        
        return `
            <tr>
                <td>${index + 1}</td>
                <td>${productName}</td>
                <td class="text-end">${qty}</td>
                <td class="text-end">${formatCurrency(purchasePrice)}</td>
                <td class="text-end">${formatCurrency(subtotal)}</td>
            </tr>
        `;
    }).join('');
    
    const modalHtml = `
        <div class="modal fade" id="viewItemsModal" tabindex="-1">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Detail Barang Masuk - ${id}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body" id="viewItemsModalBody">
                        <div class="row mb-3">
                            <div class="col-md-6">
                                <strong>ID Transaksi:</strong> ${id}
                            </div>
                            <div class="col-md-6">
                                <strong>Tanggal:</strong> ${formattedDate}
                            </div>
                        </div>
                        <div class="row mb-3">
                            <div class="col-md-12">
                                <strong>Supplier:</strong> ${supplierName}
                            </div>
                        </div>
                        <div class="row mb-3">
                            <div class="col-md-12">
                                <strong>Catatan:</strong> ${note}
                            </div>
                        </div>
                        <div class="table-responsive">
                            <table class="table table-striped">
                                <thead>
                                    <tr>
                                        <th>No</th>
                                        <th>Nama Produk</th>
                                        <th class="text-end">Qty</th>
                                        <th class="text-end">Harga Beli</th>
                                        <th class="text-end">Subtotal</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${itemsHtml || '<tr><td colspan="5" class="text-center text-muted">Tidak ada barang</td></tr>'}
                                </tbody>
                                <tfoot>
                                    <tr class="table-active fw-bold">
                                        <td colspan="2">Total</td>
                                        <td class="text-end">${totalQty}</td>
                                        <td></td>
                                        <td class="text-end">${formatCurrency(totalAmount)}</td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-primary" onclick="printDiv('viewItemsModalBody')">
                            <i class="fas fa-print"></i> Cetak
                        </button>
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Tutup</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // Remove existing modal if present
    const existingModal = document.getElementById('viewItemsModal');
    if (existingModal) existingModal.remove();
    
    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('viewItemsModal'));
    modal.show();
}

// Print function for modal content
function printDiv(divId) {
    const printContent = document.getElementById(divId);
    if (!printContent) return;
    
    // Create a new window for printing
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
        alert('Popup blocker detected. Please allow popups for this site to print.');
        return;
    }
    
    // Get the current date
    const currentDate = new Date().toLocaleDateString('id-ID');
    
    // Extract the info rows from the modal content
    const infoRows = printContent.querySelectorAll('.row');
    let infoHtml = '';
    infoRows.forEach(row => {
        infoHtml += `<div style="margin-bottom: 10px;">${row.innerHTML}</div>`;
    });
    
    // Find the table in the content
    const table = printContent.querySelector('table');
    const tableHtml = table ? table.outerHTML : '<p>Tidak ada data</p>';
    
    // Create the print HTML
    const printHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Cetak Detail Barang Masuk</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    margin: 20px;
                    font-size: 12px;
                }
                h3 {
                    text-align: center;
                    margin-bottom: 20px;
                }
                .info-section {
                    margin-bottom: 20px;
                    padding: 10px;
                    border: 1px solid #ddd;
                    background-color: #f9f9f9;
                }
                .info-row {
                    margin-bottom: 8px;
                    display: flex;
                    justify-content: space-between;
                }
                .info-label {
                    font-weight: bold;
                    min-width: 120px;
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-bottom: 20px;
                }
                th, td {
                    border: 1px solid #ddd;
                    padding: 8px;
                    text-align: left;
                }
                th {
                    background-color: #f2f2f2;
                    font-weight: bold;
                }
                .text-end {
                    text-align: right;
                }
                .table-active {
                    background-color: #f8f9fa;
                    font-weight: bold;
                }
                .footer-info {
                    margin-top: 30px;
                    text-align: center;
                    font-size: 11px;
                    color: #666;
                }
            </style>
        </head>
        <body>
            <h3>Detail Barang Masuk</h3>
            <div class="info-section">
                ${infoHtml}
            </div>
            ${tableHtml}
            <div class="footer-info">
                <p>Dicetak pada: ${currentDate}</p>
            </div>
        </body>
        </html>
    `;
    
    printWindow.document.write(printHtml);
    printWindow.document.close();
    
    // Wait for the content to load, then print
    printWindow.onload = function() {
        printWindow.print();
        printWindow.close();
    };
}

// Function to save payment edit
async function savePaymentEdit(id) {
    try {
        const tagihan = Number(document.getElementById('editTagihan').value) || 0;
        const dibayar = Number(document.getElementById('editDibayar').value) || 0;
        const sisa = Number(document.getElementById('editSisa').value) || 0;
        const paymentDate = document.getElementById('editPaymentDate').value;
        
        await ensureCsrfTokenReady();
        const token = (window.csrfToken || '');
        
        const res = await fetch(`/api/stock-in/${id}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': token,
                'x-xsrf-token': token
            },
            credentials: 'include',
            body: JSON.stringify({
                paidAmount: dibayar,
                remainingAmount: sisa,
                paymentDate: paymentDate,
                _csrf: token
            })
        });
        
        if (!res.ok) {
            const result = await res.json().catch(() => ({}));
            throw new Error(result.message || 'Gagal memperbarui pembayaran');
        }
        
        // Close modal
        const modal = bootstrap.Modal.getInstance(document.getElementById('editPaymentModal'));
        modal.hide();
        
        // Refresh data
        await loadStockInHistory();
        
        alert('Pembayaran berhasil diperbarui');
    } catch (e) {
        console.error('Failed to save payment edit:', e);
        alert('Gagal memperbarui pembayaran: ' + (e.message || e));
    }
}

// Purge all products in database (dangerous). Requires admin and strong confirmation.
async function purgeAllProducts() {
    try {
        // Step 1: basic confirm
        if (!confirm('PERINGATAN BESAR:\n\nFitur ini akan menghapus SEMUA produk di database.\n\nProduk yang pernah dipakai di transaksi akan disembunyikan (deleted=true),\nproduk lain akan dihapus permanen.\n\nLanjutkan?')) {
            return;
        }

        // Step 2: type-to-confirm
        const phrase = 'DELETE_ALL_PRODUCTS';
        const typed = prompt('Ketik ' + phrase + ' untuk mengkonfirmasi penghapusan semua produk:');
        if (!typed || typed.trim().toUpperCase() !== phrase) {
            alert('Konfirmasi tidak cocok. Operasi dibatalkan.');
            return;
        }

        await ensureCsrfTokenReady();
        const token = (window.csrfToken || '');

        const res = await fetch('/api/products/purge-all', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': token,
                'x-xsrf-token': token
            },
            credentials: 'include',
            body: JSON.stringify({ confirm: phrase })
        });

        let j = {};
        try { j = await res.json(); } catch {}
        if (!res.ok || !j.success) {
            alert('Gagal menghapus semua produk: ' + (j.message || res.status));
            return;
        }

        alert('Berhasil menghapus semua produk.\nSebelum: ' + (j.totalBefore ?? '?') + '\nSetelah: ' + (j.totalAfter ?? '?') + '\nSoft delete (dipakai di transaksi): ' + (j.softDeleted ?? 0) + '\nHard delete: ' + (j.hardDeleted ?? 0));

        // Refresh list
        try { await loadProducts(); } catch {}
    } catch (e) {
        alert('Terjadi kesalahan saat menghapus semua produk: ' + (e && e.message ? e.message : e));
    }
}

// Remove duplicate products by name (keep the oldest one)
async function removeDuplicateProducts() {
    try {
        // Step 1: basic confirm
        if (!confirm('HAPUS PRODUK GANDA:\n\nFitur ini akan menghapus produk dengan nama yang sama persis.\n\n- Produk tertua (berdasarkan tanggal pembuatan/update) akan dipertahankan\n- Produk lainnya akan dihapus\n- Produk yang pernah dipakai di transaksi akan disembunyikan (deleted=true)\n- Produk yang tidak pernah dipakai akan dihapus permanen\n\nLanjutkan?')) {
            return;
        }

        // Show progress bar
        const progressContainer = document.getElementById('removeDuplicatesProgressContainer');
        const progressBar = document.getElementById('removeDuplicatesProgressBar');
        const progressText = document.getElementById('removeDuplicatesProgressText');
        const statusText = document.getElementById('removeDuplicatesStatusText');
        const btn = document.getElementById('removeDuplicateProductsBtn');
        
        if (progressContainer) progressContainer.style.display = 'block';
        if (btn) btn.disabled = true;
        if (btn) btn.textContent = 'Memproses...';

        // Start SSE for progress updates
        const eventSource = new EventSource('/api/products/remove-duplicates-progress');
        
        eventSource.onmessage = function(event) {
            try {
                const data = JSON.parse(event.data);
                
                if (progressBar) {
                    progressBar.style.width = data.progress + '%';
                    progressBar.textContent = data.progress + '%';
                }
                if (progressText) progressText.textContent = data.progress + '%';
                if (statusText) statusText.textContent = data.message;
                
                if (data.phase === 'complete' || data.phase === 'error') {
                    eventSource.close();
                }
            } catch (e) {
                console.error('Error parsing progress data:', e);
            }
        };
        
        eventSource.onerror = function(event) {
            console.error('SSE error:', event);
            eventSource.close();
        };

        await ensureCsrfTokenReady();
        const token = (window.csrfToken || '');

        const res = await fetch('/api/products/remove-duplicates', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': token,
                'x-xsrf-token': token
            },
            credentials: 'include',
            body: JSON.stringify({})
        });

        let j = {};
        try { j = await res.json(); } catch {}
        
        // Close SSE connection
        eventSource.close();
        
        if (!res.ok || !j.success) {
            alert('Gagal menghapus produk ganda: ' + (j.message || res.status));
            return;
        }

        let message = `Berhasil menghapus ${j.deleted || 0} produk ganda dari ${j.duplicateGroups || 0} grup.\n\n`;
        message += `Sebelum: ${j.totalBefore || '?'} produk\n`;
        message += `Setelah: ${j.totalAfter || '?'} produk\n`;
        message += `Soft delete (dipakai di transaksi): ${j.softDeleted || 0}\n`;
        message += `Hard delete: ${j.hardDeleted || 0}`;
        
        alert(message);

        // Refresh product list
        try { await loadProducts(); } catch {}
        
        // Hard refresh the page to ensure all data is updated
        setTimeout(() => {
            window.location.reload(true);
        }, 1000);
    } catch (e) {
        alert('Terjadi kesalahan saat menghapus produk ganda: ' + (e && e.message ? e.message : e));
    } finally {
        // Hide progress bar and reset button
        const progressContainer = document.getElementById('removeDuplicatesProgressContainer');
        const progressBar = document.getElementById('removeDuplicatesProgressBar');
        const progressText = document.getElementById('removeDuplicatesProgressText');
        const statusText = document.getElementById('removeDuplicatesStatusText');
        const btn = document.getElementById('removeDuplicateProductsBtn');
        
        if (progressContainer) progressContainer.style.display = 'none';
        if (progressBar) progressBar.style.width = '0%';
        if (progressBar) progressBar.textContent = '0%';
        if (progressText) progressText.textContent = '0%';
        if (statusText) statusText.textContent = 'Memulai proses...';
        if (btn) {
            btn.disabled = false;
            btn.textContent = ' Hapus Produk Ganda (Nama Sama)';
        }
    }
}

// Function to control duplicate removal button state
function updateDuplicateRemovalButtonState() {
    const allowSku = !!document.getElementById('allowDuplicateSku')?.checked;
    const allowName = !!document.getElementById('allowDuplicateProductNames')?.checked;
    const removeBtn = document.getElementById('removeDuplicateProductsBtn');
    
    if (removeBtn) {
        if (allowSku || allowName) {
            // Disable button if ANY toggle is active
            removeBtn.disabled = true;
            removeBtn.title = 'Tombol dinonaktifkan karena izin duplikasi aktif';
            removeBtn.classList.remove('btn-warning');
            removeBtn.classList.add('btn-secondary');
        } else {
            // Enable button only if BOTH toggles are inactive
            removeBtn.disabled = false;
            removeBtn.title = 'Hapus produk dengan nama yang sama persis';
            removeBtn.classList.remove('btn-secondary');
            removeBtn.classList.add('btn-warning');
        }
    }
}

function renderExpiredProducts(list) {
    const container = document.getElementById('expiredList');
    if (!container) return;
    if (!Array.isArray(list) || list.length === 0) {
        container.innerHTML = '<p class="text-success mb-0">Tidak ada produk expired. Bagus!</p>';
        return;
    }
    const esc = (s)=> String(s||'').replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
    const rows = list.map(p => {
        const name = esc(p.name || 'Produk');
        const stock = Number(p.stock || 0);
        const raw = p.expiryDate || p.expireDate || p.exp || p.expirationDate || p.expiredAt || p.expDate || '';
        const d = (function(rv){
            if (!rv) return null; if (typeof rv==='number') return new Date(rv);
            let nd = new Date(rv); if (!isNaN(nd)) return nd;
            const m = String(rv).match(/^([0-3]?\d)[\/-]([01]?\d)[\/-](\d{2,4})$/);
            if (m){ const dd=parseInt(m[1],10), mm=parseInt(m[2],10)-1, yy=parseInt(m[3],10); return new Date(yy<100?2000+yy:yy,mm,dd); }
            return null;
        })(raw);
        const exp = (!d || isNaN(d.getTime())) ? '-' : d.toISOString().slice(0,10);
        return `<tr>
            <td>${name}${p.sku ? ` <small class="text-muted">(${esc(p.sku)})</small>` : ''}</td>
            <td>${exp}</td>
            <td>${stock}</td>
        </tr>`;
    }).join('');
    container.innerHTML = `
        <div class="table-responsive">
            <table class="table table-sm table-striped">
                <thead><tr><th>Produk</th><th>Tgl Exp</th><th>Stok</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

// === XLSX Export Helpers (Dashboard Widgets) ===
async function ensureXlsxLib() {
    if (window.XLSX && window.XLSX.utils) return true;
    const candidates = [
        'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
        'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js'
    ];
    for (const src of candidates) {
        try {
            await new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
            if (window.XLSX && window.XLSX.utils) return true;
        } catch {}
    }
    alert('Gagal memuat library XLSX');
    return false;
}

async function exportExpiredToXlsx() {
    try {
        const ok = await ensureXlsxLib(); if (!ok) return;
        const list = Array.isArray(expiredData) ? expiredData : [];
        const rows = list.map(p => ({
            'Produk': p?.name || '',
            'SKU': p?.sku || '',
            'Tgl Exp': p?.expiryDate || p?.expireDate || p?.exp || p?.expirationDate || p?.expiredAt || p?.expDate || '',
            'Stok': Number(p?.stock || 0)
        }));
        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Expired');
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `expired-products-${Date.now()}.xlsx`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { alert('Gagal export expired: ' + (e?.message || e)); }
}

async function exportLowStockToXlsx() {
    try {
        const ok = await ensureXlsxLib(); if (!ok) return;
        const list = Array.isArray(lowStockData) ? lowStockData : [];
        const rows = list.map(p => ({
            'Produk': p?.name || '',
            'SKU': p?.sku || '',
            'Stok': Number(p?.stock || 0)
        }));
        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'LowStock');
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `low-stock-${Date.now()}.xlsx`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { alert('Gagal export low stock: ' + (e?.message || e)); }
}

function applyDesiredCategorySelection(desired) {
    try {
        const sel = document.getElementById('productCategory');
        if (!sel) return;
        const val = desired != null && desired !== '' ? String(desired) : String(sel.value || '');
        let attempts = 0;
        const trySet = () => {
            if (!sel) return;
            const has = Array.from(sel.options || []).some(o => String(o.value) === val);
            if (has) { sel.value = val; sel.dispatchEvent(new Event('change', { bubbles: true })); return; }
            if (attempts++ < 10) setTimeout(trySet, 150);
        };
        trySet();
    } catch {}
}

// --- Open Edit Product ---
function openEditProduct(productId) {
    try {
        const p = (products || []).find(x => String(x.id) === String(productId));
        if (!p) { alert('Produk tidak ditemukan'); return; }
        currentEditId = p.id;
        // Fill fields
        const idEl = document.getElementById('productId'); if (idEl) idEl.value = p.id;
        const nameEl = document.getElementById('productName'); if (nameEl) nameEl.value = p.name || '';
        const buyEl = document.getElementById('productPurchasePrice'); if (buyEl) buyEl.value = p.purchasePrice ?? '';
        const priceEl = document.getElementById('productPrice'); if (priceEl) priceEl.value = (p.sellingPrice ?? p.price ?? '')
        const stockEl = document.getElementById('productStock'); if (stockEl) stockEl.value = p.stock ?? 0;
        const taxEl = document.getElementById('productTaxRate'); if (taxEl) taxEl.value = p.taxRate ?? 0;
        const discEl = document.getElementById('productDiscountPercent'); if (discEl) discEl.value = p.discountPercent ?? 0;
        const catEl = document.getElementById('productCategory');
        if (catEl) {
            // Populate options if available and keep current value
            populateProductCategorySelect();
            // If categories not yet loaded, trigger load in background
            if (!Array.isArray(categories) || categories.length === 0) {
                try { loadCategories(); } catch {}
            }
            // Apply desired selection (will retry until options ready)
            __desiredCategoryId = (p.categoryId ?? '');
            applyDesiredCategorySelection(__desiredCategoryId);
        }
        // Unit/Satuan
        try {
            const unitSel = document.getElementById('productUnit');
            const unitCustom = document.getElementById('productUnitCustom');
            const unitVal = (p.unit || '').trim();
            if (unitSel && unitCustom) {
                const predefined = ['pcs','box','pack','dus','goni','lusin','kg','gram','meter','liter'];
                if (unitVal && predefined.includes(unitVal)) {
                    unitSel.value = unitVal;
                    unitCustom.style.display = 'none';
                    unitCustom.value = '';
                } else if (unitVal) {
                    unitSel.value = 'custom';
                    unitCustom.style.display = '';
                    unitCustom.value = unitVal;
                } else {
                    unitSel.value = '';
                    unitCustom.style.display = 'none';
                    unitCustom.value = '';
                }
            }
        } catch {}
        const qrEl = document.getElementById('productQrCode'); if (qrEl) qrEl.value = p.qrCode || '';
        const skuEl = document.getElementById('productSku'); if (skuEl) skuEl.value = p.sku || '';
        try { if (qrEl && !qrEl.value && skuEl && skuEl.value) qrEl.value = skuEl.value; } catch {}
        const topEl = document.getElementById('productIsTop'); if (topEl) topEl.checked = !!p.isTopProduct;
        const bestEl = document.getElementById('productIsBest'); if (bestEl) bestEl.checked = !!p.isBestSeller;
        const expEl = document.getElementById('productExpiryDate'); if (expEl) {
            const raw = p.expiryDate || p.expireDate || p.exp || '';
            if (raw) {
                const d = new Date(raw);
                if (!isNaN(d.getTime())) expEl.value = d.toISOString().slice(0,10); else expEl.value = String(raw);
            } else { expEl.value = ''; }
        }
        applyDesiredCategorySelection(p.categoryId ?? '');
        // Show modal
        const modalEl = document.getElementById('productModal');
        if (modalEl) {
            const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
            modal.show();
        }
    } catch (e) {
        alert('Gagal membuka form edit produk');
    }
}

function openPrintCodesWindow(type, items) {
    // PERBAIKAN: Validasi input
    if (!items || !Array.isArray(items) || items.length === 0) { 
        alert('Pilih minimal satu produk untuk dicetak'); 
        return; 
    }
    
    // PERBAIKAN: Validasi produk yang valid
    const validItems = items.filter(p => p && (p.id || p.id !== undefined));
    if (validItems.length === 0) {
        alert('Tidak ada produk valid untuk dicetak');
        return;
    }
    
    // PERBAIKAN: Konfirmasi untuk banyak produk
    const totalItems = validItems.length;
    let dup = 1;
    try { 
        const inp = document.getElementById('printDupCount'); 
        if (inp) dup = Math.min(50, Math.max(1, parseInt(inp.value)||1)); 
    } catch {}
    const totalToPrint = totalItems * dup;
    
    if (totalToPrint > 100) {
        const confirmMsg = `Anda akan mencetak ${totalToPrint} item (${totalItems} produk x ${dup} duplikat).\n\nLanjutkan?`;
        if (!confirm(confirmMsg)) return;
    }
    
    try {
        const w = window.open('', '_blank');
        if (!w) { 
            alert('Popup diblokir oleh browser. Mohon izinkan pop-up untuk situs ini.'); 
            return; 
        }
        
        // PERBAIKAN: Tampilkan loading di window baru
        w.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <title>Mempersiapkan ${type.toUpperCase()}...</title>
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        display: flex; 
                        justify-content: center; 
                        align-items: center; 
                        height: 100vh; 
                        margin: 0;
                        background: #f5f5f5;
                    }
                    .loading {
                        text-align: center;
                        padding: 20px;
                        background: white;
                        border-radius: 8px;
                        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                    }
                    .spinner {
                        border: 4px solid #f3f3f3;
                        border-top: 4px solid #3498db;
                        border-radius: 50%;
                        width: 40px;
                        height: 40px;
                        animation: spin 1s linear infinite;
                        margin: 0 auto 20px;
                    }
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                </style>
            </head>
            <body>
                <div class="loading">
                    <div class="spinner"></div>
                    <p>Mempersiapkan ${totalToPrint} item untuk dicetak...</p>
                </div>
            </body>
            </html>
        `);
        w.document.close();
        
        // Duplikat per produk
        const expanded = [];
        validItems.forEach(p => { 
            for (let i=0; i<dup; i++) {
                expanded.push(p); 
            }
        });
        
        const data = expanded.map(p => ({ 
            id: p.id, 
            sku: p.sku || String(p.id), 
            name: p.name || 'Produk', 
            qrCode: p.qrCode || String(p.id), 
            sellingPrice: p.sellingPrice ?? p.price ?? 0, 
            salePrice: p.salePrice, 
            discountPercent: p.discountPercent 
        }));
        
        // Baca jumlah kolom dari selector; default 3
        let cols = 3;
        try { 
            const sel = document.getElementById('printColsSelect'); 
            if (sel) cols = Math.max(1, parseInt(sel.value) || 3); 
        } catch {}
        
        // Tentukan ukuran berdasarkan kolom
        const qrSize = cols <= 2 ? 180 : cols === 3 ? 128 : cols === 4 ? 96 : 80;
        const bcHeight = cols <= 2 ? 72 : cols === 3 ? 56 : cols === 4 ? 48 : 40;
        const fontSize = cols <= 2 ? 12 : cols === 3 ? 11 : cols === 4 ? 10 : 9;
        
        const libs = (type === 'qr')
            ? '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>'
            : '<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"><\/script>';
        
        const blocks = data.map((p,i)=>{
            const name = (p.name || 'Produk').substring(0, 30);
            const codeText = type==='qr' ? (p.qrCode || String(p.id)) : (p.sku || String(p.id));
            const base = Number(p.sellingPrice ?? p.price ?? 0) || 0;
            const sale = Number(p.salePrice);
            const discPct = Number(p.discountPercent || 0);
            let discounted = null;
            if (Number.isFinite(sale) && sale >= 0 && sale < base) discounted = sale;
            else if (discPct > 0) discounted = Math.max(0, Math.round(base * (1 - (discPct/100))));
            const priceHtml = discounted != null
                ? `<div class="price"><del>${formatCurrency(base)}</del> <span class="disc">${formatCurrency(discounted)}</span></div>`
                : `<div class="price">${formatCurrency(base)}</div>`;
            return `
            <div class="code-item">
                <div class="title">${escapeHtml(name)}</div>
                <div class="code-box">${type==='qr' ? `<div id="qr_${i}"></div>` : `<svg id="bc_${i}"></svg>`}</div>
                ${priceHtml}
                <div class="meta">${escapeHtml(codeText)}</div>
            </div>`;
        }).join('');
        
        const payload = JSON.stringify(
            data.map(d => {
                const base = Number(d.sellingPrice ?? d.price ?? 0) || 0;
                const sale = Number(d.salePrice);
                const discPct = Number(d.discountPercent || 0);
                let discounted = null;
                if (Number.isFinite(sale) && sale >= 0 && sale < base) discounted = sale;
                else if (discPct > 0) discounted = Math.max(0, Math.round(base * (1 - (discPct / 100))));
                const finalPrice = discounted != null ? discounted : base;
                return { id: d.id, sku: d.sku, name: d.name, qrCode: d.qrCode, price: finalPrice };
            })
        );
        
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Print ${type.toUpperCase()} - ${totalToPrint} Item</title>
        <style>
          body{font-family:Arial,sans-serif;margin:16px}
          .grid{display:grid;grid-template-columns:repeat(${cols},1fr);gap:12px}
          .code-item{border:1px solid #e5e7eb;border-radius:8px;padding:8px;text-align:center}
          .code-box{display:flex;align-items:center;justify-content:center;min-height:140px}
          .title{font-size:${fontSize}px;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
          .price{margin-top:4px}
          .price .disc{color:#dc3545;font-weight:600}
          .meta{font-size:${Math.max(8, fontSize-2)}px;color:#6b7280;margin-top:4px}
          @media print{ body{margin:0} .code-item{break-inside:avoid} }
          @page { margin: 10mm; }
        </style>
        ${libs}
        </head><body>
          <div class="grid">${blocks}</div>
          <script>
            const data=${payload};
            const type='${type}';
            const qrSize=${qrSize};
            const bcHeight=${bcHeight};
            let loaded = 0;
            const total = data.length;
            
            function render(){
              try {
                if(type==='qr'){
                  data.forEach((d,i)=>{
                    try {
                      const el = document.getElementById('qr_'+i);
                      if(el) {
                        const nameTxt = (d.name || 'Produk').toString();
                        const priceNum = Number(d.price || 0) || 0;
                        const codeTxt = (d.qrCode || String(d.id)).toString();
                        const priceTxt = 'Rp ' + priceNum.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
                        // Hanya menggunakan SKU dan QR code untuk isi QR
                        const skuTxt = (d.sku || '').toString();
                        const qrPayload = skuTxt; // + '\\n' + codeTxt
                        new QRCode(el, { text: qrPayload, width: qrSize, height: qrSize });
                        loaded++;
                      }
                    } catch(e) {
                      console.error('Error rendering QR ' + i, e);
                    }
                  });
                } else {
                  data.forEach((d,i)=>{
                    try {
                      const el = document.getElementById('bc_'+i);
                      if(el) {
                        JsBarcode('#bc_'+i, d.sku || String(d.id), { format:'CODE128', fontSize: ${fontSize}, height: bcHeight, displayValue:false });
                        loaded++;
                      }
                    } catch(e) {
                      console.error('Error rendering barcode ' + i, e);
                    }
                  });
                }
                
                // PERBAIKAN: Tunggu semua code ter-render sebelum print
                const checkInterval = setInterval(() => {
                  if(loaded >= total) {
                    clearInterval(checkInterval);
                    setTimeout(() => {
                      window.print();
                    }, 500);
                  }
                }, 100);
                
                // Fallback timeout
                setTimeout(() => {
                  clearInterval(checkInterval);
                  if(loaded > 0) {
                    window.print();
                  } else {
                    alert('Gagal memuat library. Silakan refresh halaman.');
                  }
                }, 10000);
              } catch(e) {
                console.error('Error in render:', e);
                alert('Terjadi kesalahan: ' + e.message);
              }
            }
            
            if(document.readyState==='complete'){ 
              render(); 
            } else { 
              window.onload = render; 
            }
          <\/script>
        </body></html>`;
        
        // PERBAIKAN: Write HTML setelah loading screen
        setTimeout(() => {
            w.document.open(); 
            w.document.write(html); 
            w.document.close();
        }, 100);
        
    } catch (error) {
        console.error('Error opening print window:', error);
        alert('Terjadi kesalahan saat membuka jendela cetak: ' + (error.message || error));
    }
}

// PERBAIKAN: Helper function untuk escape HTML
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Global functions used by inline onclick in admin.html
function printSelectedQr() { openPrintCodesWindow('qr', getSelectedProductsOnPage()); }
function printSelectedBarcode() { openPrintCodesWindow('barcode', getSelectedProductsOnPage()); }

// Print all filtered results (current filter/search) - PERBAIKAN: dengan validasi dan feedback
function printAllQr() { 
    try {
        const filtered = getFilteredProducts();
        
        // PERBAIKAN: Validasi ada produk terfilter
        if (!filtered || filtered.length === 0) {
            alert('Tidak ada produk yang sesuai dengan filter saat ini.\n\nSilakan ubah filter atau search terlebih dahulu.');
            return;
        }
        
        // PERBAIKAN: Tampilkan info jumlah produk
        const searchInfo = searchTerm ? `\nSearch: "${searchTerm}"` : '';
        const categoryInfo = productCategoryFilterValue ? 
            `\nKategori: ${categories.find(c => String(c.id) === String(productCategoryFilterValue))?.name || productCategoryFilterValue}` : 
            '';
        const info = `Mencetak QR Code untuk ${filtered.length} produk${searchInfo}${categoryInfo}`;
                
        openPrintCodesWindow('qr', filtered);
    } catch (e) { 
        console.error('Error in printAllQr:', e);
        alert('Gagal membuka print QR: ' + (e.message || e));
    } 
}

function printAllBarcode() { 
    try {
        const filtered = getFilteredProducts();
        
        // PERBAIKAN: Validasi ada produk terfilter
        if (!filtered || filtered.length === 0) {
            alert('Tidak ada produk yang sesuai dengan filter saat ini.\n\nSilakan ubah filter atau search terlebih dahulu.');
            return;
        }
        
        // PERBAIKAN: Tampilkan info jumlah produk
        const searchInfo = searchTerm ? `\nSearch: "${searchTerm}"` : '';
        const categoryInfo = productCategoryFilterValue ? 
            `\nKategori: ${categories.find(c => String(c.id) === String(productCategoryFilterValue))?.name || productCategoryFilterValue}` : 
            '';
        const info = `Mencetak Barcode untuk ${filtered.length} produk${searchInfo}${categoryInfo}`;
                
        openPrintCodesWindow('barcode', filtered);
    } catch (e) { 
        console.error('Error in printAllBarcode:', e);
        alert('Gagal membuka print Barcode: ' + (e.message || e));
    } 
}

// Bulk delete selected products
async function bulkDeleteSelectedProducts() {
    const selected = getSelectedProductsOnPage();
    if (!selected || selected.length === 0) {
        alert('Pilih minimal satu produk yang akan dihapus');
        return;
    }
    if (!confirm(`Yakin hapus ${selected.length} produk terpilih? Aksi ini tidak dapat dibatalkan.`)) return;
    try {
        const ids = selected.map(p => p.id);
        // Ensure CSRF token is available once for all requests
        await ensureCsrfTokenReady();
        const token = (window.csrfToken || '');
        let okCount = 0, failCount = 0;
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            // Info progres sederhana di title
            try { document.title = `Menghapus (${i+1}/${ids.length})...`; } catch {}
            try {
                const res = await fetch(`/api/products/${id}`, {
                    method: 'DELETE',
                    headers: { 'x-csrf-token': token, 'x-xsrf-token': token },
                    credentials: 'include'
                });
                let j = {};
                try { j = await res.json(); } catch {}
                if (res.ok && j && j.success !== false) okCount++; else failCount++;
            } catch {
                failCount++;
            }
        }
        try { document.title = 'Panel Admin - Sistem POS'; } catch {}
        alert(`Hapus selesai. Berhasil: ${okCount}${failCount ? `, Gagal: ${failCount}` : ''}`);
        // Refresh data dan bersihkan centang
        await loadProducts();
        const selAll = document.getElementById('selectAllProducts');
        if (selAll) selAll.checked = false;
    } catch (e) {
        alert('Terjadi kesalahan saat menghapus produk terpilih');
    }

    // Auto backup save
    const saveAuto = document.getElementById('saveAutoBackupBtn');
    if (saveAuto && !saveAuto.dataset.bound) {
        saveAuto.dataset.bound = '1';
        saveAuto.addEventListener('click', async () => {
            try {
                const enabled = !!document.getElementById('autoBackupEnabled')?.checked;
                const mode = document.getElementById('autoBackupMode')?.value || 'off';
                const retentionDays = Number(document.getElementById('autoBackupRetention')?.value || 0) || 0;
                const maxCount = Math.max(1, Number(document.getElementById('autoBackupMaxCount')?.value || 10) || 10);
                const payload = { ...appSettings, autoBackup: { enabled, mode, retentionDays, maxCount } };
                const res = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                const j = await res.json().catch(()=>({success:false}));
                if (!res.ok || !j.success) throw new Error(j.message || 'Gagal menyimpan pengaturan');
                appSettings = j.settings;
                alert('Pengaturan auto backup tersimpan. Berlaku saat start berikutnya (untuk mode on_start/daily).');
            } catch (e) {
                alert('Gagal menyimpan: ' + (e.message || e));
            }
        });
    }
}

// --- Units (Satuan) ---
const unitModalEl = document.getElementById('unitModal');
const saveUnitBtn = document.getElementById('saveUnitBtn');
const unitTableBody = document.getElementById('unitTableBody');
async function loadUnits() {
    try {
        const res = await fetch('/api/units', { cache: 'no-store' });
        unitsList = await res.json();
        renderUnits();
    } catch {}
}
function renderUnits() {
    if (!unitTableBody) return;
    unitTableBody.innerHTML = (unitsList || []).map((u, i) => `
        <tr>
            <td>${i+1}</td>
            <td>${u.id}</td>
            <td>${u.name || ''}</td>
            <td>${u.description || ''}</td>
            <td>
                <button class="btn btn-sm btn-primary" data-bs-toggle="modal" data-bs-target="#unitModal" data-unit-edit="${u.id}" data-unit-name="${(u.name||'').replace(/"/g,'&quot;')}" data-unit-description="${(u.description||'').replace(/"/g,'&quot;')}">Edit</button>
                <button class="btn btn-sm btn-danger" data-unit-delete="${u.id}">Hapus</button>
            </td>
        </tr>
    `).join('');
}
function resetUnitForm() {
    try {
        document.getElementById('unitId').value = '';
        document.getElementById('unitName').value = '';
        document.getElementById('unitDescription').value = '';
    } catch {}
}
let __unitEditing = false;
async function openUnitEdit(id, fromBtn) {
    if (__unitEditing) return; __unitEditing = true;
    try {
                let u = null;
        // Prefer payload from button data attributes if provided
        if (fromBtn) {
            let n = fromBtn.getAttribute('data-unit-name') || '';
            let d = fromBtn.getAttribute('data-unit-description') || '';
            if (!n || !d) {
                try {
                    const tr = fromBtn.closest('tr');
                    if (tr) {
                        const tds = tr.querySelectorAll('td');
                        // columns: No, ID, Nama, Deskripsi, Aksi
                        n = n || (tds[2]?.textContent || '').trim();
                        d = d || (tds[3]?.textContent || '').trim();
                    }
                } catch {}
            }
            u = { id, name: n, description: d };
        }
        if (!u) u = (unitsList || []).find(x => String(x.id) === String(id));
        if (!u) {
            try {
                const res = await fetch('/api/units', { cache: 'no-store' });
                unitsList = await res.json();
                u = (unitsList || []).find(x => String(x.id) === String(id));
            } catch {}
        }
        if (!u) { console.warn('[UNITS] unit not found for id', id); __unitEditing = false; return; }
        // Stage payload and populate immediately
        window.__unitEditPayload = { id: u.id, name: u.name || '', description: u.description || '' };
        window.__lastUnitEditId = String(u.id);
        document.getElementById('unitId').value = u.id;
        document.getElementById('unitName').value = u.name || '';
        document.getElementById('unitDescription').value = u.description || '';
        const m = bootstrap.Modal.getOrCreateInstance(unitModalEl);
        m.show();
        try { document.getElementById('unitName').focus(); } catch {}
    } catch (e) {
        console.warn('[UNITS] openUnitEdit failed', e);
    } finally {
        __unitEditing = false;
    }
}
async function deleteUnit(id) {
    if (!confirm('Hapus satuan ini?')) return;
    await ensureCsrfTokenReady();
    const token = (window.csrfToken||'');
    const res = await fetch(`/api/units/${id}`, { method: 'DELETE', headers: { 'x-csrf-token': token, 'x-xsrf-token': token }, credentials: 'include' });
    if (!res.ok) { alert('Gagal menghapus satuan'); return; }
    await loadUnits();
    renderUnits && renderUnits();
}
if (unitModalEl) {
    unitModalEl.addEventListener('show.bs.modal', async (e) => {
        const trigger = e.relatedTarget;
        // Store the trigger to restore focus later for a11y
        try { unitModalEl._triggerEl = trigger || null; } catch {}
        if (trigger && trigger.getAttribute('data-action') === 'add') {
            resetUnitForm();
            return;
        }
        // If opened via Edit button, populate fields here
        const btn = trigger && (trigger.closest ? trigger.closest('[data-unit-edit]') : null);
        const editId = btn ? btn.getAttribute('data-unit-edit') : (trigger && trigger.getAttribute && trigger.getAttribute('data-unit-edit'));
        if (editId || window.__unitEditPayload) {
                        // Ensure unitsList loaded
            if (!Array.isArray(unitsList) || unitsList.length === 0) {
                try { const res = await fetch('/api/units', { cache: 'no-store' }); unitsList = await res.json(); } catch {}
            }
            const payload = window.__unitEditPayload;
            const useId = String(editId || (payload && payload.id) || window.__lastUnitEditId || '');
            const u = payload || (unitsList || []).find(x => String(x.id) === useId);
            if (u) {
                try {
                    document.getElementById('unitId').value = u.id;
                    document.getElementById('unitName').value = u.name || '';
                    document.getElementById('unitDescription').value = u.description || '';
                    window.__lastUnitEditId = String(u.id);
                    try { document.getElementById('unitName').focus(); } catch {}
                } catch {}
            } else {
                // fallback: clear
                resetUnitForm();
            }
        }
    });
    // Proactively blur focused controls inside modal as it hides to avoid aria-hidden focus warnings
    unitModalEl.addEventListener('hide.bs.modal', () => {
        try {
            const ae = document.activeElement;
            if (ae && unitModalEl.contains(ae) && ae.blur) ae.blur();
        } catch {}
    });
    // Ensure fields remain populated after fully shown
    unitModalEl.addEventListener('shown.bs.modal', () => {
        const p = window.__unitEditPayload;
        if (p) {
            try {
                document.getElementById('unitId').value = p.id;
                document.getElementById('unitName').value = p.name || '';
                document.getElementById('unitDescription').value = p.description || '';
                try { document.getElementById('unitName').focus(); } catch {}
            } catch {}
        } else if (!document.getElementById('unitName').value) {
            // As a final fallback, refill from last id
            const id = String(window.__lastUnitEditId || '');
            if (id) {
                const u = (unitsList || []).find(x => String(x.id) === id);
                if (u) {
                    try {
                        document.getElementById('unitId').value = u.id;
                        document.getElementById('unitName').value = u.name || '';
                        document.getElementById('unitDescription').value = u.description || '';
                    } catch {}
                }
            }
        }
    });
    unitModalEl.addEventListener('hidden.bs.modal', () => {
        try { window.__unitEditPayload = null; } catch {}
        // Reset form to avoid keeping stale values when re-opening Add
        try { resetUnitForm(); } catch {}
        // Restore focus to the element that opened the modal (or to a safe fallback)
        try {
            const ae = document.activeElement;
            if (ae && unitModalEl.contains(ae) && ae.blur) ae.blur();
            const opener = unitModalEl._triggerEl;
            if (opener && opener.focus) setTimeout(() => { try { opener.focus(); } catch {} }, 0);
        } catch {}
    });
}
if (unitTableBody && !unitTableBody._bound) {
    unitTableBody._bound = true;
    unitTableBody.addEventListener('click', (e) => {
        const editBtn = e.target.closest && e.target.closest('[data-unit-edit]');
        const delBtn = e.target.closest && e.target.closest('[data-unit-delete]');
        if (editBtn) {
            const id = editBtn.getAttribute('data-unit-edit');
            e.preventDefault(); e.stopPropagation();
            openUnitEdit(id, editBtn);
        } else if (delBtn) {
            const id = delBtn.getAttribute('data-unit-delete');
            e.preventDefault(); e.stopPropagation();
            deleteUnit(id);
        }
    });
}
// initial load
if (unitTableBody) { loadUnits(); }
// Global fallback: delegated click for Edit/Hapus unit
if (!document._unitsDelegated) {
    document._unitsDelegated = true;
    document.addEventListener('click', (e) => {
        const editBtn = e.target.closest && e.target.closest('[data-unit-edit]');
        const delBtn = e.target.closest && e.target.closest('[data-unit-delete]');
        if (editBtn) {
            const id = editBtn.getAttribute('data-unit-edit');
            e.preventDefault(); e.stopPropagation();
            try { openUnitEdit(id, editBtn); } catch {}
        } else if (delBtn) {
            const id = delBtn.getAttribute('data-unit-delete');
            e.preventDefault(); e.stopPropagation();
            try { deleteUnit(id); } catch {}
        }
    }, true);
}

// --- Auto Backup: robust saver (callable and delegated) ---
async function saveAutoBackupSettings() {
    try {
                // Ensure settings loaded
        if (!appSettings) {
            const res0 = await fetch('/api/settings', { cache: 'no-store' });
            appSettings = await res0.json();
        }
        const enabled = !!document.getElementById('autoBackupEnabled')?.checked;
        const mode = document.getElementById('autoBackupMode')?.value || 'off';
        const retentionDays = Number(document.getElementById('autoBackupRetention')?.value || 0) || 0;
        const maxCount = Math.max(1, Number(document.getElementById('autoBackupMaxCount')?.value || 10) || 10);
        const payload = { ...appSettings, autoBackup: { enabled, mode, retentionDays, maxCount } };
                const btn = document.getElementById('saveAutoBackupBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan...'; }
        const res = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const j = await res.json().catch(()=>({ success:false }));
        if (!res.ok || !j.success) throw new Error(j.message || 'Gagal menyimpan pengaturan');
        appSettings = j.settings;
        alert('Pengaturan auto backup tersimpan. Berlaku saat start berikutnya (untuk mode on_start/daily).');
    } catch (e) {
        console.error('[AUTO-BACKUP] save error', e);
        alert('Gagal menyimpan: ' + (e.message || e));
    } finally {
        const btn = document.getElementById('saveAutoBackupBtn');
        if (btn) { btn.disabled = false; btn.textContent = 'Simpan Pengaturan'; }
    }
}

// Delegate clicks in case direct binding missed
document.addEventListener('click', (e) => {
    const t = e.target.closest('#removeDuplicateProductsBtn');
    if (t) {
        e.preventDefault();
        removeDuplicateProducts();
        return;
    }
    const t2 = e.target.closest('#saveAutoBackupBtn');
    if (!t2) return;
    e.preventDefault();
    saveAutoBackupSettings();
});

// Event listeners for toggle switches
document.addEventListener('change', (e) => {
    if (e.target.id === 'allowDuplicateSku' || e.target.id === 'allowDuplicateProductNames') {
        updateDuplicateRemovalButtonState();
    }
});

// ------- Auto Backup list UI -------
function formatBytes(n){
    if (!n && n !== 0) return '';
    const u=['B','KB','MB','GB']; let i=0; let v=Number(n);
    while(v>=1024&&i<u.length-1){v/=1024;i++;}
    return v.toFixed( i===0?0:1 )+' '+u[i];
}

async function loadAutoBackups() {
    try {
        const tbody = document.getElementById('autoBackupTableBody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="text-muted">Memuat...</td></tr>`;
        const res = await fetch('/api/backup/auto-list', { cache: 'no-store' });
        const j = await res.json().catch(()=>({success:false, files:[]}));
        if (!res.ok || !j.success) throw new Error(j.message||'Gagal memuat daftar backup');
        autoBackupFiles = j.files || [];
        renderAutoBackups(autoBackupFiles);
    } catch (e) {
        const tbody = document.getElementById('autoBackupTableBody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="text-danger">${e.message||'Gagal memuat daftar backup'}</td></tr>`;
    }
}

function renderAutoBackups(files) {
    const tbody = document.getElementById('autoBackupTableBody');
    if (!tbody) return;
    const searchEl = document.getElementById('autoBackupSearch');
    const term = (searchEl ? searchEl.value : '').toString().toLowerCase().trim();
    const list = (files || []).filter(f => !term || (f.name||'').toString().toLowerCase().includes(term));
    if (!list || list.length===0) { tbody.innerHTML = `<tr><td colspan="4" class="text-muted">Belum ada file backup.</td></tr>`; return; }
    tbody.innerHTML = list.map(f => {
        const d = new Date(f.mtime);
        const dt = isNaN(d) ? '' : d.toLocaleString('id-ID');
        const size = formatBytes(f.size);
        const enc = encodeURIComponent(f.name);
        return `<tr>
            <td><code>${f.name}</code></td>
            <td>${size}</td>
            <td>${dt}</td>
            <td>
                <a class="btn btn-sm btn-outline-primary me-1" href="/api/backup/auto-download?name=${enc}">Unduh</a>
                <button class="btn btn-sm btn-outline-success me-1 restoreAutoBackupBtn" data-name="${enc}"><i class="bi bi-arrow-counterclockwise"></i></button>
                <button class="btn btn-sm btn-outline-danger deleteAutoBackupBtn" data-name="${enc}"><i class="bi bi-trash"></i></button>
            </td>
        </tr>`;
    }).join('');
}

// Bind refresh button
document.addEventListener('click', (e) => {
    const t = e.target.closest('#refreshAutoBackupListBtn');
    if (!t) return;
    e.preventDefault();
    loadAutoBackups();
});

document.addEventListener('input', (e) => {
    const t = e.target.closest('#autoBackupSearch');
    if (!t) return;
    renderAutoBackups(autoBackupFiles);
});

document.addEventListener('click', async (e) => {
    const t = e.target.closest('#backupNowBtn');
    if (!t) return;
    e.preventDefault();
    try {
        t.disabled = true; t.textContent = 'Memproses...';
        const res = await fetch('/api/backup/auto-now', { method: 'POST' });
        const j = await res.json().catch(()=>({success:false}));
        if (!res.ok || !j.success) throw new Error(j.message || 'Gagal membuat backup');
        await loadAutoBackups();
        alert('Backup berhasil dibuat: ' + (j.file || ''));
    } catch (err) {
        alert('Gagal membuat backup sekarang');
    } finally {
        t.disabled = false; t.textContent = 'Backup Sekarang';
    }
});

document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.deleteAutoBackupBtn');
    if (!btn) return;
    e.preventDefault();
    const name = btn.getAttribute('data-name');
    if (!name) return;
    if (!confirm('Hapus file backup ini?')) return;
    try {
        btn.disabled = true;
        const res = await fetch(`/api/backup/auto-delete?name=${name}`, { method: 'DELETE' });
        const j = await res.json().catch(()=>({success:false}));
        if (!res.ok || !j.success) throw new Error(j.message || 'Gagal menghapus');
        await loadAutoBackups();
    } catch (err) {
        alert('Gagal menghapus backup');
    } finally {
        btn.disabled = false;
    }
});

document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.restoreAutoBackupBtn');
    if (!btn) return;
    e.preventDefault();
    const name = btn.getAttribute('data-name');
    if (!name) return;
    if (!confirm('Pulihkan database dari backup ini? Semua data saat ini akan ditimpa.')) return;
    try {
        btn.disabled = true;
        // Download backup file content
        const res = await fetch(`/api/backup/auto-download?name=${name}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('Gagal mengunduh file backup');
        // Normalize content (trim to remove BOM/whitespace/newlines before ENC1 or JSON)
        const text = (await res.text()).trim();
        // CSRF token
        let csrfToken = '';
        try { const c = await fetch('/api/csrf'); const j = await c.json(); csrfToken = j && j.csrfToken || ''; } catch {}
        // Send to appropriate restore endpoint
        let r2;
        if (typeof text === 'string' && text.startsWith('ENC1:')) {
            r2 = await fetch('/api/backup/database/restore-enc', {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain', 'x-csrf-token': csrfToken },
                body: text
            });
        } else {
            let payload;
            try { payload = JSON.parse(text); }
            catch { payload = { __encrypted: text }; }
            r2 = await fetch('/api/backup/database/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
                body: JSON.stringify(payload)
            });
        }

        // Payment logos (QRIS, DANA, OVO)
        function bindPaymentLogoInput(fileInputId, previewId) {
            const fileEl = document.getElementById(fileInputId);
            if (!fileEl) return;
            fileEl.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                if (file.size > MAX_FILE_SIZE) {
                    alert(`File terlalu besar! Maksimal ${MAX_FILE_SIZE / 1024 / 1024}MB.`);
                    e.target.value = '';
                    return;
                }
                const reader = new FileReader();
                reader.onloadend = () => {
                    const v = reader.result;
                    if (typeof v === 'string' && v.startsWith('data:image')) {
                        const p = document.getElementById(previewId);
                        if (p) { p.src = v; p.style.display = 'block'; }
                        if (textareaId) {
                            const ta = document.getElementById(textareaId);
                            if (ta) ta.value = v;
                        }
                    }
                };
                reader.readAsDataURL(file);
            });
        }

        bindPaymentLogoInput('paymentLogoQrisFile', 'paymentLogoQrisPreview');
        bindPaymentLogoInput('paymentLogoDanaFile', 'paymentLogoDanaPreview');
        bindPaymentLogoInput('paymentLogoOvoFile', 'paymentLogoOvoPreview');
        const j2 = await r2.json().catch(()=>({success:false}));
        if (!r2.ok || !j2.success) throw new Error(j2.message || 'Restore gagal');
        alert('Restore berhasil. Silakan muat ulang halaman.');
    } catch (err) {
        alert('Gagal melakukan restore: ' + (err.message || err));
    } finally {
        btn.disabled = false;
    }
});

// Manual restore from file (backup view)
document.addEventListener('click', async (e) => {
    const btn = e.target.closest('#restoreDbBtn');
    if (!btn) return;
    e.preventDefault();
    try {
        const fileInput = document.getElementById('restoreDbFile');
        if (!fileInput || !fileInput.files || fileInput.files.length === 0) { alert('Pilih file backup terlebih dahulu'); return; }
        if (!confirm('Lanjutkan restore database dari file ini? Semua data saat ini akan ditimpa.')) return;
        
        // Show progress bar
        const progressContainer = document.getElementById('restoreProgressContainer');
        const progressBar = document.getElementById('restoreProgressBar');
        const progressText = document.getElementById('restoreProgressText');
        const statusText = document.getElementById('restoreStatusText');
        const restoreBtn = document.getElementById('restoreDbBtn');
        
        if (progressContainer) {
            progressContainer.style.display = 'block';
            // Reset progress
            updateRestoreProgress(0, 'Memulai proses restore...');
            // Disable restore button during process
            restoreBtn.disabled = true;
            restoreBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Memproses...';
        }
        
        const f = fileInput.files[0];
        console.log('File selected for restore:', f.name, f.type, f.size);
        updateRestoreProgress(10, 'Membaca file backup...');
        
        // Normalize content to avoid JSON.parse error if file begins with BOM/newlines before ENC1
        const text = (await f.text()).trim();
        console.log('File content length:', text.length);
        console.log('File content starts with:', text.substring(0, 50));
        updateRestoreProgress(20, 'Memparsing data backup...');
        
        // CSRF token
        let csrfToken = '';
        try { 
            const c = await fetch('/api/csrf'); 
            const j = await c.json(); 
            csrfToken = j && j.csrfToken || ''; 
        } catch {}
        updateRestoreProgress(30, 'Menghubungkan ke server...');
        
        let r;
        if (text.startsWith('ENC1:')) {
            console.log('Sending as encrypted text');
            updateRestoreProgress(40, 'Mengirim data terenkripsi...');
            r = await fetch('/api/backup/database/restore-enc', { method:'POST', headers:{ 'Content-Type':'text/plain', 'x-csrf-token': csrfToken }, body: text });
        } else {
            console.log('Parsing as JSON');
            updateRestoreProgress(40, 'Memparsing JSON...');
            let payload;
            try { 
                payload = JSON.parse(text); 
                console.log('Parsed payload keys:', Object.keys(payload));
                updateRestoreProgress(50, 'JSON berhasil diparsing...');
            } catch (e) {
                console.log('JSON parse failed, treating as encrypted:', e.message);
                payload = { __encrypted: text }; 
                updateRestoreProgress(50, 'Menghandle sebagai data terenkripsi...');
            }
            updateRestoreProgress(60, 'Mengirim data ke server...');
            r = await fetch('/api/backup/database/restore', { method:'POST', headers:{ 'Content-Type':'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(payload) });
        }
        
        updateRestoreProgress(80, 'Server memproses data...');
        console.log('Response status:', r.status);
        const jr = await r.json().catch(()=>({ success:false }));
        console.log('Response data:', jr);
        
        updateRestoreProgress(90, 'Menyelesaikan proses...');
        
        if (!r.ok || !jr.success) {
            throw new Error(jr.message || 'Restore gagal');
        }
        
        updateRestoreProgress(100, 'Restore berhasil!');
        
        // Show success message
        setTimeout(() => {
            alert('Restore berhasil. Silakan muat ulang halaman.');
            // Hide progress bar
            if (progressContainer) {
                progressContainer.style.display = 'none';
            }
            // Reset button
            restoreBtn.disabled = false;
            restoreBtn.innerHTML = '<i class="bi bi-upload"></i> Restore Database';
        }, 1000);
        
    } catch (err) {
        console.error('Restore error:', err);
        
        // Show error in progress
        const statusText = document.getElementById('restoreStatusText');
        if (statusText) {
            statusText.innerHTML = `<span class="text-danger">Error: ${err.message || err}</span>`;
        }
        
        // Reset button after delay
        setTimeout(() => {
            const progressContainer = document.getElementById('restoreProgressContainer');
            const restoreBtn = document.getElementById('restoreDbBtn');
            if (progressContainer) {
                progressContainer.style.display = 'none';
            }
            restoreBtn.disabled = false;
            restoreBtn.innerHTML = '<i class="bi bi-upload"></i> Restore Database';
        }, 3000);
        
        alert('Gagal melakukan restore: ' + (err.message || err));
    }
});

// Update progress bar function
function updateRestoreProgress(percentage, status) {
    const progressBar = document.getElementById('restoreProgressBar');
    const progressText = document.getElementById('restoreProgressText');
    const statusText = document.getElementById('restoreStatusText');
    
    // Clean status text to remove detailed item names
    if (status) {
        status = status.replace(/\s*\d+%\s*\[.*?\]/g, ''); // Remove "76% [Item Name]"
        status = status.replace(/\s*\[.*?\]/g, ''); // Remove any [bracketed text]
        status = status.replace(/\s*\d+%/g, ''); // Remove standalone percentages
    }
    
    if (progressBar) {
        // Animate the progress bar
        if (percentage < 5) {
            progressBar.style.transform = `scaleX(${percentage/6})`;
            progressBar.style.opacity = '0.8';
        } else {
            progressBar.style.transform = `scaleX(1)`;
            progressBar.style.opacity = '1';
        }
        progressBar.style.width = percentage + '%';
        progressBar.textContent = Math.round(percentage) + '%';
    }
    
    if (progressText) {
        progressText.textContent = Math.round(percentage) + '%';
    }
    
    if (statusText) {
        statusText.textContent = status;
    }
}

async function loadDashboard() {
    try {
        const [recentRes, productsRes, categoriesRes] = await Promise.all([
            fetch('/api/recent-transactions', { cache: 'no-store' }),
            fetch('/api/products', { cache: 'no-store' }),
            fetch('/api/categories', { cache: 'no-store' })
        ]);
        const recent = await recentRes.json();
        const prods = await productsRes.json();
        const cats = await categoriesRes.json();

        const days = [];
        const totals = [];
        const now = new Date();
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(now.getDate() - i);
            const key = d.toISOString().slice(0,10);
            days.push(key);
            const dayTotal = (recent || [])
                .filter(t => {
                    try {
                        if (t && t.date) return String(t.date).slice(0,10) === key;
                        if (t && t.timestamp) return new Date(Number(t.timestamp)).toISOString().slice(0,10) === key;
                        return false;
                    } catch { return false; }
                })
                .reduce((s, t) => s + (Number(t.totalAmount || t.total || 0) || 0), 0);
            totals.push(dayTotal);
        }
        // (Listeners for Banner/QRIS/Logo dipindahkan ke setupForms agar selalu terpasang.)
    
     const productMap = new Map();
        (recent || []).forEach(t => {
            (t.items || []).forEach(it => {
                const key = it.productId || it.id || it.name;
                const prev = productMap.get(key) || { name: it.name || `#${key}`, qty: 0 };
                prev.qty += Number(it.quantity || it.qty || 0);
                productMap.set(key, prev);
            });

// Global fallback handlers used by inline onclick in admin.html
function printSelectedQr() {
    try { openPrintCodesWindow('qr', getSelectedProductsOnPage()); } catch (e) { alert('Gagal membuka print QR'); }
}
        });
        const top = Array.from(productMap.values())
            .sort((a,b) => b.qty - a.qty)
            .slice(0,5);

        const catCounts = cats.map(c => ({ name: c.name, count: prods.filter(p => p.categoryId == c.id).length }));

        const stc = document.getElementById('salesTrendChart');
        const tpc = document.getElementById('topProductsChart');
        const cdc = document.getElementById('categoryDistChart');
        const rmc = document.getElementById('revenueByMethodChart');
        if (stc) {
            if (salesTrendChart) salesTrendChart.destroy();
            salesTrendChart = new Chart(stc.getContext('2d'), {
                type: 'line',
                data: {
                    labels: days,
                    datasets: [{ label: 'Total Penjualan', data: totals, borderColor: '#0d6efd', backgroundColor: 'rgba(13,110,253,0.1)', tension: 0.3 }]
                },
                options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
            });
        }
        const dlAppZipStructured = document.getElementById('downloadAppZipStructuredBtn');
        if (dlAppZipStructured && !dlAppZipStructured.dataset.bound) {
            dlAppZipStructured.dataset.bound = '1';
            dlAppZipStructured.addEventListener('click', async () => {
                try {
                    const res = await fetch('/api/backup/app-zip-structured');
                    if (!res.ok) throw new Error('Gagal membuat backup aplikasi (ZIP Structured)');
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = `backup-app-structured-${Date.now()}.zip`;
                    document.body.appendChild(a); a.click(); a.remove();
                    URL.revokeObjectURL(url);
                } catch (e) { alert('Gagal mengunduh backup aplikasi (ZIP Structured)'); }
            });
        }
        const restoreDbZipBtn = document.getElementById('restoreDbZipBtn');
        const restoreDbZipFile = document.getElementById('restoreDbZipFile');
        if (restoreDbZipBtn && restoreDbZipFile && !restoreDbZipBtn.dataset.bound) {
            restoreDbZipBtn.dataset.bound = '1';
            restoreDbZipBtn.addEventListener('click', async () => {
                try {
                    if (!restoreDbZipFile.files || restoreDbZipFile.files.length === 0) { alert('Pilih file ZIP backup terlebih dahulu'); return; }
                    if (!confirm('Lanjutkan restore database dari ZIP? Data di folder data/ akan ditimpa.')) return;
                    const file = restoreDbZipFile.files[0];
                    const base64 = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => {
                            try { const s = String(reader.result || ''); resolve(s.split(',')[1] || ''); } catch { reject(new Error('Gagal membaca file')); }
                        };
                        reader.onerror = () => reject(new Error('Gagal membaca file'));
                        reader.readAsDataURL(file);
                    });
                    const res = await fetch('/api/backup/database/restore-zip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zipBase64: base64 }) });
                    const j = await res.json().catch(()=>({success:false}));
                    if (!res.ok || !j.success) throw new Error(j.message || 'Restore ZIP gagal');
                    alert('Restore database (ZIP) berhasil. Silakan reload halaman.');
                } catch (e) { alert('Restore ZIP gagal: ' + (e.message || e)); }
            });
        }
        const dlAppZip = document.getElementById('downloadAppZipBtn');
        if (dlAppZip && !dlAppZip.dataset.bound) {
            dlAppZip.dataset.bound = '1';
            dlAppZip.addEventListener('click', async () => {
                try {
                    const res = await fetch('/api/backup/app-zip');
                    if (!res.ok) throw new Error('Gagal membuat backup aplikasi (ZIP)');
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = `backup-app-${Date.now()}.zip`;
                    document.body.appendChild(a); a.click(); a.remove();
                    URL.revokeObjectURL(url);
                } catch (e) { alert('Gagal mengunduh backup aplikasi (ZIP)'); }
            });
        }
        if (tpc) {
            if (topProductsChart) topProductsChart.destroy();
            topProductsChart = new Chart(tpc.getContext('2d'), {
                type: 'bar',
                data: {
                    labels: top.map(x => x.name),
                    datasets: [{ label: 'Qty', data: top.map(x => x.qty), backgroundColor: '#198754' }]
                },
                options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
            });
        }
        if (cdc) {
            if (categoryDistChart) categoryDistChart.destroy();
            categoryDistChart = new Chart(cdc.getContext('2d'), {
                type: 'doughnut',
                data: {
                    labels: catCounts.map(c => c.name),
                    datasets: [{ data: catCounts.map(c => c.count), backgroundColor: ['#0d6efd','#198754','#dc3545','#fd7e14','#20c997','#6f42c1','#0dcaf0','#ffc107'] }]
                },
                options: { plugins: { legend: { position: 'bottom' } } }
            });
        }
        if (rmc) {
            // Compute revenue by payment method from recent transactions
            const revenue = { cash: 0, qris: 0 };
            (recent || []).forEach(t => {
                const method = (t.paymentMethod || '').toLowerCase();
                const amount = Number(t.totalAmount || t.total || 0) || 0;
                if (method === 'cash') revenue.cash += amount; else if (method === 'qris') revenue.qris += amount;
            });
            if (revenueByMethodChart) revenueByMethodChart.destroy();
            revenueByMethodChart = new Chart(rmc.getContext('2d'), {
                type: 'doughnut',
                data: {
                    labels: ['Tunai', 'QRIS'],
                    datasets: [{ data: [revenue.cash, revenue.qris], backgroundColor: ['#20c997', '#0dcaf0'] }]
                },
                options: { plugins: { legend: { position: 'bottom' } } }
            });
        }
    } catch (e) {
        console.error('Failed to load dashboard data', e);
    }
}
// Ganti seluruh isi file public/js/admin.js dengan ini
let currentEditId = null;
let currentEditType = null;
let selectedImportFile = null;
let products = [];
let categories = [];
let categorySearchTerm = '';
let categoryCurrentPage = 1;
let categoryPageSize = 10;
let searchTerm = '';
let currentPage = (function(){
    try { const v = parseInt(localStorage.getItem('productsCurrentPage')||'1'); return isNaN(v)?1:v; } catch { return 1; }
})();
let pageSize = 10;
let users = [];
let userSearchTerm = '';
let userCurrentPage = 1;
let userPageSize = 10;
let productCategoryFilterValue = '';
let roleFilter = '';
let statusFilter = '';
let transactions = [];
let transactionToVoidId = null;
let transactionSearchTerm = '';
let transactionCurrentPage = 1;
let transactionPageSize = 10;
let paymentMethodFilter = '';
let dateRangeFilter = '';
let customStartDate = '';
let customEndDate = '';
let autoBackupFiles = [];
let shifts = [];
let shiftCurrentPage = 1;
let shiftPageSize = 10;
let shiftCashierFilterValue = '';
let shiftDateFromFilter = '';
let shiftDateToFilter = '';

// Helper function for currency formatting
function formatCurrency(value) {
    const symbol = (appSettings && appSettings.currencySymbol) || 'Rp';
    const precision = (appSettings && typeof appSettings.currencyPrecision === 'number') ? appSettings.currencyPrecision : 0;
    const thou = (appSettings && appSettings.thousandSeparator) || '.';
    const dec = (appSettings && appSettings.decimalSeparator) || ',';
    let n = Number(value || 0);
    const neg = n < 0; n = Math.abs(n);
    const fixed = n.toFixed(precision);
    let [intPart, decPart] = fixed.split('.');
    intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thou);
    const body = precision > 0 ? `${intPart}${dec}${decPart}` : intPart;
    return `${neg ? '-' : ''}${symbol} ${body}`.trim();
}

// Helper function untuk pagination minimalis
function generateMinimalPaginationLinks(current, total) {
    const pages = [];
    if (total <= 7) {
        for (let i = 1; i <= total; i++) pages.push(i);
    } else {
        pages.push(1);
        if (current > 4) pages.push('...');
        const start = Math.max(2, current - 1);
        const end = Math.min(total - 1, current + 1);
        for (let i = start; i <= end; i++) pages.push(i);
        if (current < total - 3) pages.push('...');
        if (total > 1) pages.push(total);
    }
    return pages;
}

const resetPasswordModal = new bootstrap.Modal(document.getElementById('resetPasswordModal'));
const transactionDetailsModal = new bootstrap.Modal(document.getElementById('transactionDetailsModal'));
const dateRangeModal = new bootstrap.Modal(document.getElementById('dateRangeModal'));

// Global fix: ensure any modal is appended to <body> before showing to avoid being hidden by parent containers
(() => {
  try {
    if (!document._modalAppendToBodyBound) {
      document._modalAppendToBodyBound = true;
      document.addEventListener('show.bs.modal', (ev) => {
        try {
          const el = ev.target;
          if (el && el.classList && el.classList.contains('modal')) {
            if (el.parentElement !== document.body) {
              document.body.appendChild(el);
            }
          }
        } catch {}
      }, true);
    }
  } catch {}
})();

const PLACEHOLDER_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const MAX_FILE_SIZE = 1 * 1024 * 1024;

// --- Image Utils: EXIF Orientation + Compress/Resize ---
async function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsArrayBuffer(file);
    });
}
async function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
    });
}
// Minimal EXIF orientation parser (JPEG only). Returns 1 if unknown.
function getExifOrientation(arrayBuffer) {
    try {
        const view = new DataView(arrayBuffer);
        if (view.getUint16(0, false) !== 0xFFD8) return 1; // not JPEG
        let offset = 2;
        const length = view.byteLength;
        while (offset < length) {
            if (view.getUint16(offset + 2, false) <= 8) return 1;
            const marker = view.getUint16(offset, false);
            offset += 2;
            if (marker === 0xFFE1) {
                // APP1 EXIF
                if (view.getUint32(offset += 2, false) !== 0x45786966) return 1; // 'Exif'
                const little = view.getUint16(offset += 6, false) === 0x4949;
                offset += view.getUint32(offset + 4, little);
                const tags = view.getUint16(offset, little);
                offset += 2;
                for (let i = 0; i < tags; i++) {
                    const tagOffset = offset + (i * 12);
                    if (view.getUint16(tagOffset, little) === 0x0112) {
                        const val = view.getUint16(tagOffset + 8, little);
                        return val || 1;
                    }
                }
            } else if ((marker & 0xFF00) !== 0xFF00) {
                break;
            } else {
                offset += view.getUint16(offset, false);
            }
        }
    } catch {}
    return 1;
}
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}
function drawImageWithOrientation(ctx, img, orientation, targetW, targetH) {
    // Setup canvas transform based on EXIF orientation
    switch (orientation) {
        case 2: // horizontal flip
            ctx.translate(targetW, 0); ctx.scale(-1, 1); break;
        case 3: // 180
            ctx.translate(targetW, targetH); ctx.rotate(Math.PI); break;
        case 4: // vertical flip
            ctx.translate(0, targetH); ctx.scale(1, -1); break;
        case 5: // transpose
            ctx.rotate(0.5 * Math.PI); ctx.scale(1, -1); ctx.translate(0, -targetW); [targetW, targetH] = [targetH, targetW]; break;
        case 6: // 90 cw
            ctx.rotate(0.5 * Math.PI); ctx.translate(0, -targetW); [targetW, targetH] = [targetH, targetW]; break;
        case 7: // transverse
            ctx.rotate(0.5 * Math.PI); ctx.scale(-1, 1); ctx.translate(-targetH, -targetW); [targetW, targetH] = [targetH, targetW]; break;
        case 8: // 90 ccw
            ctx.rotate(-0.5 * Math.PI); ctx.translate(-targetH, 0); [targetW, targetH] = [targetH, targetW]; break;
        default:
            // 1: no transform
            break;
    }
    // Note: after rotate/translate, draw at 0,0 with width/height possibly swapped
    return { outW: targetW, outH: targetH };
}
async function compressDataUrl(dataUrl, maxBytes = MAX_FILE_SIZE, maxDim = 1280) {
    const img = await loadImage(dataUrl);
    let iw = img.naturalWidth || img.width;
    let ih = img.naturalHeight || img.height;
    const scale = Math.min(1, maxDim / Math.max(iw, ih));
    const tw = Math.max(1, Math.round(iw * scale));
    const th = Math.max(1, Math.round(ih * scale));
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, tw, th);
    let quality = 0.9;
    let out = canvas.toDataURL('image/jpeg', quality);
    while (out.length > maxBytes * 1.37 && quality > 0.5) { // rough base64 factor ~1.37
        quality -= 0.05;
        out = canvas.toDataURL('image/jpeg', quality);
    }
    return out;
}
async function processImageFile(file, maxBytes = MAX_FILE_SIZE, maxDim = 1280) {
    const [ab, dataUrl] = await Promise.all([readFileAsArrayBuffer(file), readFileAsDataURL(file)]);
    const orientation = getExifOrientation(ab);
    const img = await loadImage(dataUrl);
    // initial target size
    let iw = img.naturalWidth || img.width;
    let ih = img.naturalHeight || img.height;
    const maxSide = Math.max(iw, ih);
    const scale = Math.min(1, maxDim / maxSide);
    let tw = Math.max(1, Math.round(iw * scale));
    let th = Math.max(1, Math.round(ih * scale));
    // swap if rotating 90/270 (orientation 5-8)
    const willSwap = [5,6,7,8].includes(orientation);
    const canvas = document.createElement('canvas');
    canvas.width = willSwap ? th : tw;
    canvas.height = willSwap ? tw : th;
    const ctx = canvas.getContext('2d');
    ctx.save();
    const { outW, outH } = drawImageWithOrientation(ctx, img, orientation, canvas.width, canvas.height);
    // Draw image fitted into canvas
    ctx.drawImage(img, 0, 0, outW, outH);
    ctx.restore();
    let quality = 0.9;
    let out = canvas.toDataURL('image/jpeg', quality);
    while (out.length > maxBytes * 1.37 && (quality > 0.5 || (canvas.width > 640 || canvas.height > 640))) {
        if (quality > 0.5) {
            quality -= 0.05;
        } else {
            // Further downscale by 10%
            const c2 = document.createElement('canvas');
            c2.width = Math.max(1, Math.round(canvas.width * 0.9));
            c2.height = Math.max(1, Math.round(canvas.height * 0.9));
            c2.getContext('2d').drawImage(canvas, 0, 0, c2.width, c2.height);
            canvas.width = c2.width; canvas.height = c2.height;
            ctx.clearRect(0,0,canvas.width,canvas.height);
            ctx.drawImage(c2, 0, 0);
        }
        out = canvas.toDataURL('image/jpeg', quality);
    }
    return out;
}

document.addEventListener('DOMContentLoaded', async () => {
    setupNavigation();
    setupLogout();
    setupDarkModeToggle();
    setupForms();
    setupEventListeners();
    try { loadAutoBackups(); } catch {}
    // Fixed header padding and restore sidebar state
    try { document.body.classList.add('fixed-navbar'); } catch {}
    await loadSettings();
    await loadInitialData();
    // Load dashboard charts on initial page load
    await loadDashboard();
    // Check URL hash and show appropriate view
    const hash = window.location.hash.substring(1) || localStorage.getItem('adminLastView') || 'dashboard';
    if (hash && document.getElementById(`${hash}-view`)) {
        showView(hash);
        document.querySelectorAll('.sidebar .nav-link').forEach(l => l.classList.remove('active'));
        const activeLink = document.querySelector(`.sidebar .nav-link[data-view="${hash}"]`);
        if (activeLink) activeLink.classList.add('active');
        // Load data for the view
        if (hash === 'products') await loadProducts();
        else if (hash === 'license') await loadLicenseStatusAdminPage();
        else if (hash === 'categories') { await loadCategories(); await loadUnits(); }
        else if (hash === 'transactions') await loadTransactions();
        else if (hash === 'shifts') await loadShifts();
        else if (hash === 'users') await loadUsers();
        else if (hash === 'customers') await loadCustomers();
        else if (hash === 'suppliers') { await loadSuppliers(); await loadStockInProducts(); await loadStockInHistory(); initStockInView(); }
        else if (hash === 'credits') await loadCredits();
        else if (hash === 'banners') await loadBanner();
        else if (hash === 'qris') await loadQris();
        else if (hash === 'settings') await loadSettings();
        else if (hash === 'backup') await loadAutoBackups();
        else if (hash === 'customer-debts') await loadCustomerDebts();
        // Update URL hash if it was from localStorage
        if (!window.location.hash.substring(1)) {
            window.location.hash = '#' + hash;
        }
    } else {
        // Default to dashboard
        showView('dashboard');
    }
});

async function validateCurrentUserPassword(password) {
    try {
        const res = await fetch('/api/validate-current-user-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const result = await res.json();
        return result.success;
    } catch (error) {
        console.error("Password validation failed:", error);
        return false;
    }
}

function setupNavigation() {
    document.querySelectorAll('.sidebar .nav-link').forEach(link => {
        link.addEventListener('click', async (e) => {
            const el = e.currentTarget;
            const view = el.dataset.view;
            // Jika tidak ada data-view (misal link eksternal ke /pos.html), biarkan default navigate
            if (!view) return; 
            e.preventDefault();
            showView(view);
            document.querySelectorAll('.sidebar .nav-link').forEach(l => l.classList.remove('active'));
            el.classList.add('active');
            if (view === 'dashboard') loadDashboard();
            if (view === 'products') loadProducts();
            if (view === 'license') loadLicenseStatusAdminPage();
            if (view === 'categories') { loadCategories(); loadUnits(); }
            if (view === 'transactions') loadTransactions();
            if (view === 'shifts') loadShifts();
            if (view === 'users') loadUsers();
            if (view === 'suppliers') { await loadSuppliers(); await loadStockInProducts(); initStockInView(); }
            if (view === 'banners') loadBanner();
            if (view === 'qris') loadQris();
            if (view === 'settings') loadSettings();
            if (view === 'backup') loadAutoBackups();

            // On mobile/tablet overlay mode, hide sidebar after navigation
            if (window.innerWidth < 992) {
                document.body.classList.remove('sidebar-visible');
            }
        });
    });
}

function showView(viewId) {
    document.querySelectorAll('.view-content').forEach(view => view.style.display = 'none');
    document.getElementById(`${viewId}-view`).style.display = 'block';
    // Update URL hash to persist view on refresh
    window.location.hash = '#' + viewId;
    // Save to localStorage for additional persistence
    localStorage.setItem('adminLastView', viewId);
    if (viewId === 'dashboard') {
        try { loadLowStock(); } catch(e) { console.warn('loadLowStock failed', e); }
        try { loadExpiredProducts(); } catch(e) { console.warn('loadExpiredProducts failed', e); }
        try {
            const btn = document.getElementById('refreshLowStockBtn');
            if (btn && !btn._lowStockBound) {
                btn.addEventListener('click', loadLowStock);
                btn._lowStockBound = true;
            }
        } catch {}
        try {
            const btn = document.getElementById('refreshExpiredBtn');
            if (btn && !btn._expiredBound) {
                btn.addEventListener('click', loadExpiredProducts);
                btn._expiredBound = true;
            }
        } catch {}
        // Bind export buttons (once)
        try {
            const expLS = document.getElementById('exportLowStockBtn');
            if (expLS && !expLS._bound) { expLS.addEventListener('click', exportLowStockToXlsx); expLS._bound = true; }
        } catch {}
        try {
            const expEX = document.getElementById('exportExpiredBtn');
            if (expEX && !expEX._bound) { expEX.addEventListener('click', exportExpiredToXlsx); expEX._bound = true; }
        } catch {}
    } else {
        // bersihkan lowStock & expired
        const container = document.getElementById('lowStockList');
        if (container) container.innerHTML = '';
        const expired = document.getElementById('expiredList');
        if (expired) expired.innerHTML = '';
    }

    if (viewId === 'license') {
        try { loadLicenseStatusAdminPage(); } catch (e) {}
    }
}

async function loadLicenseStatusAdminPage() {
    try {
        var box = document.getElementById('licenseStatusSummaryBox');
        var statusEl = document.getElementById('licenseStatusAdminPage');
        var input = document.getElementById('licenseKeyInputAdminPage');
        var formWrapper = document.getElementById('licenseFormWrapper');
        var toggleBtn = document.getElementById('licenseToggleFormBtn');
        if (!box) return;
        box.innerHTML = '<p class="text-muted mb-0">Memuat status lisensi...</p>';

        var resp = await fetch('/api/license/status', { headers: { 'Accept': 'application/json' } });
        if (!resp.ok) {
            box.innerHTML = '<div class="alert alert-danger mb-0">Gagal membaca status lisensi</div>';
            return;
        }
        var data = await resp.json();
        var off = data && data.offline;
        var hasKey = !!(data && data.hasKey);
        var keyPreview = (data && data.keyPreview) ? String(data.keyPreview) : '';
        var rem = (data && typeof data.remainingDays === 'number') ? data.remainingDays : null;
        var type = (data && data.licenseType) ? String(data.licenseType) : 'none';
        var runs = data && data.licenseRuns;
        var isActive = !!(off && off.valid);

        var typeLabel = 'Trial / Tidak berlisensi';
        if (type === 'full') typeLabel = 'Full / Lifetime';
        else if (type === 'date') typeLabel = 'Berdasar tanggal';
        else if (type === 'runs') typeLabel = 'Berdasar jumlah buka aplikasi';

        var html = '';
        html += '<ul class="list-unstyled mb-0">';
        html += '<li><strong>Status:</strong> ' + (off && off.valid ? 'AKTIF' : 'TIDAK AKTIF') + '</li>';
        html += '<li><strong>Jenis:</strong> ' + typeLabel + '</li>';
        if (hasKey && keyPreview) {
            html += '<li><strong>Key:</strong> ' + keyPreview + '</li>';
        }
        if (off && off.payload && typeof off.payload.note === 'string') {
            var nm = off.payload.note.trim();
            if (nm) html += '<li><strong>Nama Toko (dari license):</strong> ' + nm.replace(/</g,'&lt;') + '</li>';
        }
        if (off && off.payload && off.payload.exp && type !== 'runs') {
            try {
                var dt = new Date(Number(off.payload.exp));
                if (!Number.isNaN(dt.getTime())) {
                    var dd = String(dt.getDate()).padStart(2,'0');
                    var mm = String(dt.getMonth()+1).padStart(2,'0');
                    var yy = dt.getFullYear();
                    html += '<li><strong>Expired pada:</strong> ' + dd + '-' + mm + '-' + yy + '</li>';
                }
            } catch (e) {}
        }
        if (type === 'runs' && runs && (typeof runs.remainingRuns === 'number' || typeof runs.totalRuns === 'number')) {
            var rRem = (typeof runs.remainingRuns === 'number') ? runs.remainingRuns : null;
            var rTot = (typeof runs.totalRuns === 'number') ? runs.totalRuns : null;
            if (rRem != null && rTot != null) {
                html += '<li><strong>Sisa buka:</strong> ' + rRem + ' / ' + rTot + ' kali</li>';
            } else if (rRem != null) {
                html += '<li><strong>Sisa buka:</strong> ' + rRem + ' kali</li>';
            }
        } else if (rem != null) {
            html += '<li><strong>Sisa hari:</strong> ' + rem + ' hari</li>';
        }
        if (off && !off.valid && off.reason) {
            html += '<li><strong>Alasan:</strong> ' + String(off.reason) + '</li>';
        }
        html += '</ul>';
        box.innerHTML = html;

        if (statusEl) {
            statusEl.textContent = isActive
                ? 'LICENSE KEY aktif. Klik "Ganti LICENSE KEY" untuk mengganti.'
                : 'Silakan masukkan LICENSE KEY baru.';
        }
        if (formWrapper && toggleBtn) {
            if (isActive) {
                formWrapper.style.display = 'none';
                toggleBtn.style.display = '';
                if (input) input.placeholder = 'Masukkan LICENSE KEY baru untuk mengganti';
            } else {
                formWrapper.style.display = '';
                toggleBtn.style.display = 'none';
                if (input) input.placeholder = 'Masukkan LICENSE KEY baru';
            }
        }
    } catch (e) {}
}

document.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'licenseToggleFormBtn') {
        e.preventDefault();
        var wrapper = document.getElementById('licenseFormWrapper');
        var input = document.getElementById('licenseKeyInputAdminPage');
        if (!wrapper) return;
        wrapper.style.display = '';
        if (input) { try { input.focus(); } catch (e2) {} }
        return;
    }
    if (e.target && e.target.id === 'licenseDeleteBtnAdminPage') {
        e.preventDefault();
        (async function () {
            var statusEl = document.getElementById('licenseStatusAdminPage');
            if (!statusEl) return;
            if (!window.confirm('Hapus LICENSE KEY yang terpasang sekarang? Anda harus memasukkan LICENSE KEY baru di halaman login.')) {
                return;
            }
            statusEl.textContent = 'Menghapus LICENSE KEY...';
            try {
                var resp = await fetch('/api/license/offline', {
                    method: 'DELETE',
                    headers: { 'Accept': 'application/json' }
                });
                var data = null;
                try { data = await resp.json(); } catch (e) {}
                if (resp.ok && data && data.success) {
                    statusEl.textContent = data.message || 'LICENSE KEY berhasil dihapus.';
                    // Segarkan ringkasan dan reload agar badge/license di seluruh aplikasi ikut terupdate
                    try { await loadLicenseStatusAdminPage(); } catch (e3) {}
                    setTimeout(function () {
                        try { window.location.reload(); } catch (e4) {}
                    }, 400);
                } else {
                    var msg = (data && data.message) ? data.message : 'Gagal menghapus LICENSE KEY';
                    statusEl.textContent = msg;
                }
            } catch (err) {
                statusEl.textContent = 'Gagal menghapus LICENSE KEY';
            }
        })();
        return;
    }
    if (e.target && e.target.id === 'licenseSaveBtnAdminPage') {
        e.preventDefault();
        (async function () {
            var input = document.getElementById('licenseKeyInputAdminPage');
            var statusEl = document.getElementById('licenseStatusAdminPage');
            if (!input || !statusEl) return;
            var key = String(input.value || '').trim();
            if (!key) {
                statusEl.textContent = 'LICENSE KEY wajib diisi';
                return;
            }
            statusEl.textContent = 'Memeriksa LICENSE KEY...';
            try {
                var resp = await fetch('/api/license/offline', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ licenseKey: key })
                });
                var data = null;
                try { data = await resp.json(); } catch (e) {}
                if (resp.ok && data && data.success) {
                    statusEl.textContent = 'LICENSE KEY tersimpan dan valid.';
                    input.value = '';
                    // refresh ringkasan (opsional, sebelum reload)
                    try { await loadLicenseStatusAdminPage(); } catch (e3) {}
                    // Reload halaman agar seluruh status (badge trial/license, nama toko, dll) terupdate
                    setTimeout(function () {
                        try { window.location.reload(); } catch (e4) {}
                    }, 400);
                } else {
                    var msg = (data && data.message) ? data.message : 'LICENSE KEY tidak valid';
                    statusEl.textContent = msg;
                }
            } catch (err) {
                statusEl.textContent = 'Gagal memproses LICENSE KEY';
            }
        })();
    }
});

function setupLogout() {
    document.getElementById('logoutBtn')?.addEventListener('click', async () => {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/login.html';
    });
}

function setupDarkModeToggle() {
    const darkModeToggle = document.getElementById('darkModeToggle');
    
    if (darkModeToggle) {
        // Set initial state based on saved localStorage first, then current theme
        const savedDarkMode = localStorage.getItem('admin_darkMode') === 'true';
        const isDark = savedDarkMode || document.body.classList.contains('dark');
        
        if (isDark) {
            document.body.classList.add('dark');
        }
        darkModeToggle.checked = isDark;
        
        // Add change event listener (checkbox change event)
        darkModeToggle.addEventListener('change', async () => {
            const isDark = darkModeToggle.checked;
            
            if (isDark) {
                document.body.classList.add('dark');
            } else {
                document.body.classList.remove('dark');
            }
            
            // Save to localStorage for immediate persistency
            localStorage.setItem('admin_darkMode', isDark.toString());
            
            // Save to settings
            try {
                // Ensure appSettings is loaded
                if (!appSettings) {
                    await loadSettings();
                }
                const settings = { ...appSettings };
                settings.darkMode = isDark;
                await fetch('/api/settings', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(settings)
                });
                
                // Update appSettings locally
                appSettings.darkMode = isDark;
                
                // Update checkbox in settings if it exists
                const darkModeCheckbox = document.getElementById('darkMode');
                if (darkModeCheckbox) {
                    darkModeCheckbox.checked = isDark;
                }
            } catch (e) {
                console.warn('Failed to save dark mode setting:', e);
            }
        });
    }
}

// --- Low Stock (Dashboard) ---
let lowStockData = [];
let lowStockPage = 1;
let lowStockPageSize = 10; // number or 'all'

async function loadLowStock() {
    const container = document.getElementById('lowStockList');
    if (!container) return;
    container.innerHTML = '<p class="text-muted mb-0">Memuat data stok rendah...</p>';
    try {
        const res = await fetch('/api/products', { cache: 'no-store' });
        const data = await res.json();
        const arr = Array.isArray(data) ? data : [];
        lowStockData = arr
            .filter(p => Number(p.stock||0) <= 0 || Number(p.stock||0) < 5)
            .sort((a,b)=> (Number(a.stock||0)) - (Number(b.stock||0)))
            .slice(0, 1000);

        // Setup page size selector once
        try {
            const sel = document.getElementById('lowStockPageSize');
            if (sel && !sel.dataset.bound) {
                sel.dataset.bound = '1';
                sel.addEventListener('change', () => {
                    const v = sel.value;
                    lowStockPageSize = (v === 'all') ? 'all' : Math.max(1, parseInt(v)||10);
                    lowStockPage = 1;
                    renderLowStock();
                });
            }
        } catch {}

        renderLowStock();
    } catch (e) {
        container.innerHTML = '<p class="text-danger mb-0">Gagal memuat data stok rendah.</p>';
    }
}

function renderLowStock() {
    const container = document.getElementById('lowStockList');
    if (!container) return;
    const list = Array.isArray(lowStockData) ? lowStockData : [];
    if (list.length === 0) {
        container.innerHTML = '<p class="text-muted mb-0">Semua stok aman.</p>';
        const pTop = document.getElementById('lowStockPaginationTop'); if (pTop) pTop.innerHTML = '';
        const pBot = document.getElementById('lowStockPaginationBottom'); if (pBot) pBot.innerHTML = '';
        return;
    }

    // Pagination logic
    let pageItems = list;
    if (lowStockPageSize !== 'all') {
        const start = (lowStockPage - 1) * lowStockPageSize;
        pageItems = list.slice(start, start + lowStockPageSize);
    }

    const rows = pageItems.map(p => {
        const stock = Number(p.stock||0);
        const badge = stock <= 0 ? '<span class="badge bg-secondary">HABIS</span>' : `<span class="badge bg-warning text-dark">Sisa ${stock}</span>`;
        const name = (p.name || 'Produk');
        const sku = p.sku ? ` <small class="text-muted">(${p.sku})</small>` : '';
        return `<li class="list-group-item d-flex justify-content-between align-items-center">
            <span>${name}${sku}</span>
            ${badge}
        </li>`;
    }).join('');
    container.innerHTML = `<ul class="list-group list-group-flush">${rows}</ul>`;

    // Render pagination controls
    const totalPages = (lowStockPageSize === 'all') ? 1 : Math.max(1, Math.ceil(list.length / lowStockPageSize));
    const pages = generateMinimalPaginationLinks(lowStockPage, totalPages);
    const html = pages.map(p => {
        if (p === '...') return `<span class="mx-1 text-muted">…</span>`;
        const active = (p === lowStockPage) ? 'active' : '';
        return `<button class="btn btn-sm btn-outline-secondary ${active}" data-page="${p}">${p}</button>`;
    }).join(' ');
    const pTop = document.getElementById('lowStockPaginationTop');
    const pBot = document.getElementById('lowStockPaginationBottom');
    if (pTop) pTop.innerHTML = html;
    if (pBot) pBot.innerHTML = html;

    // Bind click handlers
    [pTop, pBot].forEach(nav => {
        if (!nav) return;
        Array.from(nav.querySelectorAll('button[data-page]')).forEach(btn => {
            btn.addEventListener('click', (e) => {
                const pg = parseInt(e.currentTarget.getAttribute('data-page'));
                if (!isNaN(pg)) { lowStockPage = pg; renderLowStock(); }
            });
        });
    });
}

// --- Cleanup function ---
function cleanupAdmin() {
    // Clear all debounce timers
    Object.keys(searchDebounceTimers).forEach(key => {
        if (searchDebounceTimers[key]) {
            clearTimeout(searchDebounceTimers[key]);
            searchDebounceTimers[key] = null;
        }
    });
    
    // Reset rendering flags
    Object.keys(isRendering).forEach(key => {
        isRendering[key] = false;
    });
}

// Fungsi untuk mendapatkan user info dari berbagai sumber
async function getCurrentUserInfo() {
    // Method 1: Coba API endpoints
    const endpoints = ['/api/current-user', '/api/user/me', '/api/auth/me', '/api/me', '/api/users/me'];
    
    for (const endpoint of endpoints) {
        try {
            const res = await fetch(endpoint, { cache: 'no-store' });
            if (res.ok) {
                const user = await res.json();
                                return user;
            }
        } catch (e) {
            continue;
        }
    }
    
    // Method 2: Coba global variables
    if (window.currentUser) {
                return window.currentUser;
    }
    
    if (typeof user !== 'undefined' && user) {
                return user;
    }
    
    // Method 3: Coba dari localStorage/sessionStorage
    try {
        const storedUser = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
        if (storedUser) {
            const user = JSON.parse(storedUser);
                        return user;
        }
    } catch (e) {}
    
    // Method 4: Coba dari document (server-side injection)
    try {
        // Cari di semua script tags
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const content = script.textContent || script.innerHTML;
            if (content.includes('currentUser') || content.includes('user')) {
                                // Coba ekstrak user data dari script
                const matches = content.match(/(?:currentUser|user)\s*[:=]\s*({[^}]+})/i);
                if (matches && matches[1]) {
                    try {
                        const user = JSON.parse(matches[1]);
                                                return user;
                    } catch (e) {}
                }
            }
        }
        
        // Coba di meta tags
        const metaTags = document.querySelectorAll('meta');
        for (const meta of metaTags) {
            if (meta.name && meta.name.includes('user')) {
                                try {
                    const user = JSON.parse(meta.content);
                    return user;
                } catch (e) {}
            }
        }
        
        // Cari di hidden input elements
        const hiddenInputs = document.querySelectorAll('input[type="hidden"]');
        for (const input of hiddenInputs) {
            if (input.id && input.id.includes('user')) {
                                try {
                    const user = JSON.parse(input.value);
                    return user;
                } catch (e) {}
            }
        }
    } catch (e) {}
    
    // Method 5: Coba dari document title atau page content
    try {
        const title = document.title;
        if (title && title !== 'Admin Panel') {
                        // Pisahkan nama toko dan "Admin Panel"
            if (title.includes(' - Admin Panel')) {
                const storeName = title.replace(' - Admin Panel', '');
                                // Jangan return store name sebagai user name, lanjut ke method lain
            } else {
                return { name: title };
            }
        }
    } catch (e) {}
    
    // Method 6: Coba dari cookies
    try {
        const cookies = document.cookie.split(';');
        for (const cookie of cookies) {
            const [name, value] = cookie.trim().split('=');
            if (name && (name.includes('user') || name.includes('session') || name.includes('auth'))) {
                                try {
                    const decoded = decodeURIComponent(value);
                    if (decoded.startsWith('{')) {
                        const user = JSON.parse(decoded);
                        return user;
                    }
                } catch (e) {}
            }
        }
    } catch (e) {}
    
    // Method 7: Fallback - coba dari URL parameters atau gunakan default
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const userParam = urlParams.get('user') || urlParams.get('username') || urlParams.get('name');
        if (userParam) {
                        return { name: userParam };
        }
    } catch (e) {}
    
    // Method 8: Check admin name from license settings
    try {
        if (appSettings && appSettings.adminName) {
            const licenseAdminName = appSettings.adminName.trim();
            if (licenseAdminName) {
                                return { name: licenseAdminName };
            }
        }
    } catch (e) {}
    
    // Method 9: Fallback - coba localStorage untuk custom admin name
    try {
        const customAdminName = localStorage.getItem('customAdminName');
        if (customAdminName) {
                        return { name: customAdminName };
        }
    } catch (e) {}
    
    // Method 10: Last resort - prompt untuk input nama admin (hanya sekali)
    try {
        const hasPrompted = sessionStorage.getItem('adminNamePrompted');
        if (!hasPrompted) {
            const adminName = prompt('Masukkan nama lengkap admin yang akan ditampilkan di navbar:', 'Admin');
            if (adminName && adminName.trim() && adminName !== 'Admin') {
                localStorage.setItem('customAdminName', adminName.trim());
                sessionStorage.setItem('adminNamePrompted', 'true');
                                return { name: adminName.trim() };
            }
            sessionStorage.setItem('adminNamePrompted', 'true');
        }
    } catch (e) {}
    
        return null;
}

async function loadInitialData() {
    try {
        // Load current user info for navbar
        try {
            const currentUser = await getCurrentUserInfo();
            
            // Update navbar dengan nama lengkap
            const userNameEl = document.getElementById('userName');
            if (userNameEl && currentUser) {
                // Debug: Tampilkan semua field yang tersedia
                                                
                // Prioritaskan nama lengkap, bukan role
                const displayName = currentUser.name || 
                                  currentUser.fullName || 
                                  currentUser.displayName || 
                                  currentUser.first_name || 
                                  currentUser.lastName ||
                                  currentUser.username ||
                                  currentUser.email ||
                                  'Admin';
                
                // Jika yang tampil masih role, filter out role values
                const filteredName = (displayName === 'admin' || displayName === 'cashier' || displayName === 'user') ? 'Admin' : displayName;
                
                userNameEl.textContent = filteredName;
                            } else if (userNameEl) {
                userNameEl.textContent = 'Admin';
                            }
        } catch (e) {
            console.warn('[USER INFO] Failed to load current user info:', e);
            const userNameEl = document.getElementById('userName');
            if (userNameEl) userNameEl.textContent = 'Admin';
        }
        
        const res = await fetch('/api/categories', { cache: 'no-store' });
        if (!res.ok) throw new Error('Gagal memuat kategori');
        const data = await res.json();
        
        // PERBAIKAN: Validasi data kategori
        if (!Array.isArray(data)) {
            console.warn('Categories data is not an array, using empty array');
            categories = [];
        } else {
            categories = data;
        }
        
        const productCategorySelect = document.getElementById('productCategory');
        if (productCategorySelect) {
            productCategorySelect.innerHTML = '<option value="">Pilih Kategori</option>' +
                categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
        }
        const productCategoryFilter = document.getElementById('productCategoryFilter');
        if (productCategoryFilter) {
            productCategoryFilter.innerHTML = '<option value="">Semua Kategori</option>' +
                categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
            productCategoryFilter.value = productCategoryFilterValue || '';
            productCategoryFilter.addEventListener('change', () => {
                productCategoryFilterValue = productCategoryFilter.value;
                currentPage = 1;
                try { localStorage.setItem('productsCurrentPage', '1'); } catch {}
                renderProducts();
            });
        }
    } catch (error) {
        console.error('Gagal memuat data awal:', error);
        // Set empty array to prevent errors
        categories = [];
    }
}

// PERBAIKAN: Cleanup saat halaman ditutup
window.addEventListener('beforeunload', cleanupAdmin);
window.addEventListener('pagehide', cleanupAdmin);

// --- Produk ---
async function loadProducts() {
    try {
        const res = await fetch('/api/products', { cache: 'no-store' });
        if (!res.ok) throw new Error('Gagal memuat produk');
        const data = await res.json();
        
        // PERBAIKAN: Validasi data produk
        if (!Array.isArray(data)) {
            console.warn('Products data is not an array, using empty array');
            products = [];
        } else {
            products = data;
        }
        // Sort newest -> oldest by updatedAt/createdAt/timestamp/id
        try {
            const ts = v => {
                const cands = [v?.updatedAt, v?.createdAt, v?.created_at, v?.timestamp, v?.id];
                for (const x of cands) { if (x != null) { const n = new Date(x).valueOf(); if (!isNaN(n)) return n; if (typeof x === 'number') return x; } }
                return 0;
            };
            products = (products || []).slice().sort((a,b)=> ts(b) - ts(a));
        } catch {}
        
        // Populate category filter options based on categories present in products
        const productCategoryFilter = document.getElementById('productCategoryFilter');
        if (productCategoryFilter) {
            const presentIds = new Set(
                (products || [])
                    .map(p => (p.categoryId != null ? String(p.categoryId) : ''))
                    .filter(id => id && id !== 'null' && id !== 'undefined')
            );
            const opts = Array.from(presentIds).map(id => {
                const cat = (categories || []).find(c => String(c.id) === id);
                return { id, name: cat ? cat.name : `Kategori ${id}` };
            });
            productCategoryFilter.innerHTML = '<option value="">Semua Kategori</option>' +
                opts.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
            if (!presentIds.has(String(productCategoryFilterValue))) {
                productCategoryFilterValue = '';
            }
            productCategoryFilter.value = productCategoryFilterValue;
        }
        // Restore current page from localStorage on load
        try {
            const savedPg = parseInt(localStorage.getItem('productsCurrentPage')||'1');
            currentPage = isNaN(savedPg) ? 1 : savedPg;
        } catch { currentPage = 1; }
        renderProducts();
    } catch (error) {
        console.error('Gagal memuat produk:', error);
        const tbody = document.getElementById('productTableBody');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="13" class="text-center text-danger">Gagal memuat produk. Silakan refresh halaman.</td></tr>`;
        }
        // Set empty array to prevent errors
        products = [];
    }
}

function getFilteredProducts() {
    let filtered = products || [];
    // Apply category filter first
    if (productCategoryFilterValue) {
        filtered = filtered.filter(p => String(p.categoryId) === String(productCategoryFilterValue));
    }
    // Apply text search if present
    if (searchTerm) {
        const term = searchTerm.toString().toLowerCase().trim();
        filtered = filtered.filter(product => {
            const nameMatch = (product.name || '').toString().toLowerCase().includes(term);
            const skuMatch = (product.sku || '').toString().toLowerCase().includes(term);
            const qrMatch = (product.qrCode || '').toString().toLowerCase().includes(term);
            const category = categories.find(c => c.id === product.categoryId);
            const catMatch = category && (category.name || '').toString().toLowerCase().includes(term);
            return nameMatch || skuMatch || qrMatch || catMatch;
        });
    }
    return filtered;
}

function getPaginatedProducts() {
    const filteredProducts = getFilteredProducts();
    if (pageSize === 'all') return filteredProducts;
    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    return filteredProducts.slice(startIndex, endIndex);
}

function renderProducts() {
    // PERBAIKAN: Prevent concurrent renders
    if (isRendering.products) {
        console.warn('Products render already in progress, skipping...');
        return;
    }
    isRendering.products = true;
    
    const tbody = document.getElementById('productTableBody');
    if (!tbody) {
        isRendering.products = false;
        return;
    }
    
    try {
        const paginatedProducts = getPaginatedProducts();
        if (paginatedProducts.length === 0) {
            tbody.innerHTML = `<tr><td colspan="15" class="text-center">Tidak ada produk ditemukan.</td></tr>`;
            const paginationTop = document.getElementById('paginationTop');
            const paginationBottom = document.getElementById('paginationBottom');
            if (paginationTop) paginationTop.innerHTML = '';
            if (paginationBottom) paginationBottom.innerHTML = '';
            isRendering.products = false;
            return;
        }
    const startIndex = pageSize === 'all' ? 0 : (currentPage - 1) * pageSize;
    tbody.innerHTML = paginatedProducts.map((p, idx) => {
        const no = startIndex + idx + 1;
        const buy = (p.purchasePrice != null && !isNaN(p.purchasePrice)) ? p.purchasePrice : 0;
        const sellVal = (p.sellingPrice != null ? p.sellingPrice : p.price);
        const sell = (sellVal != null && !isNaN(sellVal)) ? sellVal : 0;
        const priceBuyDisplay = formatCurrency(buy);
        const priceSellDisplay = formatCurrency(sell);
        const diff = sell - buy;
        const diffSign = diff > 0 ? '+' : (diff < 0 ? '-' : '');
        const diffAbs = Math.abs(diff);
        const diffDisplay = `${diffSign} ${formatCurrency(diffAbs)}`;
        const diffClass = diff > 0 ? 'text-success' : (diff < 0 ? 'text-danger' : 'text-muted');
        const taxPct = (p.taxRate != null && !isNaN(p.taxRate)) ? Number(p.taxRate) : 0;
        const discPct = (p.discountPercent != null && !isNaN(p.discountPercent)) ? Number(p.discountPercent) : 0;
        const qr = (p.qrCode || '').toString();
        const qrShort = qr.length > 12 ? qr.slice(0, 12) + '…' : qr;
        const expRaw = p.expiryDate || p.expireDate || p.exp || '';
        let expDisplay = '-';
        let expBadge = '';
        if (expRaw) {
            try {
                const d = new Date(expRaw);
                if (!isNaN(d.getTime())) {
                    expDisplay = d.toISOString().slice(0,10);
                    const today = new Date(); today.setHours(0,0,0,0);
                    const expDay = new Date(d); expDay.setHours(0,0,0,0);
                    const diffDays = Math.ceil((expDay - today) / 86400000);
                    if (diffDays < 0) {
                        expBadge = '<span class="badge bg-danger ms-1">EXPIRED</span>';
                    } else if (diffDays <= 7) {
                        const title = `${expDisplay} (sisa ${diffDays} hari)`;
                        expBadge = `<span class="badge bg-warning text-dark ms-1" title="${title}">EXP</span>`;
                    } else {
                        expBadge = '';
                    }
                } else {
                    expDisplay = String(expRaw);
                    expBadge = '';
                }
            } catch {
                expDisplay = String(expRaw);
                expBadge = '';
            }
        }
        const badges = [
            p.isTopProduct ? '<span class="badge bg-warning text-dark me-1">TOP</span>' : '',
            p.isBestSeller ? '<span class="badge bg-primary me-1">BEST</span>' : '',
            (p.isDiscounted || (Number(p.discountPercent||0) > 0)) ? '<span class="badge bg-danger me-1">DISKON</span>' : '',
            expBadge,
            (Number(p.stock) <= 0) ? '<span class="badge bg-secondary">HABIS</span>' : ''
        ].join('');
        const category = categories.find(c => c.id == p.categoryId);
        const categoryName = category ? category.name : '-';
        return `
        <tr>
            <td>
                <input type="checkbox" class="product-select custom-checkbox-input" data-id="${p.id}" style="display: none;" id="product-check-${p.id}">
                <label for="product-check-${p.id}" class="custom-checkbox">
                    <svg width="18px" height="18px" viewBox="0 0 18 18">
                        <path d="M1,9 L1,3.5 C1,2 2,1 3.5,1 L14.5,1 C16,1 17,2 17,3.5 L17,14.5 C17,16 16,17 14.5,17 L3.5,17 C2,17 1,16 1,14.5 L1,9 Z"></path>
                        <polyline points="1 9 7 14 15 4"></polyline>
                    </svg>
                </label>
            </td>
            <td>${no}</td>
            <td>${p.id ?? ''}</td>
            <td>${p.sku ?? ''}</td>
            <td title="${(p.name ?? '').replace(/"/g, '&quot;')}">${p.name ?? ''}</td>
            <td>${(categories.find(c => c.id == p.categoryId)?.name) || ''}</td>
            <td>${priceBuyDisplay}</td>
            <td>${priceSellDisplay}</td>
            <td><span class="${diffClass}">${diffDisplay}</span></td>
            <td>${taxPct}%</td>
            <td>${discPct}%</td>
            <td>${qrShort}</td>
            <td>${expDisplay}</td>
            <td>${Number(p.stock||0)}</td>
            <td>${badges}</td>
            <td>
                <button class="edit-btn me-2" onclick="openEditProduct(${p.id})" title="Edit Produk">
                    <svg viewBox="0 0 512 512" class="svgIcon">
                        <path d="M410.3 231l11.3-11.3-33.9-33.9-11.3 11.3-22.6 22.6L290.3 274.2 265.8 249.7l-33.9 33.9 24.5 24.5-67.9 67.9L120 496c-4.5 4.5-10.6 7-17 7s-12.5-2.5-17-7l-48-48c-4.5-4.5-7-10.6-7-17s2.5-12.5 7-17l120.5-120.5 24.5 24.5 33.9-33.9-24.5-24.5 67.9-67.9 11.3-11.3 33.9 33.9-11.3 11.3 22.6 22.6L410.3 231zM160 464l-48-48 96-96 48 48-96 96z"></path>
                    </svg>
                </button>
                <button class="delete-btn" onclick="deleteProduct(${p.id})" title="Hapus Produk">
                    <svg viewBox="0 0 448 512" class="svgIcon">
                        <path d="M135.2 17.7L128 32H32C14.3 32 0 46.3 0 64S14.3 96 32 96H416c17.7 0 32-14.3 32-32s-14.3-32-32-32H320l-7.2-14.3C307.4 6.8 296.3 0 284.2 0H163.8c-12.1 0-23.2 6.8-28.6 17.7zM416 128H32L53.2 467c1.6 25.3 22.6 45 47.9 45H346.9c25.3 0 46.3-19.7 47.9-45L416 128z"></path>
                    </svg>
                </button>
            </td>
        </tr>`;
    }).join('');
        renderPagination();

        // Bind select-all checkbox to current page items
        const selectAll = document.getElementById('selectAllProducts');
        if (selectAll) {
            selectAll.checked = false;
            selectAll.onchange = () => {
                document.querySelectorAll('#productTableBody .custom-checkbox-input').forEach(cb => cb.checked = selectAll.checked);
            };
            
            // Update select-all checkbox when individual checkboxes change
            const updateSelectAll = () => {
                const checkboxes = document.querySelectorAll('#productTableBody .custom-checkbox-input');
                const checkedBoxes = document.querySelectorAll('#productTableBody .custom-checkbox-input:checked');
                if (checkboxes.length === 0) {
                    selectAll.checked = false;
                    selectAll.indeterminate = false;
                } else if (checkedBoxes.length === checkboxes.length) {
                    selectAll.checked = true;
                    selectAll.indeterminate = false;
                } else if (checkedBoxes.length > 0) {
                    selectAll.checked = false;
                    selectAll.indeterminate = true;
                } else {
                    selectAll.checked = false;
                    selectAll.indeterminate = false;
                }
            };
            
            // Add event listeners to individual checkboxes
            document.querySelectorAll('#productTableBody .custom-checkbox-input').forEach(cb => {
                cb.addEventListener('change', updateSelectAll);
            });
        }
    } catch (error) {
        console.error('Error rendering products:', error);
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="14" class="text-center text-danger">Error rendering products</td></tr>`;
        }
    } finally {
        isRendering.products = false;
    }
}

function renderPagination() {
    const filteredProducts = getFilteredProducts();
    const totalItems = filteredProducts.length;
    const paginationTop = document.getElementById('paginationTop');
    const paginationBottom = document.getElementById('paginationBottom');
    if (pageSize === 'all' || totalItems <= pageSize) {
        paginationTop.innerHTML = '';
        paginationBottom.innerHTML = '';
        return;
    }
    const totalPages = Math.ceil(totalItems / pageSize);
    if (currentPage > totalPages) {
        currentPage = totalPages;
    }
    if (currentPage < 1) {
        currentPage = 1;
    }
    try { localStorage.setItem('productsCurrentPage', String(currentPage)); } catch {}
    let paginationHTML = `<ul class="pagination mb-0 justify-content-center">`;
    paginationHTML += `<li class="page-item ${currentPage === 1 ? 'disabled' : ''}">
        <a class="page-link" href="#" data-page="${currentPage - 1}">Sebelumnya</a></li>`;
    const pageLinks = generateMinimalPaginationLinks(currentPage, totalPages);
    for (const p of pageLinks) {
        if (p === '...') {
            paginationHTML += `<li class="page-item disabled"><span class="page-link">...</span></li>`;
        } else {
            paginationHTML += `<li class="page-item ${currentPage === p ? 'active' : ''}">
                <a class="page-link" href="#" data-page="${p}">${p}</a></li>`;
        }
    }
    paginationHTML += `<li class="page-item ${currentPage === totalPages ? 'disabled' : ''}">
        <a class="page-link" href="#" data-page="${currentPage + 1}">Selanjutnya</a></li>`;
    paginationHTML += `</ul>`;
    paginationTop.innerHTML = paginationHTML;
    paginationBottom.innerHTML = paginationHTML;
    // Bind click handlers to persist and navigate
    [paginationTop, paginationBottom].forEach(nav => {
        if (!nav) return;
        Array.from(nav.querySelectorAll('a.page-link[data-page]')).forEach(a => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                const p = parseInt(a.getAttribute('data-page'));
                if (!isNaN(p)) {
                    currentPage = p;
                    try { localStorage.setItem('productsCurrentPage', String(currentPage)); } catch {}
                    renderProducts();
                }
            });
        });
    });
}

// --- Kategori ---
async function loadCategories() {
    try {
        const res = await fetch('/api/categories', { cache: 'no-store' });
        if (!res.ok) throw new Error('Gagal memuat kategori');
        const allCategories = await res.json();
        
        // PERBAIKAN: Validasi data kategori
        if (!Array.isArray(allCategories)) {
            console.warn('Categories data is not an array, using empty array');
            categories = [];
            categoryCurrentPage = 1;
            renderCategories();
            return;
        }
        
        let productsData = [];
        try {
            const productsRes = await fetch('/api/products', { cache: 'no-store' });
            if (productsRes.ok) {
                const productsJson = await productsRes.json();
                productsData = Array.isArray(productsJson) ? productsJson : [];
            }
        } catch (e) {
            console.warn('Failed to load products for category count:', e);
        }
        
        categories = allCategories.map(category => {
            const productCount = productsData.filter(p => p.categoryId == category.id).length;
            return { ...category, productCount };
        });
        // Sort newest -> oldest by updatedAt/createdAt/id
        try {
            const ts = v => {
                const cands = [v?.updatedAt, v?.createdAt, v?.created_at, v?.timestamp, v?.id];
                for (const x of cands) { if (x != null) { const n = new Date(x).valueOf(); if (!isNaN(n)) return n; if (typeof x === 'number') return x; } }
                return 0;
            };
            categories = (categories || []).slice().sort((a,b)=> ts(b) - ts(a));
        } catch {}
        categoryCurrentPage = 1;
        renderCategories();
        // Populate dropdown in product modal too and try apply selection
        populateProductCategorySelect();
        applyDesiredCategorySelection(__desiredCategoryId);
        __desiredCategoryId = null; // clear after applying
    } catch (error) {
        console.error('Gagal memuat kategori:', error);
        const tbody = document.getElementById('categoryTableBody');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center text-danger">Gagal memuat kategori. Silakan refresh halaman.</td></tr>`;
        }
        // Set empty array to prevent errors
        categories = [];
    }
}

function getFilteredCategories() {
    if (!categorySearchTerm) return categories;
    const lowerCaseSearchTerm = categorySearchTerm.toLowerCase();
    return categories.filter(category => {
        const nameMatch = category.name && category.name.toLowerCase().includes(lowerCaseSearchTerm);
        const descMatch = category.description && category.description.toLowerCase().includes(lowerCaseSearchTerm);
        return nameMatch || descMatch;
    });
}

function getPaginatedCategories() {
    const filtered = getFilteredCategories();
    if (categoryPageSize === 'all') return filtered;
    const start = (categoryCurrentPage - 1) * categoryPageSize;
    return filtered.slice(start, start + categoryPageSize);
}

function renderCategories() {
    const tbody = document.getElementById('categoryTableBody');
    if (!tbody) return;
    const paginated = getPaginatedCategories();
    if (paginated.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center">Tidak ada kategori ditemukan.</td></tr>`;
        document.getElementById('categoryPaginationTop').innerHTML = '';
        document.getElementById('categoryPaginationBottom').innerHTML = '';
        return;
    }
    const start = categoryPageSize === 'all' ? 0 : (categoryCurrentPage - 1) * categoryPageSize;
    tbody.innerHTML = paginated.map((c, idx) => `
        <tr>
            <td>${start + idx + 1}</td>
            <td>${c.id || ''}</td>
            <td>${c.name || ''}</td>
            <td>${c.description || '-'}</td>
            <td><span class="badge bg-info">${c.productCount || 0} Produk</span></td>
            <td>
                <button class="btn btn-sm btn-warning" onclick="openEditModal('category', '${c.id}')">Edit</button>
                <button class="btn btn-sm btn-danger" onclick="deleteItem('categories', '${c.id}')" 
                    ${c.productCount > 0 ? 'disabled title="Kategori masih digunakan oleh produk"' : ''}>Hapus</button>
            </td>
        </tr>`).join('');
    renderCategoryPagination();
}

function renderCategoryPagination() {
    const filtered = getFilteredCategories();
    const total = filtered.length;
    const top = document.getElementById('categoryPaginationTop');
    const bottom = document.getElementById('categoryPaginationBottom');
    if (categoryPageSize === 'all' || total <= categoryPageSize) {
        top.innerHTML = '';
        bottom.innerHTML = '';
        return;
    }
    const pages = Math.ceil(total / categoryPageSize);
    let html = `<ul class="pagination mb-0 justify-content-center">`;
    html += `<li class="page-item ${categoryCurrentPage === 1 ? 'disabled' : ''}>
        <a class="page-link" href="#" data-page="${categoryCurrentPage - 1}">Sebelumnya</a></li>`;
    const pageLinks = generateMinimalPaginationLinks(categoryCurrentPage, pages);
    for (const p of pageLinks) {
        if (p === '...') {
            html += `<li class="page-item disabled"><span class="page-link">...</span></li>`;
        } else {
            html += `<li class="page-item ${categoryCurrentPage === p ? 'active' : ''}">
                <a class="page-link" href="#" data-page="${p}">${p}</a></li>`;
        }
    }
    html += `<li class="page-item ${categoryCurrentPage === pages ? 'disabled' : ''}>
        <a class="page-link" href="#" data-page="${categoryCurrentPage + 1}">Selanjutnya</a></li>`;
    html += `</ul>`;
    top.innerHTML = html;
    bottom.innerHTML = html;
}

// --- Units (Satuan) ---
let units = [];
let unitCurrentPage = 1;
let unitPageSize = 10;
let unitSearchTerm = '';

async function loadUnits() {
    try {
        const res = await fetch('/api/units', { cache: 'no-store' });
        if (!res.ok) throw new Error('Gagal memuat satuan');
        units = await res.json();
        // Sort newest first (by updatedAt/createdAt/id)
        try {
            const ts = v => { const c=[v?.updatedAt,v?.createdAt,v?.id]; for (const x of c){ if (x!=null){ const n=new Date(x).valueOf(); if(!isNaN(n)) return n; if(typeof x==='number') return x; } } return 0; };
            units = (units||[]).slice().sort((a,b)=>ts(b)-ts(a));
        } catch {}
        unitCurrentPage = 1;
        renderUnits();
    } catch (e) {
        console.error('Gagal memuat satuan:', e);
        const tbody = document.getElementById('unitTableBody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">Gagal memuat satuan</td></tr>`;
        units = [];
    }
}

function getFilteredUnits() {
    if (!unitSearchTerm) return units || [];
    const t = unitSearchTerm.toLowerCase();
    return (units||[]).filter(u => (u.name||'').toLowerCase().includes(t) || (u.description||'').toLowerCase().includes(t));
}

function getPaginatedUnits() {
    const filtered = getFilteredUnits();
    if (unitPageSize === 'all') return filtered;
    const start = (unitCurrentPage - 1) * unitPageSize;
    return filtered.slice(start, start + unitPageSize);
}

function renderUnits() {
    const tbody = document.getElementById('unitTableBody');
    if (!tbody) return;
    const paginated = getPaginatedUnits();
    if (paginated.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center">Tidak ada satuan ditemukan.</td></tr>`;
        const top = document.getElementById('unitPaginationTop'); if (top) top.innerHTML = '';
        const bottom = document.getElementById('unitPaginationBottom'); if (bottom) bottom.innerHTML = '';
        return;
    }
    const start = unitPageSize === 'all' ? 0 : (unitCurrentPage - 1) * unitPageSize;
    tbody.innerHTML = paginated.map((u, idx) => `
        <tr>
          <td>${start + idx + 1}</td>
          <td>${u.id || ''}</td>
          <td>${u.name || ''}</td>
          <td>${u.description || '-'}</td>
          <td>
            <button class="btn btn-sm btn-warning" onclick="openEditModal('unit', '${u.id}')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteItem('units', '${u.id}')">Hapus</button>
          </td>
        </tr>
    `).join('');
    renderUnitPagination();
}

function renderUnitPagination() {
    const filtered = getFilteredUnits();
    const total = filtered.length;
    const top = document.getElementById('unitPaginationTop');
    const bottom = document.getElementById('unitPaginationBottom');
    if (unitPageSize === 'all' || total <= unitPageSize) {
        if (top) top.innerHTML = '';
        if (bottom) bottom.innerHTML = '';
        return;
    }
    const pages = Math.ceil(total / unitPageSize);
    if (unitCurrentPage > pages) unitCurrentPage = pages;
    if (unitCurrentPage < 1) unitCurrentPage = 1;
    let html = `<ul class="pagination mb-0 justify-content-center">`;
    html += `<li class="page-item ${unitCurrentPage === 1 ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${unitCurrentPage - 1}">Sebelumnya</a></li>`;
    const pageLinks = generateMinimalPaginationLinks(unitCurrentPage, pages);
    for (const p of pageLinks) {
        if (p === '...') html += `<li class="page-item disabled"><span class="page-link">...</span></li>`;
        else html += `<li class="page-item ${unitCurrentPage === p ? 'active' : ''}"><a class="page-link" href="#" data-page="${p}">${p}</a></li>`;
    }
    html += `<li class="page-item ${unitCurrentPage === pages ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${unitCurrentPage + 1}">Selanjutnya</a></li>`;
    html += `</ul>`;
    if (top) top.innerHTML = html;
    if (bottom) bottom.innerHTML = html;
}

// Units modal & CRUD helpers
function openUnitForm(data) {
    const id = document.getElementById('unitId'); if (id) id.value = data?.id || '';
    const name = document.getElementById('unitName'); if (name) name.value = data?.name || '';
    const desc = document.getElementById('unitDescription'); if (desc) desc.value = data?.description || '';
}

async function saveUnit() {
    const id = (document.getElementById('unitId')?.value || '').trim();
    const name = (document.getElementById('unitName')?.value || '').trim();
    const description = (document.getElementById('unitDescription')?.value || '').trim();
    if (!name) { alert('Nama satuan wajib diisi!'); return; }
    const btn = document.getElementById('saveUnitBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Menyimpan...'; }
    try {
        await ensureCsrfTokenReady();
        const token = (window.csrfToken||'');
        const url = id ? `/api/units/${id}` : '/api/units';
        const method = id ? 'PUT' : 'POST';
        let res = await fetch(url, {
            method,
            headers: { 'Content-Type':'application/json', 'x-csrf-token': token, 'x-xsrf-token': token },
            credentials: 'include',
            body: JSON.stringify({ name, description })
        });
        if (res.status === 403) {
            await ensureCsrfTokenReady(true);
            const t2 = (window.csrfToken||'');
            res = await fetch(url, {
                method,
                headers: { 'Content-Type':'application/json', 'x-csrf-token': t2, 'x-xsrf-token': t2 },
                credentials: 'include',
                body: JSON.stringify({ name, description })
            });
        }
        const result = await res.json().catch(()=>({ success:false }));
        if (!res.ok || result.success === false) throw new Error(result.message || 'Gagal menyimpan satuan');
        bootstrap.Modal.getOrCreateInstance(document.getElementById('unitModal')).hide();
        await loadUnits();
        alert(id ? 'Satuan berhasil diupdate!' : 'Satuan berhasil ditambahkan!');
    } catch (e) {
        alert(String(e.message || e));
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = 'Simpan'; }
    }
}

async function exportUnitsToXlsx() {
    try {
        const res = await fetch('/api/units/export');
        if (!res.ok) throw new Error('Export gagal');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'units_export.xlsx'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
        alert('Satuan berhasil diekspor!');
    } catch (e) { alert(`Gagal mengekspor: ${e.message}`); }
}

async function downloadUnitTemplate() {
    try {
        const res = await fetch('/api/units/template');
        if (!res.ok) throw new Error('Gagal mengunduh template');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'unit_import_template.xlsx'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
        alert('Template berhasil diunduh!');
    } catch (e) { alert(`Gagal mengunduh template: ${e.message}`); }
}

function triggerUnitFileSelection() { document.getElementById('importUnitFileInput')?.click(); }

function handleUnitFileSelection(ev) {
    const file = ev.target.files[0];
    const span = document.getElementById('selectedUnitFileName');
    const btn = document.getElementById('importUnitFileBtn');
    if (file) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (!['xlsx','xls'].includes(ext)) { alert('Pilih file Excel (.xlsx atau .xls)'); ev.target.value=''; return; }
        span.textContent = `Dipilih: ${file.name}`; btn.disabled = false; selectedImportFiles.unit = file;
    } else {
        span.textContent = 'Tidak ada file yang dipilih'; btn.disabled = true; selectedImportFiles.unit = null;
    }
}

async function processUnitImport() {
    if (!selectedImportFiles.unit) { alert('Pilih file dulu'); return; }
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(ws, { defval: '' });
            if (json.length === 0) { alert('File kosong'); return; }
            const hasName = ('Unit Name' in json[0]) || ('name' in json[0]);
            if (!hasName) throw new Error('Kolom wajib tidak ada. Wajib: Unit Name');
            const btn = document.getElementById('importUnitFileBtn');
            btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Mengimport...';
            await ensureCsrfTokenReady();
            const res = await fetch('/api/units/import', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ units: json }) });
            const result = await res.json();
            if (!res.ok) throw new Error(result.message || 'Server error');
            alert(result.message);
            await loadUnits();
        } catch (error) {
            alert(`Gagal mengimport: ${error.message}`);
        } finally {
            document.getElementById('importUnitFileInput').value = '';
            document.getElementById('selectedUnitFileName').textContent = 'Tidak ada file yang dipilih';
            selectedImportFiles.unit = null;
            const btn = document.getElementById('importUnitFileBtn');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-upload"></i> Impor Sekarang'; }
        }
    };
    reader.readAsArrayBuffer(selectedImportFiles.unit);
}

// --- Transaksi ---
async function loadTransactions() {
    try {
        const res = await fetch('/api/transactions', { cache: 'no-store' });
        if (!res.ok) throw new Error('Gagal memuat transaksi');
        const allTransactions = await res.json();
        const usersRes = await fetch('/api/users', { cache: 'no-store' });
        const allUsers = await usersRes.json();
        users = allUsers;
        transactions = allTransactions.map(t => {
            const user = users.find(u => u.id === t.userId);
            return {
                ...t,
                cashierName: user ? user.name : `User ID: ${t.userId}`,
                itemCount: t.items ? t.items.length : 0
            };
        }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        transactionCurrentPage = 1;
        renderTransactions();
    } catch (error) {
        console.error('Gagal memuat transaksi:', error);
        const tbody = document.getElementById('transactionTableBody');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="9" class="text-center text-danger">Gagal memuat transaksi</td></tr>`;
        }
    }
}

function getFilteredTransactions() {
    let filtered = transactions;
    if (transactionSearchTerm) {
        const term = transactionSearchTerm.toString().toLowerCase().trim();
        filtered = filtered.filter(t => {
            const idStr = (t.id ?? '').toString().toLowerCase();
            const dateObj = t.timestamp ? new Date(t.timestamp) : (t.date ? new Date(t.date) : null);
            const timeStr = dateObj ? dateObj.toLocaleString('id-ID').toLowerCase() : '';
            const cashierStr = (t.cashierName ?? '').toString().toLowerCase();
            const totalVal = (t.totalAmount ?? t.total ?? '');
            const totalStr = totalVal !== '' ? totalVal.toString().toLowerCase() : '';
            const methodStr = (t.paymentMethod ?? '').toString().toLowerCase();
            return idStr.includes(term) || timeStr.includes(term) || cashierStr.includes(term) || totalStr.includes(term) || methodStr.includes(term);
        });
    }
    if (paymentMethodFilter) {
        filtered = filtered.filter(t => (t.paymentMethod || '').toString().toLowerCase() === paymentMethodFilter);
    }
    if (dateRangeFilter) {
        const now = new Date();
        let start, end;
        switch(dateRangeFilter) {
            case 'today':
                start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
                break;
            case 'week':
                start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
                end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() + 7);
                break;
            case 'month':
                start = new Date(now.getFullYear(), now.getMonth(), 1);
                end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
                break;
            case 'custom':
                if (customStartDate && customEndDate) {
                    start = new Date(customStartDate);
                    end = new Date(customEndDate + 'T23:59:59');
                }
                break;
        }
        if (start && end) {
            filtered = filtered.filter(t => {
                const d = new Date(t.timestamp);
                return d >= start && d <= end;
            });
        }
    }
    return filtered;
}

function getPaginatedTransactions() {
    const filtered = getFilteredTransactions();
    if (transactionPageSize === 'all') return filtered;
    const start = (transactionCurrentPage - 1) * transactionPageSize;
    return filtered.slice(start, start + transactionPageSize);
}

function renderTransactions() {
    const tbody = document.getElementById('transactionTableBody');
    if (!tbody) return;
    const paginated = getPaginatedTransactions();
    const filtered = getFilteredTransactions();
    if (paginated.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="text-center">Tidak ada transaksi ditemukan.</td></tr>`;
        document.getElementById('transactionPaginationTop').innerHTML = '';
        document.getElementById('transactionPaginationBottom').innerHTML = '';
        document.getElementById('transactionSummary').innerHTML = '';
        return;
    }
    const start = transactionPageSize === 'all' ? 0 : (transactionCurrentPage - 1) * transactionPageSize;
    tbody.innerHTML = paginated.map((t, idx) => {
        const methodClass = t.paymentMethod === 'cash' ? 'success' : 'info';
        const methodText = t.paymentMethod === 'cash' ? 'Tunai' : 'QRIS';

        // Hitung status pembayaran berdasarkan paidAmount / remainingAmount
        const totalAmount = Number(t.totalAmount ?? 0) || 0;

        const hasExplicitDebt = typeof t.paidAmount === 'number' || typeof t.remainingAmount === 'number';
        const isImplicitPartialCash = !hasExplicitDebt
            && t.paymentMethod === 'cash'
            && t.customerId && t.customerId !== 'default'
            && Number(t.change ?? 0) < 0;

        let paidAmount;
        // Kasus hutang implisit: pembayaran parsial dengan kembalian negatif
        if (isImplicitPartialCash) {
            const amountReceived = Number(t.amountReceived ?? 0) || 0;
            paidAmount = amountReceived;
        } else {
            // Untuk transaksi dengan field hutang eksplisit atau transaksi lama biasa
            // - Jika paidAmount ada, gunakan itu
            // - Jika tidak, fallback:
            //   - Tunai: asumsikan lunas (bayar = total)
            //   - Non tunai: juga dianggap lunas
            paidAmount = (typeof t.paidAmount === 'number') ? t.paidAmount : (
                t.paymentMethod === 'cash'
                    ? totalAmount
                    : totalAmount
            );
        }
        if (!isFinite(paidAmount)) paidAmount = 0;

        let remainingAmount;
        if (typeof t.remainingAmount === 'number') {
            remainingAmount = t.remainingAmount;
        } else if (isImplicitPartialCash) {
            remainingAmount = Math.max(0, totalAmount - paidAmount);
        } else {
            remainingAmount = Math.max(0, totalAmount - paidAmount);
        }
        if (!isFinite(remainingAmount)) remainingAmount = 0;

        let statusText = 'Selesai';
        let statusClass = 'success';
        if (remainingAmount > 0 && paidAmount > 0) {
            statusText = 'Hutang (Bayar Sebagian)';
            statusClass = 'warning';
        } else if (remainingAmount > 0 && paidAmount === 0) {
            statusText = 'Hutang';
            statusClass = 'danger';
        }

        return `
        <tr>
            <td><small>${start + idx + 1}</small></td>
            <td><small>${t.id || ''}</small></td>
            <td><small>${t.timestamp ? new Date(t.timestamp).toLocaleString('id-ID') : ''}</small></td>
            <td>${t.cashierName || ''}</td>
            <td><span class="badge bg-secondary">${t.itemCount || 0} Item</span></td>
            <td><strong>${formatCurrency(t.totalAmount || 0)}</strong></td>
            <td><span class="badge bg-${methodClass}">${methodText}</span></td>
            <td><span class="badge bg-${statusClass}">${statusText}</span></td>
            <td>
                <button class="btn btn-sm btn-info" onclick="showTransactionDetails('${t.id}')" title="Lihat Detail">
                    <i class="bi bi-eye"></i>
                </button>
                <button class="btn btn-sm btn-danger" onclick="voidTransaction('${t.id}')" title="Void Transaksi">
                    <i class="bi bi-x-circle"></i>
                </button>
            </td>
        </tr>`;
    }).join('');
    updateTransactionSummary(filtered);
    renderTransactionPagination();
}

function updateTransactionSummary(filtered) {
    const el = document.getElementById('transactionSummary');
    if (!el) return;
    const total = filtered.length;
    const amount = filtered.reduce((sum, t) => sum + (t.totalAmount || 0), 0);
    const cash = filtered.filter(t => t.paymentMethod === 'cash').length;
    const qris = filtered.filter(t => t.paymentMethod === 'qris').length;
    el.innerHTML = `<small>Total: ${total} transaksi | Nilai: ${formatCurrency(amount)} | Tunai: ${cash} | QRIS: ${qris}</small>`;
}

function renderTransactionPagination() {
    const filtered = getFilteredTransactions();
    const total = filtered.length;
    const top = document.getElementById('transactionPaginationTop');
    const bottom = document.getElementById('transactionPaginationBottom');
    if (transactionPageSize === 'all' || total <= transactionPageSize) {
        top.innerHTML = '';
        bottom.innerHTML = '';
        return;
    }
    const pages = Math.ceil(total / transactionPageSize);
    if (transactionCurrentPage > pages) transactionCurrentPage = pages;
    if (transactionCurrentPage < 1) transactionCurrentPage = 1;
    let html = `<ul class="pagination mb-0 justify-content-center">`;
    html += `<li class="page-item ${transactionCurrentPage === 1 ? 'disabled' : ''}>
        <a class="page-link" href="#" data-page="${transactionCurrentPage - 1}">Sebelumnya</a></li>`;
    const pageLinks = generateMinimalPaginationLinks(transactionCurrentPage, pages);
    for (const p of pageLinks) {
        if (p === '...') {
            html += `<li class="page-item disabled"><span class="page-link">...</span></li>`;
        } else {
            html += `<li class="page-item ${transactionCurrentPage === p ? 'active' : ''}>
                <a class="page-link" href="#" data-page="${p}">${p}</a></li>`;
        }
    }
    html += `<li class="page-item ${transactionCurrentPage === pages ? 'disabled' : ''}>
        <a class="page-link" href="#" data-page="${transactionCurrentPage + 1}">Selanjutnya</a></li>`;
    html += `</ul>`;
    top.innerHTML = html;
    bottom.innerHTML = html;
}

function showTransactionDetails(id) {
    const t = transactions.find(tx => tx.id === id);
    if (!t) return;
    transactionToVoidId = id;
    const itemsHtml = t.items ? t.items.map(item => `
        <tr>
            <td>${item.name || ''}</td>
            <td class="text-end">${formatCurrency(item.price || 0)}</td>
            <td class="text-center">${item.qty || 0}</td>
            <td class="text-end">${formatCurrency((item.price || 0) * (item.qty || 0))}</td>
        </tr>`).join('') : '';
    const content = document.getElementById('transactionDetailsContent');
    if (content) {
        const methodText = t.paymentMethod === 'cash' ? 'Tunai' : 'QRIS';

        // Hitung tampilan Jumlah Diterima & Kembalian yang lebih masuk akal
        let displayAmountReceived = t.amountReceived || 0;
        let displayChange = t.change || 0;
        if (t.paymentMethod === 'cash') {
            const total = Number(t.totalAmount || 0) || 0;
            const paidAmount = typeof t.paidAmount === 'number' ? t.paidAmount : displayAmountReceived;
            const remainingAmount = typeof t.remainingAmount === 'number'
                ? t.remainingAmount
                : Math.max(0, total - paidAmount);

            // Jika hutang sudah lunas (tidak ada sisa), anggap pembayaran total = paidAmount
            // dan kembalian = paidAmount - total (biasanya 0 untuk kasus pelunasan hutang)
            if (remainingAmount === 0 && paidAmount >= total && total > 0) {
                displayAmountReceived = paidAmount;
                displayChange = paidAmount - total;
            }
        }
        content.innerHTML = `
            <div class="row mb-3">
                <div class="col-md-6">
                    <p><strong>ID Transaksi:</strong> ${t.id || ''}</p>
                    <p><strong>Tanggal & Waktu:</strong> ${t.timestamp ? new Date(t.timestamp).toLocaleString('id-ID') : ''}</p>
                    <p><strong>Kasir:</strong> ${t.cashierName || ''}</p>
                </div>
                <div class="col-md-6">
                    <p><strong>Metode Pembayaran:</strong> <span class="badge bg-${t.paymentMethod === 'cash' ? 'success' : 'info'}">${methodText}</span></p>
                    ${t.paymentMethod === 'cash' ? `
                        <p><strong>Jumlah Diterima:</strong> ${formatCurrency(displayAmountReceived)}</p>
                        <p><strong>Kembalian:</strong> ${formatCurrency(displayChange)}</p>
                    ` : ''}
                </div>
            </div>
            <hr>
            <h6>Detail Pembelian:</h6>
            <div class="table-responsive">
                <table class="table table-sm">
                    <thead><tr><th>Produk</th><th class="text-end">Harga</th><th class="text-center">Qty</th><th class="text-end">Subtotal</th></tr></thead>
                    <tbody>${itemsHtml}</tbody>
                    <tfoot>
                        ${typeof t.subtotal === 'number' ? `<tr><th colspan="3">Subtotal</th><th class="text-end">${formatCurrency(t.subtotal)}</th></tr>` : ''}
                        ${typeof t.taxAmount === 'number' && t.taxAmount > 0 ? `<tr><th colspan="3">Tax</th><th class="text-end">${formatCurrency(t.taxAmount)}</th></tr>` : ''}
                        ${typeof t.serviceAmount === 'number' && t.serviceAmount > 0 ? `<tr><th colspan="3">Service</th><th class="text-end">${formatCurrency(t.serviceAmount)}</th></tr>` : ''}
                        <tr class="table-active"><th colspan="3">Total Pembayaran:</th><th class="text-end">${formatCurrency(t.totalAmount || 0)}</th></tr>
                    </tfoot>
                </table>
            </div>`;
        document.getElementById('printTransactionBtn')?.addEventListener('click', () => printTransaction(t));
        document.getElementById('voidTransactionBtn')?.addEventListener('click', () => voidTransaction(id));
        transactionDetailsModal.show();
    }
}

async function voidTransaction(id) {
    if (!confirm(`Apakah Anda yakin ingin membatalkan transaksi ${id}? Stok produk akan dikembalikan.`)) return;
    try {
        const res = await fetch(`/api/transactions/${id}`, { method: 'DELETE' });
        const result = await res.json();
        if (result.success) {
            alert(result.message);
            transactionDetailsModal.hide();
            await loadTransactions();
            await loadProducts();
        } else {
            alert(`Error: ${result.message}`);
        }
    } catch (error) {
        alert('Gagal membatalkan transaksi.');
    }
}

async function printTransaction(t) {
    // Ensure settings are loaded before printing
    if (!appSettings) {
        await loadSettings();
    }
    const win = window.open('', '_blank');
    const paperWidth = parseInt(appSettings?.paperWidth) || 80;
    
    // Determine font size based on paper width
    let fontSize, footerFontSize;
    if (paperWidth <= 58) {
        fontSize = '12px';
        footerFontSize = '0.8em';
    } else if (paperWidth <= 80) {
        fontSize = '13px';
        footerFontSize = '0.9em';
    } else {
        fontSize = '14px';
        footerFontSize = '1.0em';
    }
    
    const widthMm = `${paperWidth}mm`;
    const showAddr = appSettings?.showReceiptAddress !== false;
    const showPhone = appSettings?.showReceiptPhone !== false;
    const showFooter = appSettings?.showReceiptFooter !== false;
    // Hitung tampilan Jumlah Diterima & Kembalian yang lebih masuk akal untuk cetak
    let printAmountReceived = t.amountReceived || 0;
    let printChange = t.change || 0;
    if (t.paymentMethod === 'cash') {
        const total = Number(t.totalAmount || 0) || 0;
        const paidAmount = typeof t.paidAmount === 'number' ? t.paidAmount : printAmountReceived;
        const remainingAmount = typeof t.remainingAmount === 'number'
            ? t.remainingAmount
            : Math.max(0, total - paidAmount);

        if (remainingAmount === 0 && paidAmount >= total && total > 0) {
            printAmountReceived = paidAmount;
            printChange = paidAmount - total; // normalnya 0 saat pelunasan hutang
        }
    }

    win.document.write(`
        <!DOCTYPE html><html><head><title>Struk Transaksi</title>
        <style>@page{size:${widthMm} auto;margin:0;}body{font-family:'Courier New',monospace;padding:10px;font-size:${fontSize};}h1{text-align:center;}.receipt{width:${widthMm};margin:0 auto;}.details p{margin:5px 0;}table{width:100%;border-collapse:collapse;}th,td{border:1px dashed #000;padding:8px;}th{text-align:left;border-bottom:2px solid #000;}.text-end{text-align:right;}.text-center{text-align:center;}.total{border-top:2px solid #000;font-weight:bold;}.footer{margin-top:30px;text-align:center;font-size:${footerFontSize};}@media print{body{padding:0;}}</style>
        </head><body>
        <div class="receipt">
        <div style="text-align:center; margin-bottom: 10px;">
            ${appSettings?.logoBase64 ? `<img src="${appSettings.logoBase64}" style="max-height:60px; object-fit:contain;" />` : ''}
            <h1 style="margin: 6px 0 0 0;">${(appSettings?.storeName || 'STRUK PENJUALAN')}</h1>
        </div>
        <div class="details">
            <p><strong>ID Transaksi:</strong> ${t.id}</p>
            <p><strong>Tanggal:</strong> ${new Date(t.timestamp).toLocaleDateString('id-ID')}</p>
            <p><strong>Kasir:</strong> ${t.cashierName}</p>
            <p><strong>Pelanggan:</strong> ${t.customerName || 'Pelanggan Umum'}</p>
            ${showAddr && appSettings?.address ? `<p><strong>Alamat:</strong> ${appSettings.address}</p>` : ''}
            ${showPhone && appSettings?.phone ? `<p><strong>Telepon:</strong> ${appSettings.phone}</p>` : ''}
        </div>
        <table>
            <thead><tr><th>Item</th><th class="text-end">Harga</th><th class="text-center">Qty</th><th class="text-end">Total</th></tr></thead>
            <tbody>${t.items.map(i => `<tr><td>${i.name}</td><td class="text-end">${formatCurrency(i.price)}</td><td class="text-center">${i.qty}</td><td class="text-end">${formatCurrency(i.price * i.qty)}</td></tr>`).join('')}</tbody>
            <tfoot>
              ${typeof t.subtotal === 'number' ? `<tr><td colspan="3">Subtotal</td><td class="text-end">${formatCurrency(t.subtotal)}</td></tr>` : ''}
              ${typeof t.taxAmount === 'number' && t.taxAmount > 0 ? `<tr><td colspan="3">Tax</td><td class="text-end">${formatCurrency(t.taxAmount)}</td></tr>` : ''}
              ${typeof t.serviceAmount === 'number' && t.serviceAmount > 0 ? `<tr><td colspan="3">Service</td><td class="text-end">${formatCurrency(t.serviceAmount)}</td></tr>` : ''}
              <tr class="total"><td colspan="3">TOTAL</td><td class="text-end">${formatCurrency(t.totalAmount)}</td></tr>
            </tfoot>
        </table>
        <div class="details">
            <p><strong>Metode Pembayaran:</strong> ${t.paymentMethod === 'cash' ? 'Tunai' : 'QRIS'}</p>
            ${t.paymentMethod === 'cash' ? `<p><strong>Jumlah Diterima:</strong> ${formatCurrency(printAmountReceived)}</p><p><strong>Kembalian:</strong> ${formatCurrency(printChange)}</p>` : ''}
        </div>
        ${showFooter ? `<div class="footer"><p>${appSettings?.receiptFooter || 'Terima kasih atas pembelian Anda!'}</p>${appSettings?.receiptFooter1 && appSettings.receiptFooter1.trim() ? `<p>${appSettings.receiptFooter1}</p>` : ''}</div>` : ''}
        </div>
        </body></html>`);
    win.document.close();
    win.print();
}

// --- Shifts (Cashier) ---
async function loadShifts() {
    try {
        const res = await fetch('/api/shifts', { cache: 'no-store' });
        if (!res.ok) throw new Error('Gagal memuat shift');
        const data = await res.json().catch(() => ({}));
        let list = [];
        if (Array.isArray(data && data.shifts)) list = data.shifts;
        else if (Array.isArray(data)) list = data;
        shifts = list.slice().sort((a, b) => Number(b?.openedAt || 0) - Number(a?.openedAt || 0));
        shiftCurrentPage = 1;
        populateShiftCashierFilter();
        renderShifts();
    } catch (error) {
        console.error('Gagal memuat shift:', error);
        const tbody = document.getElementById('shiftTableBody');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="9" class="text-center text-danger">Gagal memuat data shift</td></tr>`;
        }
        const sum = document.getElementById('shiftSummary'); if (sum) sum.textContent = '';
        const top = document.getElementById('shiftPaginationTop'); if (top) top.innerHTML = '';
        const bottom = document.getElementById('shiftPaginationBottom'); if (bottom) bottom.innerHTML = '';
    }
}

function populateShiftCashierFilter() {
    const sel = document.getElementById('shiftCashierFilter');
    if (!sel) return;
    const prev = sel.value;
    const map = new Map();
    (shifts || []).forEach(s => {
        const id = s && s.cashierId != null ? String(s.cashierId) : '';
        if (!id) return;
        const name = s.cashierName || s.cashierUsername || `ID: ${id}`;
        if (!map.has(id)) map.set(id, name);
    });
    let html = '<option value="">Semua Kasir</option>';
    const entries = Array.from(map.entries()).sort((a,b)=> a[1].localeCompare(b[1]));
    for (const [id,name] of entries) {
        html += `<option value="${id}">${name}</option>`;
    }
    sel.innerHTML = html;
    if (prev && map.has(prev)) sel.value = prev;
}

function getFilteredShifts() {
    let filtered = Array.isArray(shifts) ? shifts : [];
    if (shiftCashierFilterValue) {
        const cid = String(shiftCashierFilterValue);
        filtered = filtered.filter(s => String(s && s.cashierId) === cid);
    }
    let from = null, to = null;
    if (shiftDateFromFilter) {
        const d = new Date(shiftDateFromFilter);
        if (!isNaN(d.getTime())) { d.setHours(0,0,0,0); from = d; }
    }
    if (shiftDateToFilter) {
        const d = new Date(shiftDateToFilter);
        if (!isNaN(d.getTime())) { d.setHours(23,59,59,999); to = d; }
    }
    if (from || to) {
        filtered = filtered.filter(s => {
            let ts = 0;
            if (s && s.openedAt != null) {
                ts = Number(s.openedAt);
                if (!Number.isFinite(ts)) {
                    const d = new Date(s.openedAt);
                    ts = d.getTime();
                }
            }
            const d = new Date(ts || 0);
            if (isNaN(d.getTime())) return false;
            if (from && d < from) return false;
            if (to && d > to) return false;
            return true;
        });
    }
    return filtered;
}

function getPaginatedShifts() {
    const filtered = getFilteredShifts();
    if (shiftPageSize === 'all') return filtered;
    const start = (shiftCurrentPage - 1) * shiftPageSize;
    return filtered.slice(start, start + shiftPageSize);
}

function renderShifts() {
    const tbody = document.getElementById('shiftTableBody');
    if (!tbody) return;
    const filtered = getFilteredShifts();
    const paginated = getPaginatedShifts();
    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="9" class="text-center">Tidak ada shift ditemukan.</td></tr>`;
        const top = document.getElementById('shiftPaginationTop'); if (top) top.innerHTML = '';
        const bottom = document.getElementById('shiftPaginationBottom'); if (bottom) bottom.innerHTML = '';
        const sum = document.getElementById('shiftSummary'); if (sum) sum.textContent = '';
        return;
    }
    const startIndex = shiftPageSize === 'all' ? 0 : (shiftCurrentPage - 1) * shiftPageSize;
    tbody.innerHTML = paginated.map((s, idx) => {
        const no = startIndex + idx + 1;
        const cashier = s.cashierName || s.cashierUsername || (s.cashierId != null ? `ID: ${s.cashierId}` : '');
        const opened = (() => {
            const ts = Number(s.openedAt || 0);
            const d = new Date(ts || 0);
            return isNaN(d.getTime()) ? '' : d.toLocaleString('id-ID');
        })();
        const closed = (() => {
            if (!s.closedAt) return '-';
            const ts = Number(s.closedAt || 0);
            const d = new Date(ts || 0);
            return isNaN(d.getTime()) ? '' : d.toLocaleString('id-ID');
        })();
        const openingCash = formatCurrency(s.openingCash || 0);
        const cashSales = formatCurrency(s.cashSales || 0);
        const nonCashSales = formatCurrency(s.nonCashSales || 0);
        const varianceVal = Number(s.cashVariance || 0);
        const varianceText = formatCurrency(varianceVal);
        const varianceClass = varianceVal === 0 ? 'text-success' : (varianceVal < 0 ? 'text-danger' : 'text-warning');
        const statusBadge = s.closedAt
            ? '<span class="badge bg-success">Selesai</span>'
            : '<span class="badge bg-warning text-dark">Aktif</span>';
        return `
        <tr>
            <td>${no}</td>
            <td>${cashier}</td>
            <td><small>${opened}</small></td>
            <td><small>${closed}</small></td>
            <td class="text-end">${openingCash}</td>
            <td class="text-end">${cashSales}</td>
            <td class="text-end">${nonCashSales}</td>
            <td class="text-end ${varianceClass}">${varianceText}</td>
            <td>${statusBadge}</td>
        </tr>`;
    }).join('');
    updateShiftSummary(filtered);
    renderShiftPagination();
}

function updateShiftSummary(filtered) {
    const el = document.getElementById('shiftSummary');
    if (!el) return;
    const total = filtered.length;
    const totalSales = filtered.reduce((sum, s) => sum + Number(s.totalSales || 0), 0);
    const variance = filtered.reduce((sum, s) => sum + Number(s.cashVariance || 0), 0);
    el.innerHTML = `<small>Total shift: ${total} | Total Penjualan: ${formatCurrency(totalSales)} | Akumulasi Selisih Kas: ${formatCurrency(variance)}</small>`;
}

function renderShiftPagination() {
    const filtered = getFilteredShifts();
    const total = filtered.length;
    const top = document.getElementById('shiftPaginationTop');
    const bottom = document.getElementById('shiftPaginationBottom');
    if (!top || !bottom) return;
    if (shiftPageSize === 'all' || total <= shiftPageSize) {
        top.innerHTML = '';
        bottom.innerHTML = '';
        return;
    }
    const pages = Math.ceil(total / shiftPageSize);
    if (shiftCurrentPage > pages) shiftCurrentPage = pages;
    if (shiftCurrentPage < 1) shiftCurrentPage = 1;
    let html = `<ul class="pagination mb-0 justify-content-center">`;
    html += `<li class="page-item ${shiftCurrentPage === 1 ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${shiftCurrentPage - 1}">Sebelumnya</a></li>`;
    const pageLinks = generateMinimalPaginationLinks(shiftCurrentPage, pages);
    for (const p of pageLinks) {
        if (p === '...') html += `<li class="page-item disabled"><span class="page-link">...</span></li>`;
        else html += `<li class="page-item ${shiftCurrentPage === p ? 'active' : ''}"><a class="page-link" href="#" data-page="${p}">${p}</a></li>`;
    }
    html += `<li class="page-item ${shiftCurrentPage === pages ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${shiftCurrentPage + 1}">Selanjutnya</a></li>`;
    html += `</ul>`;
    top.innerHTML = html;
    bottom.innerHTML = html;
}
async function loadUsers() {
    try {
        const res = await fetch('/api/users', { cache: 'no-store' });
        if (!res.ok) throw new Error('Gagal memuat user');
        users = (await res.json()).map(u => ({
            ...u,
            displayName: u.name || u.username,
            lastLoginFormatted: u.lastLogin ? new Date(u.lastLogin).toLocaleString('id-ID') : 'Belum pernah login'
        }));
        userCurrentPage = 1;
        renderUsers();
    } catch (error) {
        console.error("Gagal memuat user:", error);
        const tbody = document.getElementById('userTableBody');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger">Gagal memuat user</td></tr>`;
        }
    }
}

function getFilteredUsers() {
    let filtered = users;
    
    if (userSearchTerm) {
        const term = userSearchTerm.toLowerCase();
        filtered = filtered.filter(u => 
            (u.username && u.username.toLowerCase().includes(term)) ||
            (u.name && u.name.toLowerCase().includes(term)) ||
            (u.role && u.role.toLowerCase().includes(term))
        );
    }
    
    if (roleFilter) {
        filtered = filtered.filter(u => u.role === roleFilter);
    }
    
    if (statusFilter) {
        filtered = filtered.filter(u => (u.status || 'active') === statusFilter);
    }
    
    return filtered;
}

function getPaginatedUsers() {
    const filtered = getFilteredUsers();
    if (userPageSize === 'all') return filtered;
    const start = (userCurrentPage - 1) * userPageSize;
    return filtered.slice(start, start + userPageSize);
}

function renderUsers() {
    const tbody = document.getElementById('userTableBody');
    if (!tbody) return;
    
    const paginatedUsers = getPaginatedUsers();
    if (paginatedUsers.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center">Tidak ada user ditemukan.</td></tr>`;
        document.getElementById('userPaginationTop').innerHTML = '';
        document.getElementById('userPaginationBottom').innerHTML = '';
        document.getElementById('userSummary').innerHTML = '';
        return;
    }
    
    const startIndex = userPageSize === 'all' ? 0 : (userCurrentPage - 1) * userPageSize;
    tbody.innerHTML = paginatedUsers.map((u, idx) => {
        const no = startIndex + idx + 1;
        const roleBadge = u.role === 'admin' ? '<span class="badge bg-danger">Admin</span>' : '<span class="badge bg-info">Kasir</span>';
        const statusBadge = (u.status || 'active') === 'active' 
            ? '<span class="badge bg-success">Aktif</span>' 
            : '<span class="badge bg-secondary">Tidak Aktif</span>';
        
        return `
        <tr>
            <td>${no}</td>
            <td>${u.id || ''}</td>
            <td>${u.username || ''}</td>
            <td>${u.name || ''}</td>
            <td>${roleBadge}</td>
            <td>${statusBadge}</td>
            <td>${u.lastLoginFormatted || 'Belum pernah login'}</td>
            <td>
                <button class="btn btn-sm btn-warning" onclick="openEditModal('user', '${u.id}')">Edit</button>
                ${u.id !== 1 ? `<button class="btn btn-sm btn-danger" onclick="deleteItem('users', '${u.id}')">Hapus</button>` : ''}
            </td>
        </tr>`;
    }).join('');
    
    renderUserPagination();
    const filtered = getFilteredUsers();
    const total = filtered.length;
    const summary = document.getElementById('userSummary');
    if (summary) {
        summary.innerHTML = `Menampilkan ${startIndex + 1}-${Math.min(startIndex + paginatedUsers.length, total)} dari ${total} user`;
    }
}

function renderUserPagination() {
    const filtered = getFilteredUsers();
    const total = filtered.length;
    const top = document.getElementById('userPaginationTop');
    const bottom = document.getElementById('userPaginationBottom');
    
    if (userPageSize === 'all' || total <= userPageSize) {
        if (top) top.innerHTML = '';
        if (bottom) bottom.innerHTML = '';
        return;
    }
    
    const totalPages = Math.ceil(total / userPageSize);
    if (userCurrentPage > totalPages) userCurrentPage = totalPages;
    if (userCurrentPage < 1) userCurrentPage = 1;
    
    let html = `<ul class="pagination mb-0 justify-content-center">`;
    html += `<li class="page-item ${userCurrentPage === 1 ? 'disabled' : ''}>
        <a class="page-link" href="#" data-page="${userCurrentPage - 1}">Sebelumnya</a></li>`;
    const pageLinks = generateMinimalPaginationLinks(userCurrentPage, totalPages);
    for (const p of pageLinks) {
        if (p === '...') {
            html += `<li class="page-item disabled"><span class="page-link">...</span></li>`;
        } else {
            html += `<li class="page-item ${userCurrentPage === p ? 'active' : ''}>
                <a class="page-link" href="#" data-page="${p}">${p}</a></li>`;
        }
    }
    html += `<li class="page-item ${userCurrentPage === totalPages ? 'disabled' : ''}>
        <a class="page-link" href="#" data-page="${userCurrentPage + 1}">Selanjutnya</a></li>`;
    html += `</ul>`;
    
    if (top) top.innerHTML = html;
    if (bottom) bottom.innerHTML = html;
}

// --- Banner & QRIS ---
async function loadBanner() {
    try {
        const res = await fetch('/api/banner');
        if (!res.ok) throw new Error('Gagal memuat banner');
        const raw = await res.json();
        const b = Array.isArray(raw) ? (raw[0] || null) : raw;
        if (b) {
            document.getElementById('bannerTitle').value = b.title || '';
            document.getElementById('bannerSubtitle').value = b.subtitle || '';
            document.getElementById('bannerImageBase64').value = b.imageBase64 || '';
            const preview = document.getElementById('bannerPreview');
            if (preview) {
                preview.src = b.imageBase64 || PLACEHOLDER_IMAGE;
                preview.style.display = 'block';
            }
            currentEditId = b.id;
        }
    } catch (error) {
        console.error("Gagal memuat banner:", error);
    }
}

async function loadQris() {
    try {
        const res = await fetch('/api/qris');
        if (!res.ok) throw new Error('Gagal memuat QRIS');
        const q = await res.json();
        if (q && q.id) {
            const imgTa = document.getElementById('qrisImageBase64');
            if (imgTa) imgTa.value = q.imageBase64 || '';
            const preview = document.getElementById('qrisPreview');
            if (preview) {
                preview.src = q.imageBase64 || PLACEHOLDER_IMAGE;
                preview.style.display = 'block';
            }

            // Populate payment logos (QRIS, DANA, OVO) into form
            try {
                const qrisTa = document.getElementById('paymentLogoQrisBase64');
                const danaTa = document.getElementById('paymentLogoDanaBase64');
                const ovoTa  = document.getElementById('paymentLogoOvoBase64');
                const qrisPrev = document.getElementById('paymentLogoQrisPreview');
                const danaPrev = document.getElementById('paymentLogoDanaPreview');
                const ovoPrev  = document.getElementById('paymentLogoOvoPreview');

                if (q.paymentLogoQrisBase64) {
                    if (qrisTa) qrisTa.value = q.paymentLogoQrisBase64;
                    if (qrisPrev) { qrisPrev.src = q.paymentLogoQrisBase64; qrisPrev.style.display = 'block'; }
                }
                if (q.paymentLogoDanaBase64) {
                    if (danaTa) danaTa.value = q.paymentLogoDanaBase64;
                    if (danaPrev) { danaPrev.src = q.paymentLogoDanaBase64; danaPrev.style.display = 'block'; }
                }
                if (q.paymentLogoOvoBase64) {
                    if (ovoTa) ovoTa.value = q.paymentLogoOvoBase64;
                    if (ovoPrev) { ovoPrev.src = q.paymentLogoOvoBase64; ovoPrev.style.display = 'block'; }
                }
            } catch {}

            currentEditId = q.id;
        }
    } catch (error) {
        console.error("Failed to load QRIS:", error);
    }
}

// --- Modal Edit ---
// CSRF helper
async function ensureCsrfTokenReady(force = false) {
    try {
        if (!force && window.csrfToken) return window.csrfToken;
        const res = await fetch('/api/csrf', { credentials: 'include', cache: 'no-store', headers: { 'Accept': 'application/json' } });
        if (!res.ok) throw new Error('Gagal mengambil CSRF');
        const data = await res.json();
        window.csrfToken = data.csrfToken || '';
        return window.csrfToken;
    } catch {}
    return '';
}
// Helpers for unit price variants (global scope so can be used from multiple places)
function renderUnitOptions() {
    // Merge defaults with units fetched from /api/units if available,
    // deduplicate case-insensitively, and prefer DB values over defaults.
    const defaults = ['', 'pcs', 'box', 'pack', 'dus', 'goni', 'lusin', 'kg', 'gram', 'meter', 'liter'];
    let dynamic = [];
    try {
        if (Array.isArray(window.unitsList) && window.unitsList.length) {
            dynamic = window.unitsList.map(u => {
                try { return String((u && (u.name || u.unit || u.value)) ?? u ?? '').trim(); } catch { return ''; }
            }).filter(Boolean);
        }
    } catch {}
    // Build map with lowercase key to original value. Insert dynamic (DB) first so it's preferred.
    const map = new Map();
    const insert = (arr) => {
        for (const v of arr) {
            if (typeof v !== 'string') continue;
            const s = v.trim();
            const key = s.toLowerCase();
            if (!map.has(key)) map.set(key, s);
        }
    };
    insert(dynamic);
    insert(defaults);
    let opts = Array.from(map.values());
    // Ensure empty placeholder exists and is first
    const emptyIdx = opts.findIndex(v => v === '');
    if (emptyIdx === -1) opts.unshift('');
    else if (emptyIdx > 0) { opts.splice(emptyIdx, 1); opts.unshift(''); }
    // Sort the rest A–Z, case-insensitive
    const head = opts.shift();
    const body = opts.sort((a, b) => a.localeCompare(b, 'id', { sensitivity: 'base' }));
    const all = [head, ...body];
    return all.map(v => `<option value="${v}">${v || 'Pilih Satuan'}</option>`).join('');
}

function addUnitPriceRow(rowData) {
    const tbody = document.getElementById('unitPricesBody');
    if (!tbody) return;
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="checkbox" class="form-check-input up-use" ${rowData?.use ? 'checked' : ''}></td>
        <td><input type="number" min="0.01" step="0.01" class="form-control form-control-sm up-qty" value="${rowData?.qty ?? ''}" placeholder="0"></td>
        <td>
            <select class="form-select form-select-sm up-unit scrollable-select">${renderUnitOptions()}</select>
        </td>
        <td><input type="number" min="0" step="0.01" class="form-control form-control-sm up-price" value="${rowData?.price ?? ''}" placeholder="0"></td>
        <td><input type="text" class="form-control form-control-sm up-note" value="${(rowData?.note || rowData?.desc || rowData?.keterangan || '').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}" placeholder="Keterangan (opsional)"></td>
        <td><button type="button" class="btn btn-sm btn-outline-danger up-remove"><i class="bi bi-x"></i></button></td>
    `;
    tbody.appendChild(tr);
    const unitSel = tr.querySelector('.up-unit');
    if (unitSel && rowData?.unit) unitSel.value = String(rowData.unit);
    const rm = tr.querySelector('.up-remove');
    if (rm && !rm._bound) {
        rm._bound = true;
        rm.addEventListener('click', () => tr.remove());
    }
}

function populateUnitPrices(unitPrices) {
    const tbody = document.getElementById('unitPricesBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (Array.isArray(unitPrices) && unitPrices.length) {
        unitPrices.forEach(up => addUnitPriceRow({ use: true, qty: up.qty, unit: up.unit, price: up.price, note: (up.note || up.desc || up.keterangan || '') }));
    } else {
        addUnitPriceRow({});
    }
}
function openEditModal(type, id) {
    currentEditType = type;
    currentEditId = id;
    const modalEl = document.getElementById(`${type}Modal`);
    if (!modalEl) return;
    
    // PERBAIKAN: Gunakan instance yang sudah ada atau buat baru, untuk menghindari aria-hidden warning
    let modal = bootstrap.Modal.getInstance(modalEl);
    if (!modal) {
        modal = new bootstrap.Modal(modalEl);
    }
    
    const nameInput = document.getElementById(`${type}Name`);
    if (nameInput) {
        nameInput.classList.remove('is-invalid', 'is-valid');
        hideValidationMessage(nameInput);
    }

    // Helper function untuk menampilkan modal dengan delay kecil untuk menghindari aria-hidden warning
    const showModalSafely = () => {
        // Gunakan requestAnimationFrame untuk memastikan DOM sudah siap sebelum menampilkan modal
        requestAnimationFrame(() => {
            // Pastikan elemen sudah ada sebelum menampilkan modal
            if (modalEl && modalEl.parentElement) {
                modal.show();
            }
        });
    };

    if (type === 'user') {
        // PERBAIKAN: Gunakan variabel global users jika sudah dimuat, jika tidak fetch
        const userList = users.length > 0 ? users : [];
        if (userList.length === 0) {
            fetch('/api/users').then(r => r.json()).then(fetchedUsers => {
                const idStr = String(id);
                const u = fetchedUsers.find(x => String(x.id) === idStr);
                if (!u && id) {
                    alert('User tidak ditemukan');
                    return;
                }
                document.getElementById('userId').value = u ? u.id : '';
                document.getElementById('userUsername').value = u ? u.username : '';
                document.getElementById('userNameField').value = u ? u.name : '';
                document.getElementById('userPassword').value = '';
                document.getElementById('userRole').value = u ? u.role : '';
                document.getElementById('userStatus').value = u ? (u.status || 'active') : 'active';
                document.getElementById('passwordRequired').style.display = u ? 'none' : 'inline';
                document.getElementById('userPassword').placeholder = u ? 'Kosongkan jika tidak ingin mengubah password' : 'Password wajib diisi';
                showModalSafely();
            }).catch(() => {
                alert('Gagal memuat data user');
            });
        } else {
            const idStr = String(id);
            const u = userList.find(x => String(x.id) === idStr);
            if (!u && id) {
                alert('User tidak ditemukan');
                return;
            }
            document.getElementById('userId').value = u ? u.id : '';
            document.getElementById('userUsername').value = u ? u.username : '';
            document.getElementById('userNameField').value = u ? u.name : '';
            document.getElementById('userPassword').value = '';
            document.getElementById('userRole').value = u ? u.role : '';
            document.getElementById('userStatus').value = u ? (u.status || 'active') : 'active';
            document.getElementById('passwordRequired').style.display = u ? 'none' : 'inline';
            document.getElementById('userPassword').placeholder = u ? 'Kosongkan jika tidak ingin mengubah password' : 'Password wajib diisi';
            showModalSafely();
        }
        return; // Jangan tampilkan modal di akhir fungsi untuk user dan product
    } else if (type === 'product') {
        // PERBAIKAN: Pastikan categories sudah dimuat sebelum populate dropdown dan set value
        const productCategorySelect = document.getElementById('productCategory');
        
        // Function untuk populate dropdown dan set value
        const populateCategoryAndSetValue = (categoryId) => {
            // Populate dropdown dengan semua kategori
            if (productCategorySelect) {
                productCategorySelect.innerHTML = '<option value="">Pilih Kategori</option>' +
                    categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
                
                // PERBAIKAN: Set value setelah dropdown ter-populate, pastikan perbandingan konsisten
                // Coba beberapa format ID karena mungkin berbeda format (string vs number)
                if (categoryId != null && categoryId !== '' && categoryId !== undefined) {
                    const categoryIdStr = String(categoryId);
                    const categoryIdNum = Number(categoryId);
                    
                    // Cari option yang cocok (coba string dulu, lalu number)
                    const matchingOption = Array.from(productCategorySelect.options).find(opt => 
                        String(opt.value) === categoryIdStr || Number(opt.value) === categoryIdNum
                    );
                    
                    if (matchingOption) {
                        productCategorySelect.value = matchingOption.value;
                                            } else {
                        // Jika tidak ditemukan, set langsung (mungkin format berbeda)
                        productCategorySelect.value = categoryIdStr;
                        console.warn('Category ID not found in options, set directly:', categoryIdStr);
                    }
                } else {
                    productCategorySelect.value = '';
                }
            }
        };
        
        // Helper function untuk load product data
        // unitPrices helpers are defined globally

        const loadProductAndShowModal = (productId, populateCategoryCallback, showModalCallback) => {
            fetch('/api/products', { cache: 'no-store' }).then(r => r.json()).then(products => {
                // Convert id to string for comparison
                const idStr = String(productId);
                const p = products.find(x => String(x.id) === idStr);
                if (!p) {
                    alert('Produk tidak ditemukan');
                    return;
                }
                
                // PERBAIKAN: Populate dropdown kategori sebelum set value
                populateCategoryCallback(p.categoryId);
                
                // Set semua field produk
                document.getElementById('productId').value = p.id || '';
                document.getElementById('productName').value = p.name || '';
                document.getElementById('productPurchasePrice').value = p.purchasePrice != null ? p.purchasePrice : '';
                document.getElementById('productPrice').value = (p.sellingPrice != null ? p.sellingPrice : (p.price || ''));
                const taxEl = document.getElementById('productTaxRate');
                if (taxEl) taxEl.value = (p.taxRate != null ? p.taxRate : '');
                const discEl = document.getElementById('productDiscountPercent');
                if (discEl) discEl.value = (p.discountPercent != null ? p.discountPercent : '');
                document.getElementById('productStock').value = p.stock || '';
                
                // PERBAIKAN: Set category value sekali lagi setelah semua field di-set untuk memastikan
                setTimeout(() => {
                    const categorySelect = document.getElementById('productCategory');
                    if (categorySelect && p.categoryId != null) {
                        const categoryIdStr = String(p.categoryId);
                        const categoryIdNum = Number(p.categoryId);
                        const matchingOption = Array.from(categorySelect.options).find(opt => 
                            String(opt.value) === categoryIdStr || Number(opt.value) === categoryIdNum
                        );
                        if (matchingOption) {
                            categorySelect.value = matchingOption.value;
                                                    } else {
                            // Fallback: coba set langsung
                            categorySelect.value = categoryIdStr;
                        }
                    }
                }, 100);
                
                try {
                    const val = p.imageBase64 || p.image || '';
                    const ta = document.getElementById('productImageBase64');
                    if (ta) ta.value = val;
                    const preview = document.getElementById('productPreview');
                    if (preview) {
                        if (val) { preview.src = val; preview.style.display = 'block'; }
                        else { preview.src = ''; preview.style.display = 'none'; }
                    }
                } catch {}
                document.getElementById('productIsTop').checked = p.isTopProduct || false;
                document.getElementById('productIsBest').checked = p.isBestSeller || false;
                const qrEl2 = document.getElementById('productQrCode');
                if (qrEl2) qrEl2.value = p.qrCode || '';
                // Populate main unit (satuan utama)
                try {
                    const unitSel = document.getElementById('productUnit');
                    const unitCustom = document.getElementById('productUnitCustom');
                    const unitVal = (p.unit || '').toString();
                    if (unitSel && unitCustom) {
                        const values = Array.from(unitSel.options).map(o => o.value);
                        if (unitVal && values.includes(unitVal)) {
                            unitSel.value = unitVal;
                            unitCustom.style.display = 'none';
                            unitCustom.value = '';
                        } else if (unitVal) {
                            unitSel.value = 'custom';
                            unitCustom.style.display = '';
                            unitCustom.value = unitVal;
                        } else {
                            unitSel.value = '';
                            unitCustom.style.display = 'none';
                            unitCustom.value = '';
                        }
                    }
                } catch {}
                // Stage unitPrices and also populate immediately if tbody is present
                try {
                    const stagedArr = Array.isArray(p.unitPrices) ? p.unitPrices : [];
                    window.__editProductUnitPrices = stagedArr;
                    const tbody = document.getElementById('unitPricesBody');
                    if (tbody && stagedArr.length) {
                        populateUnitPrices(stagedArr);
                    }
                } catch {}

                // PERBAIKAN: Tampilkan modal setelah data dimuat
                showModalCallback();
            }).catch(() => {
                alert('Gagal memuat data produk');
            });
        };

        // PERBAIKAN: Pastikan categories sudah dimuat, jika belum fetch dulu
        if (!categories || categories.length === 0) {
            // Load categories first
            fetch('/api/categories', { cache: 'no-store' })
                .then(r => r.json())
                .then(catsData => {
                    if (Array.isArray(catsData)) {
                        categories = catsData;
                    }
                    // Setelah categories dimuat, lanjutkan load product
                    loadProductAndShowModal(id, populateCategoryAndSetValue, showModalSafely);
                })
                .catch(err => {
                    console.error('Failed to load categories:', err);
                    // Tetap lanjutkan meski categories gagal load
                    loadProductAndShowModal(id, populateCategoryAndSetValue, showModalSafely);
                });
        } else {
            // Categories sudah ada, langsung populate dan load product
            loadProductAndShowModal(id, populateCategoryAndSetValue, showModalSafely);
        }
        
        return; // Jangan tampilkan modal sebelum data dimuat
    } else if (type === 'unit') {
        const idStr = String(id);
        const showUnit = (u) => {
            if (!u) { alert('Satuan tidak ditemukan'); return; }
            const idEl = document.getElementById('unitId'); if (idEl) idEl.value = u.id || '';
            const nameEl = document.getElementById('unitName'); if (nameEl) nameEl.value = u.name || '';
            const descEl = document.getElementById('unitDescription'); if (descEl) descEl.value = u.description || '';
            showModalSafely();
        };
        // Gunakan daftar yang sudah dimuat jika ada
        if (Array.isArray(units) && units.length) {
            const u = units.find(x => String(x.id) === idStr);
            showUnit(u);
        } else {
            fetch('/api/units', { cache: 'no-store' })
                .then(r => r.json())
                .then(list => { try { units = Array.isArray(list) ? list : []; } catch {} return Array.isArray(list) ? list : []; })
                .then(list => {
                    const u = (list || []).find(x => String(x.id) === idStr);
                    showUnit(u);
                })
                .catch(() => alert('Gagal memuat data satuan'));
        }
        return;
    } else if (type === 'category') {
        fetch('/api/categories').then(r => r.json()).then(categories => {
            const idStr = String(id);
            const c = categories.find(x => String(x.id) === idStr);
            if (!c) {
                alert('Kategori tidak ditemukan');
                return;
            }
            document.getElementById('categoryId').value = c.id || '';
            document.getElementById('categoryName').value = c.name || '';
            document.getElementById('categoryDescription').value = c.description || '';
            showModalSafely();
        }).catch(() => {
            alert('Gagal memuat data kategori');
        });
        return; // Jangan tampilkan modal di akhir fungsi untuk category juga
    }
    // Fallback: jika type tidak dikenal, tetap tampilkan modal
    showModalSafely();
}

// --- Form Setup ---
function setupForms() {
    // Product Form
    const saveProductBtn = document.getElementById('saveProductBtn');
    const productModalEl = document.getElementById('productModal');
    function resetProductForm() {
        const form = document.getElementById('productForm');
        if (form) form.reset();
        const imgBase = document.getElementById('productImageBase64');
        const preview = document.getElementById('productPreview');
        const categorySelect = document.getElementById('productCategory');
        const isTop = document.getElementById('productIsTop');
        const isBest = document.getElementById('productIsBest');
        const qrEl = document.getElementById('productQrCode');
        const expEl = document.getElementById('productExpiryDate');
        const unitSel = document.getElementById('productUnit');
        const unitCustom = document.getElementById('productUnitCustom');
        if (imgBase) imgBase.value = '';
        if (preview) { preview.src = ''; preview.style.display = 'none'; }
        if (categorySelect) categorySelect.value = '';
        if (isTop) isTop.checked = false;
        if (isBest) isBest.checked = false;
        if (qrEl) qrEl.value = '';
        if (expEl) expEl.value = '';
        if (unitSel) { unitSel.value = ''; unitSel.disabled = false; unitSel.readOnly = false; }
        if (unitCustom) { unitCustom.value = ''; unitCustom.style.display = 'none'; }
        const idEl = document.getElementById('productId');
        if (idEl) idEl.value = '';
        currentEditId = null;
        // Clear unitPrices rows
        const tbody = document.getElementById('unitPricesBody');
        if (tbody) tbody.innerHTML = '';
        // Clear any staged unitPrices
        try { window.__editProductUnitPrices = null; } catch {}
    }
    if (productModalEl) {
        productModalEl.addEventListener('hidden.bs.modal', () => {
            resetProductForm();
        });
        productModalEl.addEventListener('show.bs.modal', (e) => {
            const trigger = e.relatedTarget;
            // PERBAIKAN: Pastikan dropdown kategori terisi saat modal dibuka
            const productCategorySelect = document.getElementById('productCategory');
            if (productCategorySelect) {
                // Gunakan helper agar konsisten dan tidak menghapus selection
                if (!categories || categories.length === 0) {
                    // Load lalu populate, lalu apply desired selection
                    fetch('/api/categories', { cache: 'no-store' })
                        .then(r => r.json())
                        .then(catsData => { if (Array.isArray(catsData)) categories = catsData; })
                        .finally(() => { populateProductCategorySelect(); applyDesiredCategorySelection(__desiredCategoryId); });
                } else {
                    populateProductCategorySelect();
                    applyDesiredCategorySelection(__desiredCategoryId);
                }
            }
            // PERBAIKAN: Muat daftar satuan (units) dari server untuk select productUnit
            try {
                const unitSel = document.getElementById('productUnit');
                const unitCustom = document.getElementById('productUnitCustom');
                if (unitSel) {
                    const prev = unitSel.value; // simpan pilihan sementara jika ada
                    const load = async () => {
                        try {
                            if (!Array.isArray(window.unitsList) || window.unitsList.length === 0) {
                                const res = await fetch('/api/units', { cache: 'no-store' });
                                window.unitsList = await res.json();
                            }
                        } catch {}
                        const list = Array.isArray(window.unitsList) ? window.unitsList.slice() : [];
                        // Urutkan dari A-Z berdasarkan label yang ditampilkan (name atau id)
                        try {
                            list.sort((a, b) => {
                                const av = String((a && (a.name || a.id)) || '').trim();
                                const bv = String((b && (b.name || b.id)) || '').trim();
                                return av.localeCompare(bv, 'id', { sensitivity: 'base' });
                            });
                        } catch {}
                        // Bangun ulang opsi: kosong, semua unit dari DB, dan 'custom'
                        const current = prev || unitSel.value;
                        unitSel.innerHTML = '';
                        const optEmpty = document.createElement('option'); optEmpty.value = ''; optEmpty.textContent = 'Pilih Satuan'; unitSel.appendChild(optEmpty);
                        list.forEach(u => {
                            const val = (u && (u.name || u.id)) ? String(u.name || u.id) : '';
                            if (!val) return;
                            const o = document.createElement('option'); o.value = val; o.textContent = val; unitSel.appendChild(o);
                        });
                        const optCustom = document.createElement('option'); optCustom.value = 'custom'; optCustom.textContent = 'Kustom…'; unitSel.appendChild(optCustom);
                        // Pulihkan pilihan jika ada
                        if (current && Array.from(unitSel.options).some(o => o.value === current)) {
                            unitSel.value = current;
                            if (unitCustom) unitCustom.style.display = (current === 'custom') ? '' : 'none';
                        }
                    };
                    // Jalankan async tanpa menunggu blocking handler sync
                    load();
                }
            } catch {}
            // Setup unit select toggle
            try {
                const unitSel = document.getElementById('productUnit');
                const unitCustom = document.getElementById('productUnitCustom');
                if (unitSel && unitCustom && !unitSel._bound) {
                    unitSel._bound = true;
                    unitSel.addEventListener('change', () => {
                        if (unitSel.value === 'custom') {
                            unitCustom.style.display = '';
                            unitCustom.focus();
                        } else {
                            unitCustom.style.display = 'none';
                            unitCustom.value = '';
                        }
                    });
                }
            } catch {}
            if (trigger && trigger.getAttribute('data-action') === 'add') {
                resetProductForm();
                try { window.__editProductUnitPrices = null; } catch {}
            }
            try {
                // Sync QR with SKU if QR empty
                const skuInput = document.getElementById('productSku');
                const qrInput = document.getElementById('productQrCode');
                if (skuInput && qrInput && !qrInput.value) qrInput.value = skuInput.value || '';
                // When SKU changes, auto-fill QR if QR still empty
                if (skuInput && qrInput && !skuInput._synced) {
                    skuInput._synced = true;
                    skuInput.addEventListener('input', ()=>{ if (qrInput && !qrInput.value) qrInput.value = skuInput.value; });
                    skuInput.addEventListener('change', ()=>{ if (qrInput && !qrInput.value) qrInput.value = skuInput.value; });
                }
            } catch {}

            // Bind add unit price row button
            try {
                const addBtn = document.getElementById('addUnitPriceRowBtn');
                if (addBtn && !addBtn._bound) {
                    addBtn._bound = true;
                    addBtn.addEventListener('click', () => addUnitPriceRow());
                }
            } catch {}
        });
        // Ensure unitPrices are rendered only after modal content is fully visible
        productModalEl.addEventListener('shown.bs.modal', () => {
            try {
                const tbody = document.getElementById('unitPricesBody');
                const staged = window.__editProductUnitPrices;
                if (Array.isArray(staged) && staged.length) {
                    populateUnitPrices(staged);
                    window.__editProductUnitPrices = null;
                } else if (tbody && !tbody.children.length) {
                    // Fallback: refetch specific product and populate if available
                    const idInput = document.getElementById('productId');
                    const pid = idInput ? String(idInput.value||'') : '';
                    if (pid) {
                        fetch('/api/products', { cache: 'no-store' })
                          .then(r=>r.json())
                          .then(list=>{
                              try {
                                  const p = Array.isArray(list) ? list.find(x=>String(x.id)===pid) : null;
                                  if (p && Array.isArray(p.unitPrices) && p.unitPrices.length) {
                                      populateUnitPrices(p.unitPrices);
                                  } // else: keep empty for Add New UX
                              } catch {}
                          })
                          .catch(()=>{});
                    }
                }
            } catch {}
            // Ensure image base64 is populated after modal fully shown
            try {
                const ta = document.getElementById('productImageBase64');
                const prev = document.getElementById('productPreview');
                const idInput = document.getElementById('productId');
                const pid = idInput ? String(idInput.value||'') : '';
                if (ta && (!ta.value || ta.value.trim()==='') && pid) {
                    fetch('/api/products', { cache: 'no-store' })
                        .then(r=>r.json())
                        .then(list=>{
                            try {
                                const p = Array.isArray(list) ? list.find(x=>String(x.id)===pid) : null;
                                const val = p && (p.imageBase64 || p.image || p.photo || p.thumbnail || '');
                                if (val) {
                                    ta.value = val;
                                    if (prev) { prev.src = val; prev.style.display = 'block'; }
                                }
                            } catch {}
                        })
                        .catch(()=>{});
                }
            } catch {}
        });
    }
    if (saveProductBtn) {
        saveProductBtn.addEventListener('click', async () => {
            const name = document.getElementById('productName').value.trim();
            const purchasePrice = document.getElementById('productPurchasePrice') ? document.getElementById('productPurchasePrice').value : 0;
            const price = document.getElementById('productPrice').value; // Harga Jual
            const stock = document.getElementById('productStock').value;
            if (!name) { alert('Nama produk wajib diisi!'); return; }
            if (!price || price <= 0) { alert('Harga harus valid!'); return; }
            if (!stock || stock < 0) { alert('Stok harus valid!'); return; }

            const data = {
                name,
                // Gunakan sellingPrice sebagai harga jual, dan tetap kirim price untuk kompatibilitas
                sellingPrice: parseFloat(price) || 0,
                price: parseFloat(price) || 0,
                purchasePrice: parseFloat(purchasePrice) || 0,
                stock: parseInt(stock) || 0,
                categoryId: parseInt(document.getElementById('productCategory').value) || null,
                imageBase64: document.getElementById('productImageBase64').value,
                isTopProduct: document.getElementById('productIsTop').checked,
                isBestSeller: document.getElementById('productIsBest').checked,
                taxRate: parseFloat(document.getElementById('productTaxRate')?.value || '0') || 0,
                discountPercent: parseFloat(document.getElementById('productDiscountPercent')?.value || '0') || 0,
                qrCode: (document.getElementById('productQrCode')?.value || '').trim(),
                sku: (document.getElementById('productSku')?.value || '').trim(),
            };
            // Collect unit price variants
            try {
                const rows = Array.from(document.querySelectorAll('#unitPricesBody tr'));
                const variants = [];
                for (const tr of rows) {
                    const use = tr.querySelector('input[type="checkbox"]')?.checked;
                    const qty = parseFloat((tr.querySelector('.up-qty')?.value || '0').toString().replace(',', '.'));
                    const unit = (tr.querySelector('.up-unit')?.value || '').trim();
                    const price = parseFloat(tr.querySelector('.up-price')?.value || '0');
                    const note = (tr.querySelector('.up-note')?.value || '').trim();
                    if (use && qty > 0 && price >= 0 && unit) {
                        const v = { qty, unit, price };
                        if (note) v.note = note;
                        variants.push(v);
                    }
                }
                if (variants.length > 0) data.unitPrices = variants;
            } catch {}
            const expVal = (document.getElementById('productExpiryDate')?.value || '').trim();
            // Always include expiryDate: set to value or null to clear on server when empty
            data.expiryDate = expVal || null; // prefer ISO YYYY-MM-DD when set
            // Unit value
            try {
                const sel = document.getElementById('productUnit');
                const custom = document.getElementById('productUnitCustom');
                if (sel) {
                    if (sel.value === 'custom') {
                        const v = (custom?.value || '').trim();
                        if (v) data.unit = v; else data.unit = '';
                    } else {
                        data.unit = sel.value || '';
                    }
                }
            } catch {}
            // Ensure QR contains SKU if empty
            try { if ((!data.qrCode || data.qrCode === '') && data.sku) data.qrCode = data.sku; } catch {}

            saveProductBtn.disabled = true;
            saveProductBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Menyimpan...';
            try {
                await ensureCsrfTokenReady();
                const url = currentEditId ? `/api/products/${currentEditId}` : '/api/products';
                const token = (window.csrfToken||'');
                // embed token in body too
                try { data._csrf = token; } catch {}
                let res = await fetch(url, {
                    method: currentEditId ? 'PUT' : 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-csrf-token': token, 'x-xsrf-token': token },
                    credentials: 'include',
                    body: JSON.stringify(data)
                });
                // 403 retry once after refreshing token
                if (res.status === 403) {
                    await ensureCsrfTokenReady(true);
                    const t2 = (window.csrfToken||'');
                    res = await fetch(url, {
                        method: currentEditId ? 'PUT' : 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-csrf-token': t2, 'x-xsrf-token': t2 },
                        credentials: 'include',
                        body: JSON.stringify(data)
                    });
                }
                const result = await res.json().catch(()=>({}));
                if (!res.ok) {
                    alert(result.message || 'Gagal menyimpan produk');
                    return;
                }
                await loadProducts();
                if (currentEditId) {
                    // Editing: tutup modal setelah update
                    bootstrap.Modal.getInstance(document.getElementById('productModal')).hide();
                    alert('Produk berhasil diupdate!');
                } else {
                    // Tambah baru: tutup modal agar konsisten dengan edit, dan menghindari kebingungan
                    bootstrap.Modal.getInstance(document.getElementById('productModal')).hide();
                    alert('Produk berhasil ditambahkan!');
                }
            } catch (error) {
                alert('Gagal menyimpan produk. Silakan coba lagi.');
            } finally {
                saveProductBtn.disabled = false;
                saveProductBtn.innerHTML = 'Simpan';
            }
        });
    }

    // Category Form
    const saveCategoryBtn = document.getElementById('saveCategoryBtn');
    if (saveCategoryBtn) {
        saveCategoryBtn.addEventListener('click', async () => {
            const name = document.getElementById('categoryName').value.trim();
            if (!name) { alert('Nama kategori wajib diisi!'); return; }
            const data = { name, description: document.getElementById('categoryDescription').value.trim() };
            saveCategoryBtn.disabled = true;
            saveCategoryBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Menyimpan...';
            try {
                const url = currentEditId ? `/api/categories/${currentEditId}` : '/api/categories';
                const res = await fetch(url, {
                    method: currentEditId ? 'PUT' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                const result = await res.json();
                if (!res.ok) {
                    alert(result.message || 'Gagal menyimpan kategori');
                    return;
                }
                bootstrap.Modal.getInstance(document.getElementById('categoryModal')).hide();
                await loadCategories();
                await loadInitialData();
                alert(currentEditId ? 'Kategori berhasil diupdate!' : 'Kategori berhasil ditambahkan!');
                document.getElementById('categoryForm').reset();
            } catch (error) {
                alert('Gagal menyimpan kategori. Silakan coba lagi.');
            } finally {
                saveCategoryBtn.disabled = false;
                saveCategoryBtn.innerHTML = 'Simpan';
            }
        });
    }

    // User Form
    const saveUserBtn = document.getElementById('saveUserBtn');
    if (saveUserBtn) {
        saveUserBtn.addEventListener('click', async () => {
            const username = document.getElementById('userUsername').value.trim();
            const name = document.getElementById('userNameField').value.trim();
            const password = document.getElementById('userPassword').value;
            const role = document.getElementById('userRole').value;
            const status = document.getElementById('userStatus').value;
            const userId = document.getElementById('userId').value;
            if (!username) { alert('Username wajib diisi!'); return; }
            if (!name) { alert('Nama lengkap wajib diisi!'); return; }
            if (!userId && !password) { alert('Password wajib diisi untuk user baru!'); return; }
            if (!role) { alert('Role wajib dipilih!'); return; }

            const data = { username, name, role, status };
            if (password) data.password = password;

            saveUserBtn.disabled = true;
            saveUserBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Menyimpan...';
            try {
                const url = userId ? `/api/users/${userId}` : '/api/users';
                const res = await fetch(url, {
                    method: userId ? 'PUT' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                const result = await res.json();
                if (!res.ok) {
                    alert(result.message || 'Gagal menyimpan user');
                    return;
                }
                bootstrap.Modal.getInstance(document.getElementById('userModal')).hide();
                await loadUsers();
                alert(userId ? 'User berhasil diupdate!' : 'User berhasil ditambahkan!');
                document.getElementById('userForm').reset();
                document.getElementById('passwordRequired').style.display = 'inline';
            } catch (error) {
                alert('Gagal menyimpan user. Silakan coba lagi.');
            } finally {
                saveUserBtn.disabled = false;
                saveUserBtn.innerHTML = 'Simpan';
            }
        });
    }

    // Banner Form - always bind on load
    const bannerForm = document.getElementById('bannerForm');
    if (bannerForm) {
        bannerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = bannerForm.querySelector('button[type="submit"]');
            const data = {
                title: document.getElementById('bannerTitle')?.value || '',
                subtitle: document.getElementById('bannerSubtitle')?.value || '',
                imageBase64: document.getElementById('bannerImageBase64')?.value || ''
            };
            if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Menyimpan...'; }
            try {
                const res = await fetch('/api/banner', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
                const result = await res.json();
                if (!res.ok) throw new Error(result.message || 'Gagal menyimpan banner');
                alert(result.message || 'Banner berhasil disimpan');
                await loadBanner();
            } catch (err) {
                alert(err.message || 'Gagal menyimpan banner');
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = 'Update Banner'; }
            }
        });
    }

    // QRIS Form - always bind on load
    const qrisForm = document.getElementById('qrisForm');
    if (qrisForm) {
        qrisForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = qrisForm.querySelector('button[type="submit"]');
            const data = {
                imageBase64: document.getElementById('qrisImageBase64')?.value || '',
                paymentLogoQrisBase64: document.getElementById('paymentLogoQrisBase64')?.value || '',
                paymentLogoDanaBase64: document.getElementById('paymentLogoDanaBase64')?.value || '',
                paymentLogoOvoBase64: document.getElementById('paymentLogoOvoBase64')?.value || ''
            };
            if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Menyimpan...'; }
            try {
                const res = await fetch('/api/qris', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
                const result = await res.json();
                if (!res.ok) throw new Error(result.message || 'Gagal menyimpan QRIS');
                alert(result.message || 'QRIS berhasil disimpan');
                await loadQris();
            } catch (err) {
                alert(err.message || 'Gagal menyimpan QRIS');
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = 'Update Gambar QRIS'; }
            }
        });
    }

    // Banner & QRIS Forms - handled earlier with specific listeners to correct endpoints

    // Image Upload
    ['product', 'banner', 'qris'].forEach(prefix => {
        const fileInput = document.getElementById(`${prefix}ImageFile`);
        if (fileInput) {
            fileInput.addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                try {
                    let outB64;
                    if (prefix === 'product') {
                        // Always process with EXIF fix + compression to ensure < 1MB
                        outB64 = await processImageFile(file, MAX_FILE_SIZE, 1280);
                    } else {
                        // Keep previous behavior for other contexts with simple size check
                        if (file.size > MAX_FILE_SIZE) {
                            alert(`File terlalu besar! Maksimal ${MAX_FILE_SIZE / 1024 / 1024}MB.`);
                            e.target.value = '';
                            document.getElementById(`${prefix}ImageBase64`).value = '';
                            const p = document.getElementById(`${prefix}Preview`);
                            if (p) p.style.display = 'none';
                            return;
                        }
                        outB64 = await readFileAsDataURL(file);
                    }
                    const ta = document.getElementById(`${prefix}ImageBase64`);
                    const prev = document.getElementById(`${prefix}Preview`);
                    if (ta) ta.value = outB64;
                    if (prev) { prev.src = outB64; prev.style.display = 'block'; }
                } catch (err) {
                    alert('Gagal memproses gambar. Coba file lain.');
                }
            });
        }
    });

    // Product Camera Capture (getUserMedia)
    try {
        const captureBtn = document.getElementById('productCaptureBtn');
        const galleryBtn = document.getElementById('productGalleryBtn');
        const modalEl = document.getElementById('productCameraModal');
        const videoEl = document.getElementById('productCameraVideo');
        const canvasEl = document.getElementById('productCameraCanvas');
        const takeBtn = document.getElementById('takeProductPhotoBtn');
        const switchBtn = document.getElementById('productSwitchCameraBtn');
        let productStream = null;
        let useFacing = 'environment';
        const startCamera = async () => {
            try {
                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    alert('Kamera tidak didukung di browser ini.');
                    return false;
                }
                productStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: useFacing } }, audio: false });
                if (videoEl) videoEl.srcObject = productStream;
                return true;
            } catch (err) {
                alert('Gagal mengakses kamera: ' + (err?.message || err));
                return false;
            }
        };
        const stopCamera = () => {
            try { (productStream?.getTracks() || []).forEach(t => t.stop()); } catch {}
            try { if (videoEl) videoEl.srcObject = null; } catch {}
            productStream = null;
        };
        if (modalEl) {
            modalEl.addEventListener('hidden.bs.modal', stopCamera);
            modalEl.addEventListener('show.bs.modal', async () => { await startCamera(); });
        }
        if (captureBtn && modalEl) {
            captureBtn.addEventListener('click', () => {
                const m = new bootstrap.Modal(modalEl);
                m.show();
            });
        }
        if (galleryBtn) {
            galleryBtn.addEventListener('click', () => {
                const fileInput = document.getElementById('productImageFile');
                if (fileInput) fileInput.click();
            });
        }
        if (switchBtn) {
            switchBtn.addEventListener('click', async () => {
                useFacing = useFacing === 'environment' ? 'user' : 'environment';
                stopCamera();
                await startCamera();
            });
        }
        if (takeBtn && videoEl && canvasEl && modalEl) {
            takeBtn.addEventListener('click', async () => {
                try {
                    const width = videoEl.videoWidth || 640;
                    const height = videoEl.videoHeight || 480;
                    canvasEl.width = width;
                    canvasEl.height = height;
                    const ctx = canvasEl.getContext('2d');
                    ctx.drawImage(videoEl, 0, 0, width, height);
                    let dataUrl = canvasEl.toDataURL('image/jpeg', 0.92);
                    // Compress to ensure < 1MB
                    dataUrl = await compressDataUrl(dataUrl, MAX_FILE_SIZE, 1280);
                    const ta = document.getElementById('productImageBase64');
                    const preview = document.getElementById('productPreview');
                    if (ta) {
                        ta.value = dataUrl;
                        try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
                    }
                    if (preview) { preview.src = dataUrl; preview.style.display = 'block'; }
                    // Close modal and stop camera
                    bootstrap.Modal.getInstance(modalEl)?.hide();
                    stopCamera();
                } catch (e) {
                    alert('Gagal mengambil foto. Coba lagi.');
                }
            });
        }
    } catch {}

    const settingsForm = document.getElementById('settingsForm');
    if (settingsForm) {
        const favFile = document.getElementById('settingsFaviconFile');
        const logoFile = document.getElementById('settingsLogoFile');
        const logoB64TA = document.getElementById('settingsLogoBase64');
        if (favFile) {
            favFile.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                if (file.size > MAX_FILE_SIZE) {
                    alert(`File terlalu besar! Maksimal ${MAX_FILE_SIZE / 1024 / 1024}MB.`);
                    e.target.value = '';
                    document.getElementById('settingsFaviconBase64').value = '';
                    const p = document.getElementById('settingsFaviconPreview');
                    if (p) { p.style.display = 'none'; p.src = ''; }
                    return;
                }
                const reader = new FileReader();
                reader.onloadend = () => {
                    const base64 = reader.result;
                    document.getElementById('settingsFaviconBase64').value = base64;
                    const p = document.getElementById('settingsFaviconPreview');
                    if (p) { p.src = base64; p.style.display = 'block'; }
                };
                reader.readAsDataURL(file);
            });
        }

        if (logoFile) {
            logoFile.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                if (file.size > MAX_FILE_SIZE) {
                    alert(`File terlalu besar! Maksimal ${MAX_FILE_SIZE / 1024 / 1024}MB.`);
                    e.target.value = '';
                    const p = document.getElementById('settingsLogoPreview');
                    if (p) { p.style.display = 'none'; p.src = ''; }
                    document.getElementById('settingsLogoBase64').value = '';
                    return;
                }
                const reader = new FileReader();
                reader.onloadend = () => {
                    const base64 = reader.result;
                    document.getElementById('settingsLogoBase64').value = base64;
                    const p = document.getElementById('settingsLogoPreview');
                    if (p) { p.src = base64; p.style.display = 'block'; }
                };
                reader.readAsDataURL(file);
            });
        }

        if (logoB64TA) {
            logoB64TA.addEventListener('input', () => {
                const v = logoB64TA.value || '';
                const p = document.getElementById('settingsLogoPreview');
                if (p) {
                    if (v && v.startsWith('data:')) { p.src = v; p.style.display = 'block'; }
                    else { p.src = ''; p.style.display = 'none'; }
                }
            });
        }

        // Payment logo file inputs (QRIS, DANA, OVO)
        const paymentLogoQrisFile = document.getElementById('paymentLogoQrisFile');
        const paymentLogoDanaFile = document.getElementById('paymentLogoDanaFile');
        const paymentLogoOvoFile = document.getElementById('paymentLogoOvoFile');

        function bindPaymentLogoInputLocal(fileEl, previewId, textareaId) {
            if (!fileEl) return;
            fileEl.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                if (file.size > MAX_FILE_SIZE) {
                    alert(`File terlalu besar! Maksimal ${MAX_FILE_SIZE / 1024 / 1024}MB.`);
                    e.target.value = '';
                    return;
                }
                const reader = new FileReader();
                reader.onloadend = () => {
                    const v = reader.result;
                    if (typeof v === 'string' && v.startsWith('data:image')) {
                        const p = document.getElementById(previewId);
                        if (p) { p.src = v; p.style.display = 'block'; }
                        if (textareaId) {
                            const ta = document.getElementById(textareaId);
                            if (ta) ta.value = v;
                        }
                    }
                };
                reader.readAsDataURL(file);
            });
        }

        bindPaymentLogoInputLocal(paymentLogoQrisFile, 'paymentLogoQrisPreview', 'paymentLogoQrisBase64');
        bindPaymentLogoInputLocal(paymentLogoDanaFile, 'paymentLogoDanaPreview', 'paymentLogoDanaBase64');
        bindPaymentLogoInputLocal(paymentLogoOvoFile, 'paymentLogoOvoPreview', 'paymentLogoOvoBase64');

        // Clear buttons for payment logos
        function bindClearPaymentLogo(btnId, fileId, taId, previewId) {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            btn.addEventListener('click', () => {
                const fileEl = document.getElementById(fileId);
                const ta = document.getElementById(taId);
                const prev = document.getElementById(previewId);
                if (fileEl) fileEl.value = '';
                if (ta) ta.value = '';
                if (prev) { prev.src = ''; prev.style.display = 'none'; }
            });
        }

        bindClearPaymentLogo('clearPaymentLogoQrisBtn', 'paymentLogoQrisFile', 'paymentLogoQrisBase64', 'paymentLogoQrisPreview');
        bindClearPaymentLogo('clearPaymentLogoDanaBtn', 'paymentLogoDanaFile', 'paymentLogoDanaBase64', 'paymentLogoDanaPreview');
        bindClearPaymentLogo('clearPaymentLogoOvoBtn', 'paymentLogoOvoFile', 'paymentLogoOvoBase64', 'paymentLogoOvoPreview');

        // Login branding file inputs
        const loginLogoFile = document.getElementById('loginLogoFile');
        if (loginLogoFile) {
            loginLogoFile.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                if (file.size > MAX_FILE_SIZE) { alert(`File terlalu besar! Maksimal ${MAX_FILE_SIZE / 1024 / 1024}MB.`); e.target.value = ''; return; }
                const reader = new FileReader();
                reader.onloadend = () => {
                    const v = reader.result;
                    const ta = document.getElementById('loginLogoBase64');
                    const p = document.getElementById('loginLogoPreview');
                    if (ta) ta.value = v;
                    if (p) { p.src = v; p.style.display = 'block'; }
                };
                reader.readAsDataURL(file);
            });
        }
        
        // Cart sound file input
        const cartSoundFile = document.getElementById('cartSoundFile');
        if (cartSoundFile) {
            cartSoundFile.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                // Maksimal 500KB untuk file audio
                if (file.size > 500 * 1024) { 
                    alert('File terlalu besar! Maksimal 500KB.'); 
                    e.target.value = ''; 
                    return; 
                }
                const reader = new FileReader();
                reader.onloadend = () => {
                    const v = reader.result;
                    // Validasi bahwa ini adalah file audio
                    if (!v.startsWith('data:audio/')) {
                        alert('File harus berupa audio (MP3 atau WAV)');
                        e.target.value = '';
                        return;
                    }
                    // Simpan base64 untuk dikirim ke server
                    const audio = document.getElementById('cartSoundPreview');
                    if (audio) {
                        audio.src = v;
                        audio.style.display = 'block';
                    }
                };
                reader.readAsDataURL(file);
            });
        }
        const loginBackgroundFile = document.getElementById('loginBackgroundFile');
        if (loginBackgroundFile) {
            loginBackgroundFile.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                if (file.size > MAX_FILE_SIZE) { alert(`File terlalu besar! Maksimal ${MAX_FILE_SIZE / 1024 / 1024}MB.`); e.target.value=''; return; }
                const reader = new FileReader();
                reader.onloadend = () => {
                    const v = reader.result;
                    const ta = document.getElementById('loginBackgroundBase64');
                    const p = document.getElementById('loginBackgroundPreview');
                    if (ta) ta.value = v;
                    if (p) { p.src = v; p.style.display = 'block'; }
                };
                reader.readAsDataURL(file);
            });
        }
        // Live preview from textareas
        document.getElementById('loginLogoBase64')?.addEventListener('input', (e) => {
            const v = e.target.value;
            const p = document.getElementById('loginLogoPreview');
            if (p) { if (v && v.startsWith('data:')) { p.src = v; p.style.display = 'block'; } else { p.src=''; p.style.display='none'; } }
        });
        document.getElementById('loginBackgroundBase64')?.addEventListener('input', (e) => {
            const v = e.target.value;
            const p = document.getElementById('loginBackgroundPreview');
            if (p) { if (v && v.startsWith('data:')) { p.src = v; p.style.display = 'block'; } else { p.src=''; p.style.display='none'; } }
        });

        // Inject Sync Settings section if not present
        try {
            if (false && !document.getElementById('syncSettingsSection')) {
                const container = document.createElement('div');
                container.className = 'card mt-3';
                container.id = 'syncSettingsSection';
                container.innerHTML = `
                    <div class="card-header d-flex justify-content-between align-items-center">
                        <h5 class="mb-0">Sinkronisasi (Offline ⇄ Online)</h5>
                        <div class="d-flex gap-2">
                            <button type="button" class="btn btn-sm btn-outline-secondary" id="syncStatusBtn">Cek Status</button>
                            <button type="button" class="btn btn-sm btn-outline-primary" id="syncPushBtn">Kirim Data</button>
                            <button type="button" class="btn btn-sm btn-outline-primary" id="syncPullBtn">Tarik Data</button>
                            <button type="button" class="btn btn-sm btn-primary" id="syncNowBtn">Sinkron Sekarang</button>
                        </div>
                    </div>
                    <div class="card-body">
                        <div class="row g-3">
                            <div class="col-md-12">
                                <div class="form-check form-switch">
                                    <input class="form-check-input" type="checkbox" id="syncEnabled">
                                    <label class="form-check-label" for="syncEnabled">Aktifkan Sinkronisasi</label>
                                </div>
                            </div>
                            <div class="col-md-8">
                                <label class="form-label">Base URL Server Pusat</label>
                                <input type="url" class="form-control" id="syncBaseUrl" placeholder="https://server-pusat-anda.com">
                            </div>
                            <div class="col-md-4">
                                <label class="form-label">Token (Bearer)</label>
                                <input type="password" class="form-control" id="syncToken" placeholder="Opsional">
                            </div>
                        </div>
                        <div class="form-text mt-2" id="syncStatusText">Atur URL server pusat Anda, lalu klik Cek Status untuk melihat koneksi.</div>
                    </div>`;
                // Append before submit button if any
                const submitBtn = settingsForm.querySelector('button[type="submit"]');
                if (submitBtn && submitBtn.parentElement) {
                    submitBtn.parentElement.parentElement.insertBefore(container, submitBtn.parentElement);
                } else {
                    settingsForm.appendChild(container);
                }
                // Wire status button
                const statusBtn = container.querySelector('#syncStatusBtn');
                if (statusBtn) {
                    statusBtn.addEventListener('click', async () => {
                        try {
                            const res = await fetch('/api/sync/status', { cache: 'no-store' });
                            if (!res.ok) throw new Error('Gagal memuat status');
                            const j = await res.json();
                            if (j && j.pulled && j.pulled.error) {
                                const detail = j.pulled.body || j.pulled.statusText || j.pulled.detail || 'Unknown error';
                                if (el) el.textContent = `Sinkron gagal saat tarik: ${detail}`;
                                const html = `
                                  <div class="d-flex justify-content-between align-items-center mb-2">
                                    <div><span class="badge bg-danger">Sinkron Gagal (Tarik)</span></div>
                                  </div>
                                  <p>Kesalahan saat menarik data dari server:</p>
                                  <pre class="bg-light p-2 rounded border" style="max-height:220px;overflow:auto">${detail}</pre>`;
                                showResultModal(html);
                                return;
                            }
                            const text = `Enabled: ${j.enabled ? 'Ya' : 'Tidak'} | BaseURL: ${j.baseUrl || '-'} | Outbox: ${j.outboxSize} | Last Push: ${j.lastPushAt || 0} | Last Pull: ${j.lastPullAt || 0}`;
                            const el = document.getElementById('syncStatusText');
                            if (el) el.textContent = text;
                        } catch (e) {
                            const el = document.getElementById('syncStatusText');
                            if (el) el.textContent = 'Tidak bisa mengambil status sinkronisasi.';
                        }
                    });
                }
                const pushBtn = container.querySelector('#syncPushBtn');
                if (pushBtn) {
                    pushBtn.addEventListener('click', async () => {
                        const el = document.getElementById('syncStatusText');
                        if (el) el.textContent = 'Mengirim data ke server...';
                        try {
                            // Ensure latest Sync config is saved before pushing
                            try {
                                const syncEnabled = !!document.getElementById('syncEnabled')?.checked;
                                const syncBaseUrl = document.getElementById('syncBaseUrl')?.value?.trim() || '';
                                const syncToken = document.getElementById('syncToken')?.value || '';
                                await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sync: { enabled: syncEnabled, baseUrl: syncBaseUrl, token: syncToken } }) });
                            } catch {}
                            const res = await fetch('/api/sync/push-local', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                            if (!res.ok) throw new Error('Gagal kirim');
                            const j = await res.json();
                            if (j && j.pushed && j.pushed.error) {
                                const detail = j.pushed.body || j.pushed.statusText || j.pushed.detail || 'Unknown error';
                                if (el) el.textContent = 'Gagal mengirim data: ' + detail;
                                alert('Kirim data gagal: ' + detail);
                                return;
                            }
                            const pushed = j?.pushed?.pushed ?? 0;
                            const applied = j?.pushed?.server?.applied ?? null;
                            if (el) el.textContent = applied != null ? `Pushed: ${pushed} | Applied di server: ${applied}` : `Pushed: ${pushed}`;
                            alert(applied != null ? `Kirim selesai. Terkirim: ${pushed} | Diterapkan di server: ${applied}` : `Kirim selesai. Terkirim: ${pushed}`);
                        } catch (e) {
                            if (el) el.textContent = 'Gagal mengirim data.';
                            alert('Kirim data gagal');
                        }
                    });
                }
                const pullBtn = container.querySelector('#syncPullBtn');
                if (pullBtn) {
                    pullBtn.addEventListener('click', async () => {
                        const el = document.getElementById('syncStatusText');
                        if (el) el.textContent = 'Menarik data dari server...';
                        try {
                            // Ensure latest Sync config is saved before pulling
                            try {
                                const syncEnabled = !!document.getElementById('syncEnabled')?.checked;
                                const syncBaseUrl = document.getElementById('syncBaseUrl')?.value?.trim() || '';
                                const syncToken = document.getElementById('syncToken')?.value || '';
                                await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sync: { enabled: syncEnabled, baseUrl: syncBaseUrl, token: syncToken } }) });
                            } catch {}
                            const res = await fetch('/api/sync/pull-remote', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                            if (!res.ok) throw new Error('Gagal tarik');
                            const j = await res.json();
                            if (j && j.pulled && j.pulled.error) {
                                const detail = j.pulled.body || j.pulled.statusText || j.pulled.detail || 'Unknown error';
                                if (el) el.textContent = 'Gagal menarik data: ' + detail;
                                alert('Tarik data gagal: ' + detail);
                                return;
                            }
                            if (el) el.textContent = `Pulled: ${j?.pulled?.pulled ?? 0}`;
                            alert(`Tarik selesai. Masuk: ${j?.pulled?.pulled ?? 0}`);
                        } catch (e) {
                            if (el) el.textContent = 'Gagal menarik data.';
                            alert('Tarik data gagal');
                        }
                    });
                }
                const syncNowBtn = container.querySelector('#syncNowBtn');
                if (syncNowBtn) {
                    // helper to build bullet list HTML
                    const ul = (items) => `<ul>${items.map(li => `<li>${li}</li>`).join('')}</ul>`;
                    const listByFile = (byFile, idsByFile) => {
                        const files = Object.keys(byFile || {});
                        if (!files.length) return '<p class="text-muted mb-0">Tidak ada perubahan.</p>';
                        return ul(files.map(f => {
                            const ids = (idsByFile && idsByFile[f]) ? idsByFile[f] : [];
                            const idsList = ids.length ? ul(ids.map(id => String(id))) : '<ul><li class="text-muted">(tanpa ID)</li></ul>';
                            return `<b>${f}</b>: ${byFile[f]} item${byFile[f]>1?'s':''}${idsList}`;
                        }));
                    };
                    const ensureModal = () => {
                        let modal = document.getElementById('syncResultModal');
                        if (!modal) {
                            const div = document.createElement('div');
                            div.innerHTML = `
                              <div class="modal fade" id="syncResultModal" tabindex="-1">
                                <div class="modal-dialog modal-lg">
                                  <div class="modal-content">
                                    <div class="modal-header">
                                      <h5 class="modal-title">Hasil Sinkronisasi</h5>
                                      <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                                    </div>
                                    <div class="modal-body" id="syncResultBody"></div>
                                    <div class="modal-footer">
                                      <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Tutup</button>
                                    </div>
                                  </div>
                                </div>
                              </div>`;
                            document.body.appendChild(div.firstElementChild);
                            modal = document.getElementById('syncResultModal');
                        }
                        return modal;
                    };
                    const showResultModal = (html) => {
                        const modal = ensureModal();
                        const body = modal.querySelector('#syncResultBody');
                        if (body) body.innerHTML = html;
                        const m = bootstrap.Modal.getOrCreateInstance(modal);
                        m.show();
                    };
                    syncNowBtn.addEventListener('click', async () => {
                        const el = document.getElementById('syncStatusText');
                        if (el) el.textContent = 'Menjalankan sinkronisasi...';
                        try {
                            // Ensure latest Sync config is saved before syncing now
                            try {
                                const syncEnabled = !!document.getElementById('syncEnabled')?.checked;
                                const syncBaseUrl = document.getElementById('syncBaseUrl')?.value?.trim() || '';
                                const syncToken = document.getElementById('syncToken')?.value || '';
                                await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sync: { enabled: syncEnabled, baseUrl: syncBaseUrl, token: syncToken } }) });
                            } catch {}
                            let __stopSyncPoll = false;
                            const __pollProgress = async () => {
                                while(!__stopSyncPoll){
                                    try {
                                        const r = await fetch('/api/sync/progress', { cache: 'no-store' });
                                        if (r && r.ok) {
                                            const j = await r.json();
                                            const p = (j && j.progress) || {};
                                            const e = document.getElementById('syncStatusText');
                                            if (e) {
                                                let txt = 'Sedang sinkron...';
                                                if (p && p.phase === 'pull1') txt = 'Menarik data dari server...';
                                                else if (p && p.phase === 'push') {
                                                    const b = p.batchIndex || 0; const n = p.batches || 0;
                                                    txt = `Mengirim data ke server: batch ${b}/${n}`;
                                                } else if (p && p.phase === 'pull2') txt = 'Menarik data dari server...';
                                                
                                                // Clean any detailed item names that might be added
                                                txt = txt.replace(/\s*\d+%\s*\[.*?\]/g, ''); // Remove "76% [Item Name]"
                                                txt = txt.replace(/\s*\[.*?\]/g, ''); // Remove any [bracketed text]
                                                txt = txt.replace(/\s*\d+%/g, ''); // Remove standalone percentages
                                                
                                                e.textContent = txt;
                                            }
                                        }
                                    } catch {}
                                    await new Promise(r => setTimeout(r, 800));
                                }
                            };
                            __pollProgress();
                            const res = await fetch('/api/sync/now', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                            __stopSyncPoll = true;
                            if (!res.ok) throw new Error('Gagal menjalankan sinkronisasi');
                            const j = await res.json();
                            const statusRes = await fetch('/api/sync/status', { cache: 'no-store' });
                            const s = statusRes.ok ? await statusRes.json() : {};
                            if (el) el.textContent = `Pushed: ${j?.pushed?.pushed ?? 0}${j?.pushed?.error?' (error)':''}, Pulled: ${j?.pulled?.pulled ?? 0}${j?.pulled?.error?' (error)':''}. Outbox: ${s?.outboxSize ?? '-'} | Last Push: ${s?.lastPushAt ?? 0} | Last Pull: ${s?.lastPullAt ?? 0}`;
                            const ok = j && j.success === true && !j?.pushed?.error && !j?.pulled?.error;
                            const when = j?.meta?.at ? new Date(j.meta.at).toLocaleString() : new Date().toLocaleString();
                            const who = j?.meta?.user || '';
                            const pushedHtml = `
                              <div class="mb-3">
                                <h6 class="mb-1">Terkirim ke Server</h6>
                                ${listByFile(j?.pushed?.summary?.byFile || {}, j?.pushed?.summary?.idsByFile || {})}
                              </div>`;
                            const serverAck = j?.pushed?.server;
                            const serverHtml = serverAck && typeof serverAck === 'object'
                              ? `<div class="mb-3"><h6 class="mb-1">Respon Server</h6><pre class="bg-light p-2 rounded border" style="max-height:220px;overflow:auto">${JSON.stringify(serverAck, null, 2)}</pre></div>`
                              : '';
                            const pulledHtml = `
                              <div class="mb-3">
                                <h6 class="mb-1">Masuk ke Lokal</h6>
                                ${listByFile(j?.pulled?.summary?.byFile || {}, j?.pulled?.summary?.idsByFile || {})}
                              </div>`;
                            const integrityHtml = j?.meta?.integrity && typeof j.meta.integrity === 'object'
                              ? `<div class="mb-3"><h6 class="mb-1">Checksum (Integrity)</h6><pre class="bg-light p-2 rounded border" style="max-height:220px;overflow:auto">${JSON.stringify(j.meta.integrity, null, 2)}</pre></div>`
                              : '';
                            const statusBadge = ok ? '<span class="badge bg-success">Sinkron Sukses</span>' : '<span class="badge bg-danger">Sinkron Gagal</span>';
                            const html = `
                              <div class="d-flex justify-content-between align-items-center mb-2">
                                <div>${statusBadge}</div>
                                <div class="small text-muted text-end">
                                  <div><b>Waktu:</b> ${when}</div>
                                  ${who ? `<div><b>Pengguna:</b> ${who}</div>` : ''}
                                  <div>Outbox: ${s?.outboxSize ?? '-'} | Last Push: ${s?.lastPushAt ?? 0} | Last Pull: ${s?.lastPullAt ?? 0}</div>
                                </div>
                              </div>
                              ${pushedHtml}
                              ${serverHtml}
                              ${pulledHtml}
                              ${integrityHtml}
                            `;
                            showResultModal(html);
                        } catch (e) {
                            try { __stopSyncPoll = true; } catch {}
                            if (el) el.textContent = 'Sinkronisasi gagal dijalankan.';
                            const html = `
                              <div class="d-flex justify-content-between align-items-center mb-2">
                                <div><span class="badge bg-danger">Sinkron Gagal</span></div>
                              </div>
                              <p>Terjadi kesalahan saat menjalankan sinkronisasi. Silakan coba lagi.</p>`;
                            showResultModal(html);
                        }
                    });
                }
            }
        } catch {}

        settingsForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = settingsForm.querySelector('button[type="submit"]');
            if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Menyimpan...'; }
            try {
                const prevEncEnabled = !!(appSettings && appSettings.encryption && appSettings.encryption.enabled);
                const payload = {
                    storeName: document.getElementById('storeName')?.value?.trim() || 'POS System',
                    faviconBase64: document.getElementById('settingsFaviconBase64')?.value || '',
                    logoBase64: document.getElementById('settingsLogoBase64')?.value || '',
                    taxRate: parseFloat(document.getElementById('taxRate')?.value || '0') || 0,
                    serviceRate: parseFloat(document.getElementById('serviceRate')?.value || '0') || 0,
                    priceIncludesTax: !!document.getElementById('priceIncludesTax')?.checked,
                    currencySymbol: document.getElementById('currencySymbol')?.value || 'Rp',
                    thousandSeparator: document.getElementById('thousandSeparator')?.value || '.',
                    decimalSeparator: document.getElementById('decimalSeparator')?.value || ',',
                    currencyPrecision: parseInt(document.getElementById('currencyPrecision')?.value || '0', 10) || 0,
                    receiptFooter: document.getElementById('receiptFooter')?.value || '',
                    receiptFooter1: document.getElementById('receiptFooter1')?.value || '',
                    address: document.getElementById('storeAddress')?.value || '',
                    phone: document.getElementById('storePhone')?.value || '',
                    themeColor: document.getElementById('themeColor')?.value || '#198754',
                    darkMode: !!document.getElementById('darkMode')?.checked,
                    showReceiptAddress: !!document.getElementById('showReceiptAddress')?.checked,
                    showReceiptPhone: !!document.getElementById('showReceiptPhone')?.checked,
                    showReceiptFooter: !!document.getElementById('showReceiptFooter')?.checked,
                    paperWidth: parseInt(document.getElementById('paperWidth')?.value || '80', 10) || 80,
                    loginTitle: document.getElementById('loginTitle')?.value || '',
                    loginLogoBase64: document.getElementById('loginLogoBase64')?.value || '',
                    loginBackgroundBase64: document.getElementById('loginBackgroundBase64')?.value || '',
                    loginLogoSize: document.getElementById('loginLogoSize')?.value || 'medium',
                    // New toggles
                    allowDuplicateSku: !!document.getElementById('allowDuplicateSku')?.checked,
                    allowDuplicateProductNames: !!document.getElementById('allowDuplicateProductNames')?.checked,
                    posShowBanner: !!document.getElementById('posShowBanner')?.checked,
                    posShowProductBorders: !!document.getElementById('posShowProductBorders')?.checked,
                    enableCartSound: !!document.getElementById('enableCartSound')?.checked,
                    cartSoundBase64: document.getElementById('cartSoundPreview')?.src || '',
                    paymentLogoQrisBase64: document.getElementById('paymentLogoQrisBase64')?.value || document.getElementById('paymentLogoQrisPreview')?.src || '',
                    paymentLogoDanaBase64: document.getElementById('paymentLogoDanaBase64')?.value || document.getElementById('paymentLogoDanaPreview')?.src || '',
                    paymentLogoOvoBase64: document.getElementById('paymentLogoOvoBase64')?.value || document.getElementById('paymentLogoOvoPreview')?.src || '',
                    showPurgeAllProducts: !!document.getElementById('showPurgeAllProducts')?.checked
                };
                // Include sync settings
                try {
                    const syncEnabled = !!document.getElementById('syncEnabled')?.checked;
                    const syncBaseUrl = document.getElementById('syncBaseUrl')?.value?.trim() || '';
                    const syncToken = document.getElementById('syncToken')?.value || '';
                    payload.sync = { enabled: syncEnabled, baseUrl: syncBaseUrl, token: syncToken };
                } catch {}
                // Include AI settings
                try {
                    const provider = document.getElementById('aiProvider')?.value || 'none';
                    const openaiApiKey = document.getElementById('openaiApiKey')?.value || '';
                    const geminiApiKey = document.getElementById('geminiApiKey')?.value || '';
                    const googleApiKey = document.getElementById('googleApiKey')?.value || '';
                    const imageSize = document.getElementById('aiImageSize')?.value || '1024x1024';
                    payload.aiConfig = { provider, openaiApiKey, geminiApiKey, googleApiKey, imageSize };
                } catch {}
                try {
                    const encToggle = document.getElementById('encryptionEnabled');
                    if (encToggle) {
                        const en = !!encToggle.checked;
                        payload.encryption = { enabled: en };
                    }
                } catch {}

                // Pastikan token CSRF tersedia sebelum menyimpan pengaturan
                await ensureCsrfTokenReady();
                let token = (window.csrfToken || '');
                let res = await fetch('/api/settings', {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-csrf-token': token,
                        'x-xsrf-token': token
                    },
                    body: JSON.stringify(payload)
                });
                let result = await res.json();
                // Jika terkena 403 karena token kedaluwarsa, coba refresh token sekali lagi
                if (res.status === 403) {
                    await ensureCsrfTokenReady(true);
                    token = (window.csrfToken || '');
                    res = await fetch('/api/settings', {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-csrf-token': token,
                            'x-xsrf-token': token
                        },
                        body: JSON.stringify(payload)
                    });
                    result = await res.json().catch(() => ({}));
                }
                if (!res.ok) throw new Error(result.message || 'Gagal menyimpan pengaturan');
                await loadSettings();
                try {
                    const curEncEnabled = !!(appSettings && appSettings.encryption && appSettings.encryption.enabled);
                    if (curEncEnabled && !prevEncEnabled) {
                        if (confirm('Enkripsi database diaktifkan. Enkripsi semua file JSON plaintext sekarang?')) {
                            const r = await fetch('/api/admin/encrypt-migrate', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                            const j = await r.json().catch(()=>({}));
                            if (!r.ok || !j.success) alert(j.message || 'Encrypt migrate gagal');
                        }
                    } else if (!curEncEnabled && prevEncEnabled) {
                        if (confirm('Enkripsi database dinonaktifkan. Ubah semua file JSON terenkripsi menjadi plaintext sekarang? (butuh passphrase server yang benar)')) {
                            const r = await fetch('/api/admin/decrypt-all', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                            const j = await r.json().catch(()=>({}));
                            if (!r.ok || !j.success) alert(j.message || 'Decrypt semua file gagal');
                        }
                    }
                } catch {}
                const link = document.querySelector('link[rel="icon"]');
                if (link) {
                    const v = Date.now();
                    const base = (appSettings && appSettings.faviconBase64) ? '/favicon.ico' : 'data:,';
                    link.setAttribute('href', base === '/favicon.ico' ? `${base}?v=${v}` : base);
                }
                alert(result.message || 'Pengaturan berhasil disimpan');
            } catch (err) {
                alert(err.message || 'Gagal menyimpan pengaturan');
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = 'Simpan Pengaturan'; }
            }
        });
    }
}

// --- Product: Generate Image (AI) ---
(function(){
    try {
        const btn = document.getElementById('generateProductImageBtn');
        if (btn) {
            btn.addEventListener('click', async () => {
                const nameEl = document.getElementById('productName');
                const skuEl = document.getElementById('productSku');
                const promptBase = (nameEl?.value || '').trim();
                const sku = (skuEl?.value || '').trim();
                if (!promptBase && !sku) { alert('Isi nama produk atau SKU terlebih dahulu.'); return; }
                // Build search query based on SKU / Name
                const q = (sku || promptBase || '').trim();
                btn.disabled = true;
                const prevHtml = btn.innerHTML;
                btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Mencari...';
                try {
                    // Cari produk yang cocok
                    const params = new URLSearchParams();
                    params.set('q', q);
                    params.set('limit', '5');
                    // minta bidang minimum agar efisien
                    params.set('fields', 'id,sku,name,imageBase64,categoryId,category');
                    const res = await fetch(`/api/products?${params.toString()}`, { credentials: 'include', cache: 'no-store' });
                    if (!res.ok) throw new Error('Gagal mencari produk');
                    let list = await res.json().catch(()=>[]);
                    if (!Array.isArray(list)) list = [];
                    // Prioritaskan kecocokan SKU persis, lalu nama berisi, lalu kategori
                    const lc = (s) => (s==null?'' : String(s)).toLowerCase();
                    const lq = lc(q);
                    let found = null;
                    if (sku) {
                        found = list.find(p => lc(p?.sku) === lc(sku)) || null;
                    }
                    if (!found && promptBase) {
                        found = list.find(p => lc(p?.name||'').includes(lq)) || null;
                    }
                    if (!found) {
                        found = list[0] || null;
                    }
                    if (!found) throw new Error('Produk tidak ditemukan');
                    const dataUrlRaw = String(found.imageBase64 || '').trim();
                    let dataUrl = dataUrlRaw;
                    // Jika produk belum punya image, gunakan AI finder (internet) untuk mencari gambar yang relevan
                    if (!dataUrl) {
                        await ensureCsrfTokenReady();
                        const token = (window.csrfToken||'');
                        const categoryName = (found && (found.category || '')) || '';
                        const combinedQ = `${(promptBase || found.name || '').trim()} ${(sku || '').trim()} ${categoryName.trim()}`.trim();
                        const body = {
                            // Gabungkan Nama/SKU/Kategori agar hasil lebih akurat
                            q: combinedQ || q,
                            sku, name: (promptBase || found.name || ''),
                            // optional provider keys from window (set via DevTools)
                            unsplashKey: (window.UNSPLASH_ACCESS_KEY || ''),
                            pexelsKey: (window.PEXELS_API_KEY || ''),
                            bingKey: (window.BING_IMAGE_SEARCH_KEY || ''),
                            googleKey: (window.GOOGLE_CSE_KEY || ''),
                            googleCx: (window.GOOGLE_CSE_CX || '')
                        };
                        const aiRes = await fetch('/api/ai/find-image', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'x-csrf-token': token, 'x-xsrf-token': token },
                            credentials: 'include',
                            body: JSON.stringify(body)
                        });
                        const aiData = await aiRes.json().catch(()=>({}));
                        if (!aiRes.ok || !aiData || !aiData.imageBase64) {
                            throw new Error(aiData && aiData.message ? aiData.message : 'Produk ditemukan tetapi tidak memiliki gambar base64');
                        }
                        dataUrl = String(aiData.imageBase64 || '').trim();
                    }
                    if (!dataUrl) throw new Error('Produk ditemukan tetapi tidak memiliki gambar base64');
                    if (!dataUrl.startsWith('data:')) {
                        dataUrl = 'data:image/png;base64,' + dataUrl;
                    }
                    // Kompres agar < 1MB bila perlu
                    try { dataUrl = await compressDataUrl(dataUrl, MAX_FILE_SIZE, 1024); } catch {}
                    const ta = document.getElementById('productImageBase64');
                    const preview = document.getElementById('productPreview');
                    if (ta) ta.value = dataUrl;
                    if (preview) { preview.src = dataUrl; preview.style.display = 'block'; }
                } catch (e) {
                    alert(e.message || 'Gagal mengambil gambar dari data produk');
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = prevHtml;
                }
            });
        }
    } catch {}
})();

// Sync preview with Base64 textarea value
(function(){
    try {
        const ta = document.getElementById('productImageBase64');
        const preview = document.getElementById('productPreview');
        const apply = () => {
            try {
                const v = (ta && ta.value ? String(ta.value).trim() : '');
                if (!preview) return;
                if (v) {
                    let url = v;
                    if (!url.startsWith('data:')) { url = 'data:image/png;base64,' + url; }
                    preview.src = url;
                    preview.style.display = 'block';
                } else {
                    preview.src = '';
                    preview.style.display = 'none';
                }
            } catch {}
        };
        if (ta) {
            ta.addEventListener('input', apply);
            ta.addEventListener('change', apply);
            setTimeout(apply, 0);
        }
    } catch {}
})();

async function loadSettings() {
    try {
        const res = await fetch('/api/settings', { cache: 'no-store' });
        if (!res.ok) throw new Error('Gagal memuat pengaturan');
        const settings = await res.json();
        appSettings = settings;
        try { const el = document.getElementById('allowDuplicateSku'); if (el) el.checked = !!settings.allowDuplicateSku; } catch {}
        try { const el = document.getElementById('allowDuplicateProductNames'); if (el) el.checked = !!settings.allowDuplicateProductNames; } catch {}
        try { const el2 = document.getElementById('posShowBanner'); if (el2) el2.checked = settings.posShowBanner !== false; } catch {}
        try { const el3 = document.getElementById('showPurgeAllProducts'); if (el3) el3.checked = !!settings.showPurgeAllProducts; } catch {}
        try { const el4 = document.getElementById('posShowProductBorders'); if (el4) el4.checked = settings.posShowProductBorders !== false; } catch {}
        
        // Update duplicate removal button state based on toggle settings
        try { updateDuplicateRemovalButtonState(); } catch {}
        try {
            const enc = (settings && settings.encryption) || {};
            const encToggle = document.getElementById('encryptionEnabled');
            if (encToggle) encToggle.checked = !!enc.enabled;
        } catch {}
        try { 
            const enableSound = document.getElementById('enableCartSound'); 
            if (enableSound) enableSound.checked = !!settings.enableCartSound;
            const soundPreview = document.getElementById('cartSoundPreview');
            if (soundPreview && settings.cartSoundBase64) {
                soundPreview.src = settings.cartSoundBase64;
                soundPreview.style.display = 'block';
            }
        } catch {}
        // Payment logos are now managed via QRIS view (/api/qris)
        // Populate auto-backup controls if present
        try {
            const ab = appSettings.autoBackup || {};
            const en = document.getElementById('autoBackupEnabled'); if (en) en.checked = !!ab.enabled;
            const md = document.getElementById('autoBackupMode'); if (md) md.value = ab.mode || 'off';
            const rt = document.getElementById('autoBackupRetention'); if (rt) rt.value = Number(ab.retentionDays || 0);
            const mc = document.getElementById('autoBackupMaxCount'); if (mc) mc.value = Math.max(1, Number(ab.maxCount || 10));
        } catch {}
        applySettingsToDocument(settings);
        const nameEl = document.getElementById('storeName');
        const favB64El = document.getElementById('settingsFaviconBase64');
        const logoB64El = document.getElementById('settingsLogoBase64');
        const favPrev = document.getElementById('settingsFaviconPreview');
        const logoPrev = document.getElementById('settingsLogoPreview');
        const receiptFooter = document.getElementById('receiptFooter');
        const receiptFooter1 = document.getElementById('receiptFooter1');
        const addr = document.getElementById('storeAddress');
        const phone = document.getElementById('storePhone');
        const taxRate = document.getElementById('taxRate');
        const serviceRate = document.getElementById('serviceRate');
        const priceIncludesTax = document.getElementById('priceIncludesTax');
        const currencySymbol = document.getElementById('currencySymbol');
        const thousandSeparator = document.getElementById('thousandSeparator');
        const decimalSeparator = document.getElementById('decimalSeparator');
        const currencyPrecision = document.getElementById('currencyPrecision');
        if (nameEl) {
            nameEl.value = settings.storeName || '';
            try {
                fetch('/api/license/status', { headers: { 'Accept': 'application/json' } })
                    .then(function (r) { return r && r.ok ? r.json() : null; })
                    .then(function (d) {
                        try {
                            if (d && d.offline && d.offline.valid) {
                                nameEl.readOnly = true;
                                nameEl.classList.add('bg-light');
                            }
                        } catch (e) {}
                    })
                    .catch(function () {});
            } catch (e) {}
        }
        if (favB64El) favB64El.value = settings.faviconBase64 || '';
        if (favPrev && settings.faviconBase64) { favPrev.src = settings.faviconBase64; favPrev.style.display = 'block'; }
        if (logoB64El) logoB64El.value = settings.logoBase64 || '';
        if (logoPrev && settings.logoBase64) { logoPrev.src = settings.logoBase64; logoPrev.style.display = 'block'; }
        if (receiptFooter) receiptFooter.value = settings.receiptFooter || '';
        if (receiptFooter1) receiptFooter1.value = settings.receiptFooter1 || '';
        if (addr) addr.value = settings.address || '';
        if (phone) phone.value = settings.phone || '';
        if (taxRate) taxRate.value = (settings.taxRate ?? 0);
        if (serviceRate) serviceRate.value = (settings.serviceRate ?? 0);
        if (priceIncludesTax) priceIncludesTax.checked = !!settings.priceIncludesTax;
        if (currencySymbol) currencySymbol.value = settings.currencySymbol || 'Rp';
        if (thousandSeparator) thousandSeparator.value = settings.thousandSeparator || '.';
        if (decimalSeparator) decimalSeparator.value = settings.decimalSeparator || ',';
        if (currencyPrecision) currencyPrecision.value = String(settings.currencyPrecision ?? 0);
        // Sync settings populate
        try {
            const sync = settings.sync || {};
            const se = document.getElementById('syncEnabled'); if (se) se.checked = !!sync.enabled;
            const sb = document.getElementById('syncBaseUrl'); if (sb) sb.value = sync.baseUrl || '';
            const st = document.getElementById('syncToken'); if (st) st.value = sync.token || '';
        } catch {}
        // AI settings populate
        try {
            const ai = settings.aiConfig || {};
            const prov = document.getElementById('aiProvider'); if (prov) prov.value = ai.provider || 'none';
            const k1 = document.getElementById('openaiApiKey'); if (k1) k1.value = ai.openaiApiKey || '';
            const k2 = document.getElementById('geminiApiKey'); if (k2) k2.value = ai.geminiApiKey || '';
            const k3 = document.getElementById('googleApiKey'); if (k3) k3.value = ai.googleApiKey || '';
            const sz = document.getElementById('aiImageSize'); if (sz) sz.value = ai.imageSize || '1024x1024';
        } catch {}
        // Also read from /api/sync/status (backed by sync_config.json) to ensure persistence across refresh
        try {
            const resStatus = await fetch('/api/sync/status', { cache: 'no-store' });
            if (resStatus.ok) {
                const ss = await resStatus.json();
                const se = document.getElementById('syncEnabled'); if (se) se.checked = !!ss.enabled;
                const sb = document.getElementById('syncBaseUrl'); if (sb && ss.baseUrl) sb.value = ss.baseUrl;
                const st = document.getElementById('syncToken'); if (st && (ss.token || ss.hasToken)) st.value = ss.token || st.value || '';
            }
        } catch {}
        // Theme
        const themeColor = document.getElementById('themeColor');
        if (themeColor) themeColor.value = settings.themeColor || '#198754';
        // Dark mode
        const darkMode = document.getElementById('darkMode');
        if (darkMode) darkMode.checked = !!settings.darkMode;
        // Receipt options
        const showAddr = document.getElementById('showReceiptAddress');
        const showPhone = document.getElementById('showReceiptPhone');
        const showFooter = document.getElementById('showReceiptFooter');
        const paperWidth = document.getElementById('paperWidth');
        if (showAddr) showAddr.checked = settings.showReceiptAddress !== false;
        if (showPhone) showPhone.checked = settings.showReceiptPhone !== false;
        if (showFooter) showFooter.checked = settings.showReceiptFooter !== false;
        if (paperWidth) paperWidth.value = String(settings.paperWidth || 80);
        // Dangerous product purge button visibility
        try {
            const purgeBtn = document.getElementById('purgeAllProductsBtn');
            if (purgeBtn) purgeBtn.style.display = settings.showPurgeAllProducts ? '' : 'none';
        } catch {}
        // Login branding
        const loginTitle = document.getElementById('loginTitle');
        const loginLogoBase64 = document.getElementById('loginLogoBase64');
        const loginLogoPreview = document.getElementById('loginLogoPreview');
        const loginBgBase64 = document.getElementById('loginBackgroundBase64');
        const loginBgPreview = document.getElementById('loginBackgroundPreview');
        if (loginTitle) loginTitle.value = settings.loginTitle || '';
        if (loginLogoBase64) loginLogoBase64.value = settings.loginLogoBase64 || '';
        if (loginLogoPreview && settings.loginLogoBase64) { loginLogoPreview.src = settings.loginLogoBase64; loginLogoPreview.style.display = 'block'; }
        if (loginBgBase64) loginBgBase64.value = settings.loginBackgroundBase64 || '';
        if (loginBgPreview && settings.loginBackgroundBase64) { loginBgPreview.src = settings.loginBackgroundBase64; loginBgPreview.style.display = 'block'; }
        const loginLogoSize = document.getElementById('loginLogoSize');
        if (loginLogoSize) loginLogoSize.value = settings.loginLogoSize || 'medium';
    } catch (e) {
        console.error('Failed to load settings', e);
    }
}

function applySettingsToDocument(settings) {
    const name = settings?.storeName || 'POS System';
    try { document.title = name + ' - Admin Panel'; } catch {}
    const brand = document.getElementById('brandName');
    if (brand) brand.textContent = name + ' Admin';
    const brandLogo = document.getElementById('brandLogo');
    if (brandLogo) {
        brandLogo.style.display = 'inline-block';
        if (settings?.logoBase64) {
            brandLogo.src = settings.logoBase64;
            brandLogo.style.visibility = 'visible';
        } else {
            brandLogo.src = '';
            brandLogo.style.visibility = 'hidden';
        }
    }
    // Apply theme color to navbar and primary buttons
    const theme = settings?.themeColor || '#198754';
    let styleEl = document.getElementById('themeStyle');
    const css = `
      .navbar { background-color: ${theme} !important; }
      .btn-primary { background-color: ${theme} !important; border-color: ${theme} !important; }
      .btn-outline-primary { color: ${theme} !important; border-color: ${theme} !important; }
      .btn-outline-primary:hover { background-color: ${theme} !important; color: #fff !important; }
      a, .page-link, .page-link:hover { color: ${theme}; }
      .badge.bg-secondary { background-color: ${theme} !important; }
      .form-check-input:checked { background-color: ${theme}; border-color: ${theme}; }
      body.dark { background-color: #121212; color: #eaeaea; }
      body.dark .card { background-color: #1e1e1e; color: #eaeaea; }
      /* Table base */
      body.dark .table { background-color: #121212 !important; color: #ffffff !important; }
      body.dark .table thead { background-color: #1b1b1b !important; color: #ffffff !important; }
      body.dark .table thead th { background-color: #1b1b1b !important; color: #ffffff !important; border-color: #333333 !important; }
      body.dark .table tbody tr { background-color: #181818 !important; color: #ffffff !important; }
      body.dark .table th, body.dark .table td { background-color: #181818 !important; border-color: #333333 !important; color: #ffffff !important; }
      body.dark .table td small, body.dark .table td span, body.dark .table td a { color: #ffffff !important; }
      /* keep button text colors managed by Bootstrap */
      body.dark .table td .btn { color: inherit; }
      /* Striped */
      body.dark .table-striped > tbody > tr:nth-of-type(odd) { background-color: #202020 !important; color: #ffffff !important; }
      body.dark .table-striped > tbody > tr:nth-of-type(even) { background-color: #181818 !important; color: #ffffff !important; }
      /* Hover */
      body.dark .table-hover > tbody > tr:hover { background-color: #262626 !important; color: #ffffff !important; }
      body.dark .page-link { color: #ffffff; background-color: #1b1b1b; border-color: #333333; }
      body.dark .page-item.active .page-link { background-color: ${theme}; border-color: ${theme}; }
      body.dark .page-item.disabled .page-link { color: #888888; background-color: #1b1b1b; border-color: #333333; }
      body.dark .form-control, body.dark .form-select { background-color: #1b1b1b !important; border-color: #333 !important; color: #eaeaea !important; }
      body.dark .btn-outline-secondary { color: #ddd; border-color: #555; }
      /* Sidebar theming */
      .sidebar { background: linear-gradient(180deg, ${theme}1a, transparent) , #f8f9fa; }
      .sidebar .nav-link { color: #333; }
      .sidebar .nav-link.active { background-color: ${theme}26; color: #000; font-weight: 600; }
      .sidebar .nav-link:hover { background-color: ${theme}33; color: #000; }
      body.dark .sidebar { background-color: #151515 !important; }
      body.dark .sidebar .nav-link { color: #e0e0e0 !important; }
      body.dark .sidebar .nav-link.active { background-color: ${theme}40 !important; color: #ffffff !important; }
      body.dark .sidebar .nav-link:hover { background-color: #1f1f1f !important; color: #ffffff !important; }
      /* Fixed header spacing */
      body.fixed-navbar { padding-top: 56px; }
      /* Sidebar toggle behavior */
      #sidebar { transition: all .2s ease; }
      body.sidebar-hidden #sidebar { display: none !important; }
      body.sidebar-hidden #mainContent { flex: 0 0 100% !important; max-width: 100% !important; }
      /* Sticky sidebar under fixed navbar */
      #sidebar .position-sticky { top: 56px; }
      /* Modal dark mode */
      body.dark .modal-content { background-color: #1e1e1e !important; color: #ffffff !important; border-color: #333 !important; }
      body.dark .modal-header, body.dark .modal-footer { border-color: #333 !important; background-color: #1e1e1e !important; }
      body.dark .modal-title { color: #ffffff !important; }
      body.dark .btn-close { filter: invert(1); opacity: 0.8; }
      body.dark .form-label, body.dark label { color: #ffffff !important; }
      body.dark .form-text { color: #bbbbbb !important; }
      body.dark .text-muted { color: #bbbbbb !important; }
      body.dark .input-group-text { background-color: #2a2a2a !important; border-color: #444 !important; color: #eaeaea !important; }
      body.dark .form-select { background-color: #1b1b1b !important; color: #eaeaea !important; border-color: #333 !important; }
      body.dark .form-control::placeholder, body.dark textarea::placeholder { color: #9e9e9e !important; }
      /* Dropdowns & lists inside modals */
      body.dark .dropdown-menu { background-color: #1e1e1e !important; color: #ffffff !important; border-color: #333 !important; }
      body.dark .dropdown-item { color: #ffffff !important; }
      body.dark .dropdown-item:hover, body.dark .dropdown-item:focus { background-color: #262626 !important; color: #ffffff !important; }
      body.dark .list-group { background-color: transparent !important; }
      body.dark .list-group-item { background-color: #1b1b1b !important; color: #ffffff !important; border-color: #333 !important; }
      /* File input */
      body.dark input[type="file"].form-control { background-color: #1b1b1b !important; color: #eaeaea !important; border-color: #333 !important; }
      /* Backdrop */
      body.dark .modal-backdrop.show { opacity: 0.75; }
      
      /* BB-8 Toggle CSS */
      .bb8-toggle {
        --toggle-size: 16px;
        --toggle-width: 10.625em;
        --toggle-height: 5.625em;
        --toggle-offset: calc((var(--toggle-height) - var(--bb8-diameter)) / 2);
        --toggle-bg: linear-gradient(#2c4770, #070e2b 35%, #628cac 50% 70%, #a6c5d4) no-repeat;
        --bb8-diameter: 4.375em;
        --radius: 99em;
        --transition: 0.4s;
        --accent: #de7d2f;
        --bb8-bg: #fff;
        cursor: pointer;
        font-size: var(--toggle-size);
      }
      
      .bb8-toggle__checkbox {
        -webkit-appearance: none;
        -moz-appearance: none;
        appearance: none;
        display: none;
      }
      
      .bb8-toggle__container {
        width: var(--toggle-width);
        height: var(--toggle-height);
        background: var(--toggle-bg);
        background-size: 100% 11.25em;
        background-position-y: -5.625em;
        border-radius: var(--radius);
        position: relative;
        transition: var(--transition);
      }
      
      .bb8 {
        display: flex;
        flex-direction: column;
        align-items: center;
        position: absolute;
        top: calc(var(--toggle-offset) - 1.688em + 0.188em);
        left: var(--toggle-offset);
        transition: var(--transition);
        z-index: 2;
      }
      
      .bb8__head-container {
        position: relative;
        transition: var(--transition);
        z-index: 2;
        transform-origin: 1.25em 3.75em;
      }
      
      .bb8__head {
        overflow: hidden;
        margin-bottom: -0.188em;
        width: 2.5em;
        height: 1.688em;
        background: linear-gradient(
            transparent 0.063em,
            dimgray 0.063em 0.313em,
            transparent 0.313em 0.375em,
            var(--accent) 0.375em 0.5em,
            transparent 0.5em 1.313em,
            silver 1.313em 1.438em,
            transparent 1.438em
          ),
          linear-gradient(
            45deg,
            transparent 0.188em,
            var(--bb8-bg) 0.188em 1.25em,
            transparent 1.25em
          ),
          linear-gradient(
            -45deg,
            transparent 0.188em,
            var(--bb8-bg) 0.188em 1.25em,
            transparent 1.25em
          ),
          linear-gradient(var(--bb8-bg) 1.25em, transparent 1.25em);
        border-radius: var(--radius) var(--radius) 0 0;
        position: relative;
        z-index: 1;
        filter: drop-shadow(0 0.063em 0.125em gray);
      }
      
      .bb8__head::before {
        content: "";
        position: absolute;
        width: 0.563em;
        height: 0.563em;
        background: radial-gradient(
            0.125em circle at 0.25em 0.375em,
            red,
            transparent
          ),
          radial-gradient(
            0.063em circle at 0.375em 0.188em,
            var(--bb8-bg) 50%,
            transparent 100%
          ),
          linear-gradient(45deg, #000 0.188em, dimgray 0.313em 0.375em, #000 0.5em);
        border-radius: var(--radius);
        top: 0.413em;
        left: 50%;
        transform: translate(-50%);
        box-shadow: 0 0 0 0.089em lightgray, 0.563em 0.281em 0 -0.148em,
          0.563em 0.281em 0 -0.1em var(--bb8-bg), 0.563em 0.281em 0 -0.063em;
        z-index: 1;
        transition: var(--transition);
      }
      
      .bb8__head::after {
        content: "";
        position: absolute;
        bottom: 0.375em;
        left: 0;
        width: 100%;
        height: 0.188em;
        background: linear-gradient(
          to right,
          var(--accent) 0.125em,
          transparent 0.125em 0.188em,
          var(--accent) 0.188em 0.313em,
          transparent 0.313em 0.375em,
          var(--accent) 0.375em 0.938em,
          transparent 0.938em 1em,
          var(--accent) 1em 1.125em,
          transparent 1.125em 1.875em,
          var(--accent) 1.875em 2em,
          transparent 2em 2.063em,
          var(--accent) 2.063em 2.25em,
          transparent 2.25em 2.313em,
          var(--accent) 2.313em 2.375em,
          transparent 2.375em 2.438em,
          var(--accent) 2.438em
        );
        transition: var(--transition);
      }
      
      .bb8__antenna {
        position: absolute;
        transform: translateY(-90%);
        width: 0.059em;
        border-radius: var(--radius) var(--radius) 0 0;
        transition: var(--transition);
      }
      
      .bb8__antenna:nth-child(1) {
        height: 0.938em;
        right: 0.938em;
        background: linear-gradient(#000 0.188em, silver 0.188em);
      }
      
      .bb8__antenna:nth-child(2) {
        height: 0.375em;
        left: 50%;
        transform: translate(-50%, -90%);
        background: silver;
      }
      
      .bb8__body {
        width: 4.375em;
        height: 4.375em;
        background: var(--bb8-bg);
        border-radius: var(--radius);
        position: relative;
        overflow: hidden;
        transition: var(--transition);
        z-index: 1;
        transform: rotate(45deg);
        background: linear-gradient(
            -90deg,
            var(--bb8-bg) 4%,
            var(--accent) 4% 10%,
            transparent 10% 90%,
            var(--accent) 90% 96%,
            var(--bb8-bg) 96%
          ),
          linear-gradient(
            var(--bb8-bg) 4%,
            var(--accent) 4% 10%,
            transparent 10% 90%,
            var(--accent) 90% 96%,
            var(--bb8-bg) 96%
          ),
          linear-gradient(
            to right,
            transparent 2.156em,
            silver 2.156em 2.219em,
            transparent 2.188em
          ),
          linear-gradient(
            transparent 2.156em,
            silver 2.156em 2.219em,
            transparent 2.188em
          );
        background-color: var(--bb8-bg);
      }
      
      .bb8__body::after {
        content: "";
        bottom: 1.5em;
        left: 0.563em;
        position: absolute;
        width: 0.188em;
        height: 0.188em;
        background: rgb(236, 236, 236);
        color: rgb(236, 236, 236);
        border-radius: 50%;
        box-shadow: 0.875em 0.938em, 0 -1.25em, 0.875em -2.125em, 2.125em -2.125em,
          3.063em -1.25em, 3.063em 0, 2.125em 0.938em;
      }
      
      .bb8__body::before {
        content: "";
        width: 2.625em;
        height: 2.625em;
        position: absolute;
        border-radius: 50%;
        z-index: 0.1;
        overflow: hidden;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        border: 0.313em solid var(--accent);
        background: radial-gradient(
            1em circle at center,
            rgb(236, 236, 236) 50%,
            transparent 51%
          ),
          radial-gradient(1.25em circle at center, var(--bb8-bg) 50%, transparent 51%),
          linear-gradient(
            -90deg,
            transparent 42%,
            var(--accent) 42% 58%,
            transparent 58%
          ),
          linear-gradient(var(--bb8-bg) 42%, var(--accent) 42% 58%, var(--bb8-bg) 58%);
      }
      
      .artificial__hidden {
        position: absolute;
        border-radius: inherit;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
      }
      
      .bb8__shadow {
        content: "";
        width: var(--bb8-diameter);
        height: 20%;
        border-radius: 50%;
        background: #3a271c;
        box-shadow: 0.313em 0 3.125em #3a271c;
        opacity: 0.25;
        position: absolute;
        bottom: 0;
        left: calc(var(--toggle-offset) - 0.938em);
        transition: var(--transition);
        transform: skew(-70deg);
        z-index: 1;
      }
      
      .bb8-toggle__scenery {
        width: 100%;
        height: 100%;
        pointer-events: none;
        overflow: hidden;
        position: relative;
        border-radius: inherit;
      }
      
      .bb8-toggle__scenery::before {
        content: "";
        position: absolute;
        width: 100%;
        height: 30%;
        bottom: 0;
        background: #b18d71;
        z-index: 1;
      }
      
      .bb8-toggle__cloud {
        z-index: 1;
        position: absolute;
        border-radius: 50%;
      }
      
      .bb8-toggle__cloud:nth-last-child(1) {
        width: 0.875em;
        height: 0.625em;
        filter: blur(0.125em) drop-shadow(0.313em 0.313em #ffffffae)
          drop-shadow(-0.625em 0 #fff) drop-shadow(-0.938em -0.125em #fff);
        right: 1.875em;
        top: 2.813em;
        background: linear-gradient(to top right, #ffffffae, #ffffffae);
        transition: var(--transition);
      }
      
      .bb8-toggle__cloud:nth-last-child(2) {
        top: 0.625em;
        right: 4.375em;
        width: 0.875em;
        height: 0.375em;
        background: #dfdedeae;
        filter: blur(0.125em) drop-shadow(-0.313em -0.188em #e0dfdfae)
          drop-shadow(-0.625em -0.188em #bbbbbbae) drop-shadow(-1em 0.063em #cfcfcfae);
        transition: 0.6s;
      }
      
      .bb8-toggle__cloud:nth-last-child(3) {
        top: 1.25em;
        right: 0.938em;
        width: 0.875em;
        height: 0.375em;
        background: #ffffffae;
        filter: blur(0.125em) drop-shadow(0.438em 0.188em #ffffffae)
          drop-shadow(-0.625em 0.313em #ffffffae);
        transition: 0.8s;
      }
      
      .gomrassen,
      .hermes,
      .chenini {
        position: absolute;
        border-radius: var(--radius);
        background: linear-gradient(#fff, #6e8ea2);
        top: 100%;
      }
      
      .gomrassen {
        left: 0.938em;
        width: 1.875em;
        height: 1.875em;
        box-shadow: 0 0 0.188em #ffffff52, 0 0 0.188em #6e8ea24b;
        transition: var(--transition);
      }
      
      .gomrassen::before,
      .gomrassen::after {
        content: "";
        position: absolute;
        border-radius: inherit;
        box-shadow: inset 0 0 0.063em rgb(140, 162, 169);
        background: rgb(184, 196, 200);
      }
      
      .gomrassen::before {
        left: 0.313em;
        top: 0.313em;
        width: 0.438em;
        height: 0.438em;
      }
      
      .gomrassen::after {
        width: 0.25em;
        height: 0.25em;
        left: 1.25em;
        top: 0.75em;
      }
      
      .hermes {
        left: 3.438em;
        width: 0.625em;
        height: 0.625em;
        box-shadow: 0 0 0.125em #ffffff52, 0 0 0.125em #6e8ea24b;
        transition: 0.6s;
      }
      
      .chenini {
        left: 4.375em;
        width: 0.5em;
        height: 0.5em;
        box-shadow: 0 0 0.125em #ffffff52, 0 0 0.125em #6e8ea24b;
        transition: 0.8s;
      }
      
      .tatto-1,
      .tatto-2 {
        position: absolute;
        width: 1.25em;
        height: 1.25em;
        border-radius: var(--radius);
      }
      
      .tatto-1 {
        background: #fefefe;
        right: 3.125em;
        top: 0.625em;
        box-shadow: 0 0 0.438em #fdf4e1;
        transition: var(--transition);
      }
      
      .tatto-2 {
        background: linear-gradient(#e6ac5c, #d75449);
        right: 1.25em;
        top: 2.188em;
        box-shadow: 0 0 0.438em #e6ad5c3d, 0 0 0.438em #d755494f;
        transition: 0.7s;
      }
      
      .bb8-toggle__star {
        position: absolute;
        width: 0.063em;
        height: 0.063em;
        background: #fff;
        border-radius: var(--radius);
        filter: drop-shadow(0 0 0.063em #fff);
        color: #fff;
        top: 100%;
      }
      
      .bb8-toggle__star:nth-child(1) {
        left: 3.75em;
        box-shadow: 1.25em 0.938em, -1.25em 2.5em, 0 1.25em, 1.875em 0.625em,
          -3.125em 1.875em, 1.25em 2.813em;
        transition: 0.2s;
      }
      
      .bb8-toggle__star:nth-child(2) {
        left: 4.688em;
        box-shadow: 0.625em 0, 0 0.625em, -0.625em -0.625em, 0.625em 0.938em,
          -3.125em 1.25em, 1.25em -1.563em;
        transition: 0.3s;
      }
      
      .bb8-toggle__star:nth-child(3) {
        left: 5.313em;
        box-shadow: -0.625em -0.625em, -2.188em 1.25em, -2.188em 0,
          -3.75em -0.625em, -3.125em -0.625em, -2.5em -0.313em, 0.75em -0.625em;
        transition: var(--transition);
      }
      
      .bb8-toggle__star:nth-child(4) {
        left: 1.875em;
        width: 0.125em;
        height: 0.125em;
        transition: 0.5s;
      }
      
      .bb8-toggle__star:nth-child(5) {
        left: 5em;
        width: 0.125em;
        height: 0.125em;
        transition: 0.6s;
      }
      
      .bb8-toggle__star:nth-child(6) {
        left: 2.5em;
        width: 0.125em;
        height: 0.125em;
        transition: 0.7s;
      }
      
      .bb8-toggle__star:nth-child(7) {
        left: 3.438em;
        width: 0.125em;
        height: 0.125em;
        transition: 0.8s;
      }
      
      /* Toggle state actions */
      .bb8-toggle__checkbox:checked + .bb8-toggle__container .bb8-toggle__star:nth-child(1) { top: 0.625em; }
      .bb8-toggle__checkbox:checked + .bb8-toggle__container .bb8-toggle__star:nth-child(2) { top: 1.875em; }
      .bb8-toggle__checkbox:checked + .bb8-toggle__container .bb8-toggle__star:nth-child(3) { top: 1.25em; }
      .bb8-toggle__checkbox:checked + .bb8-toggle__container .bb8-toggle__star:nth-child(4) { top: 3.438em; }
      .bb8-toggle__checkbox:checked + .bb8-toggle__container .bb8-toggle__star:nth-child(5) { top: 3.438em; }
      .bb8-toggle__checkbox:checked + .bb8-toggle__container .bb8-toggle__star:nth-child(6) { top: 0.313em; }
      .bb8-toggle__checkbox:checked + .bb8-toggle__container .bb8-toggle__star:nth-child(7) { top: 1.875em; }
      
      .bb8-toggle__checkbox:checked + .bb8-toggle__container .bb8-toggle__cloud { right: -100%; }
      .bb8-toggle__checkbox:checked + .bb8-toggle__container .gomrassen { top: 0.938em; }
      .bb8-toggle__checkbox:checked + .bb8-toggle__container .hermes { top: 2.5em; }
      .bb8-toggle__checkbox:checked + .bb8-toggle__container .chenini { top: 2.75em; }
      .bb8-toggle__checkbox:checked + .bb8-toggle__container { background-position-y: 0; }
      .bb8-toggle__checkbox:checked + .bb8-toggle__container .tatto-1 { top: 100%; }
      .bb8-toggle__checkbox:checked + .bb8-toggle__container .tatto-2 { top: 100%; }
      .bb8-toggle__checkbox:checked + .bb8-toggle__container .bb8 { left: calc(100% - var(--bb8-diameter) - var(--toggle-offset)); }
      
      .bb8-toggle__checkbox:checked + .bb8-toggle__container .bb8__shadow {
        left: calc(100% - var(--bb8-diameter) - var(--toggle-offset) + 0.938em);
        transform: skew(70deg);
      }
      
      .bb8-toggle__checkbox:checked + .bb8-toggle__container .bb8__body {
        transform: rotate(225deg);
      }
      
      .bb8-toggle__checkbox:hover + .bb8-toggle__container .bb8__head::before { left: 100%; }
      .bb8-toggle__checkbox:not(:checked):hover + .bb8-toggle__container .bb8__antenna:nth-child(1) { right: 1.5em; }
      .bb8-toggle__checkbox:hover + .bb8-toggle__container .bb8__antenna:nth-child(2) { left: 0.938em; }
      .bb8-toggle__checkbox:hover + .bb8-toggle__container .bb8__head::after { background-position: 1.375em 0; }
      .bb8-toggle__checkbox:checked:hover + .bb8-toggle__container .bb8__head::before { left: 0; }
      .bb8-toggle__checkbox:checked:hover + .bb8-toggle__container .bb8__antenna:nth-child(2) { left: calc(100% - 0.938em); }
      .bb8-toggle__checkbox:checked:hover + .bb8-toggle__container .bb8__head::after { background-position: -1.375em 0; }
      .bb8-toggle__checkbox:active + .bb8-toggle__container .bb8__head-container { transform: rotate(25deg); }
      .bb8-toggle__checkbox:checked:active + .bb8-toggle__container .bb8__head-container { transform: rotate(-25deg); }
      
      .bb8:hover .bb8__head::before,
      .bb8:hover .bb8__antenna:nth-child(2) { left: 50% !important; }
      .bb8:hover .bb8__antenna:nth-child(1) { right: 0.938em !important; }
      .bb8:hover .bb8__head::after { background-position: 0 0 !important; }
      
      /* Custom Delete Button */
      .delete-btn {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background-color: rgb(20, 20, 20);
        border: none;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0px 0px 20px rgba(0, 0, 0, 0.164);
        cursor: pointer;
        transition-duration: .3s;
        overflow: hidden;
        position: relative;
        padding: 0;
        margin: 0;
      }
      
      .delete-btn .svgIcon {
        width: 12px;
        height: 12px;
        transition-duration: .3s;
      }
      
      .delete-btn .svgIcon path {
        fill: white;
      }
      
      .delete-btn:hover {
        width: 120px;
        border-radius: 50px;
        transition-duration: .3s;
        background-color: rgb(255, 69, 69);
        align-items: center;
      }
      
      .delete-btn:hover .svgIcon {
        width: 40px;
        height: 40px;
        transition-duration: .3s;
        transform: translateY(60%);
      }
      
      .delete-btn::before {
        position: absolute;
        top: -20px;
        content: "Delete";
        color: white;
        transition-duration: .3s;
        font-size: 2px;
        opacity: 0;
      }
      
      .delete-btn:hover::before {
        font-size: 13px;
        opacity: 1;
        transform: translateY(30px);
        transition-duration: .3s;
      }
      
      /* Dark mode adjustments for delete button */
      body.dark .delete-btn {
        background-color: #333;
        box-shadow: 0px 0px 20px rgba(255, 255, 255, 0.1);
      }
      
      body.dark .delete-btn:hover {
        background-color: rgb(220, 53, 69);
      }
      
      /* Custom Edit Button */
      .edit-btn {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background-color: rgb(20, 20, 20);
        border: none;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0px 0px 20px rgba(0, 0, 0, 0.164);
        cursor: pointer;
        transition-duration: .3s;
        overflow: hidden;
        position: relative;
        padding: 0;
        margin: 0;
      }
      
      .edit-btn .svgIcon {
        width: 12px;
        height: 12px;
        transition-duration: .3s;
      }
      
      .edit-btn .svgIcon path {
        fill: white;
      }
      
      .edit-btn:hover {
        width: 120px;
        border-radius: 50px;
        transition-duration: .3s;
        background-color: rgb(255, 193, 7);
        align-items: center;
      }
      
      .edit-btn:hover .svgIcon {
        width: 40px;
        height: 40px;
        transition-duration: .3s;
        transform: translateY(60%);
      }
      
      .edit-btn::before {
        position: absolute;
        top: -20px;
        content: "Edit";
        color: white;
        transition-duration: .3s;
        font-size: 2px;
        opacity: 0;
      }
      
      .edit-btn:hover::before {
        font-size: 13px;
        opacity: 1;
        transform: translateY(30px);
        transition-duration: .3s;
      }
      
      /* Dark mode adjustments for edit button */
      body.dark .edit-btn {
        background-color: #333;
        box-shadow: 0px 0px 20px rgba(255, 255, 255, 0.1);
      }
      
      body.dark .edit-btn:hover {
        background-color: rgb(255, 193, 7);
      }
      
      /* Prevent product name wrapping */
      #productTableBody td:nth-child(5) {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 200px;
      }
      
      /* Dark mode for product name */
      body.dark #productTableBody td:nth-child(5) {
        color: #eaeaea;
      }
      
      /* Custom Checkbox */
      .custom-checkbox {
        cursor: pointer;
        position: relative;
        margin: auto;
        width: 18px;
        height: 18px;
        -webkit-tap-highlight-color: transparent;
        transform: translate3d(0, 0, 0);
      }
      
      .custom-checkbox:before {
        content: "";
        position: absolute;
        top: -15px;
        left: -15px;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        background: rgba(34,50,84,0.03);
        opacity: 0;
        transition: opacity 0.2s ease;
      }
      
      .custom-checkbox svg {
        position: relative;
        z-index: 1;
        fill: none;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke: #c8ccd4;
        stroke-width: 1.5;
        transform: translate3d(0, 0, 0);
        transition: all 0.2s ease;
      }
      
      .custom-checkbox svg path {
        stroke-dasharray: 60;
        stroke-dashoffset: 0;
      }
      
      .custom-checkbox svg polyline {
        stroke-dasharray: 22;
        stroke-dashoffset: 66;
      }
      
      .custom-checkbox:hover:before {
        opacity: 1;
      }
      
      .custom-checkbox:hover svg {
        stroke: #4285f4;
      }
      
      .custom-checkbox-input:checked + .custom-checkbox svg {
        stroke: #4285f4;
      }
      
      .custom-checkbox-input:checked + .custom-checkbox svg path {
        stroke-dashoffset: 60;
        transition: all 0.3s linear;
      }
      
      .custom-checkbox-input:checked + .custom-checkbox svg polyline {
        stroke-dashoffset: 42;
        transition: all 0.2s linear;
        transition-delay: 0.15s;
      }
      
      /* Dark mode for custom checkbox */
      body.dark .custom-checkbox svg {
        stroke: #6c757d;
      }
      
      body.dark .custom-checkbox:hover svg {
        stroke: #4285f4;
      }
      
      body.dark .custom-checkbox-input:checked + .custom-checkbox svg {
        stroke: #4285f4;
      }
      
      /* Sidebar admin clock styling */
      #adminClock {
        font-size: 0.85rem;
        font-weight: 500;
      }
      
      body.dark #adminClock {
        color: #eaeaea !important;
      }
    `;
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'themeStyle';
        document.head.appendChild(styleEl);
    }
    styleEl.textContent = css;
    // Apply dark mode toggle and sync with localStorage
    try {
        const isDarkMode = settings?.darkMode || false;
        if (isDarkMode) {
            document.body.classList.add('dark');
        } else {
            document.body.classList.remove('dark');
        }
        // Sync localStorage with server settings
        localStorage.setItem('admin_darkMode', isDarkMode.toString());
        
        // Update toggle checkbox if it exists
        const darkModeToggle = document.getElementById('darkModeToggle');
        if (darkModeToggle) {
            darkModeToggle.checked = isDarkMode;
        }
    } catch {}
    const link = document.querySelector('link[rel="icon"]');
    if (!link) {
        const l = document.createElement('link');
        l.setAttribute('rel', 'icon');
        document.head.appendChild(l);
    }
    const v = Date.now();
    if (appSettings?.faviconBase64) {
        // Use base64 favicon from settings
        (document.querySelector('link[rel="icon"]')).setAttribute('href', appSettings.faviconBase64);
    } else {
        // Use default favicon with cache busting
        (document.querySelector('link[rel="icon"]')).setAttribute('href', `/favicon.ico?v=${v}`);
    }
}

// --- Delete Item ---
async function deleteItem(type, id) {
    const names = { products: 'produk', categories: 'kategori', users: 'user', units: 'satuan' };
    const name = names[type] || 'item';
    if (!confirm(`Apakah Anda yakin ingin menghapus ${name} ini?`)) return;
    try {
        await ensureCsrfTokenReady();
        const token = (window.csrfToken||'');
        // also pass token in query param to satisfy server side CSRF fallback
        const delUrl = `/api/${type}/${id}?_csrf=${encodeURIComponent(token)}`;
        let res = await fetch(delUrl, { 
            method: 'DELETE',
            headers: { 'x-csrf-token': token, 'x-xsrf-token': token },
            credentials: 'include'
        });
        if (res.status === 403) {
            await ensureCsrfTokenReady(true);
            const t2 = (window.csrfToken||'');
            const delUrl2 = `/api/${type}/${id}?_csrf=${encodeURIComponent(t2)}`;
            res = await fetch(delUrl2, { 
                method: 'DELETE',
                headers: { 'x-csrf-token': t2, 'x-xsrf-token': t2 },
                credentials: 'include'
            });
        }
        if (res.ok) {
            alert(`${name.charAt(0).toUpperCase() + name.slice(1)} berhasil dihapus!`);
            if (type === 'products') await loadProducts();
            if (type === 'categories') { await loadCategories(); await loadInitialData(); }
            if (type === 'users') await loadUsers();
            if (type === 'units') await loadUnits();
        } else {
            const err = await res.json();
            alert(`Error: ${err.message || 'Gagal menghapus item'}`);
        }
    } catch (error) {
        alert('Gagal menghapus item');
    }
}

// Wrapper for backward compatibility with existing onclick handlers
function deleteProduct(id) {
    return deleteItem('products', id);
}

// --- Export/Import ---
let selectedImportFiles = {
    product: null,
    category: null,
    transaction: null,
    user: null,
    customer: null
};

// === PRODUCTS ===
async function exportProductsToXlsx() {
    try {
        const res = await fetch('/api/products/export');
        if (!res.ok) throw new Error('Export gagal');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'products_export.xlsx';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        alert('Produk berhasil diekspor!');
    } catch (error) {
        alert(`Gagal mengekspor: ${error.message}`);
    }
}

async function downloadImportTemplate() {
    try {
        const res = await fetch('/api/products/template');
        if (!res.ok) throw new Error('Gagal mengunduh template');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'product_import_template.xlsx';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        alert('Template berhasil diunduh!');
    } catch (error) {
        alert(`Gagal mengunduh template: ${error.message}`);
    }
}

function triggerFileSelection() {
    document.getElementById('importFileInput')?.click();
}

function handleFileSelection(event) {
    const file = event.target.files[0];
    const span = document.getElementById('selectedFileName');
    const btn = document.getElementById('importFileBtn');
    if (file) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (!['xlsx', 'xls'].includes(ext)) {
            alert('Pilih file Excel (.xlsx atau .xls)');
            event.target.value = '';
            return;
        }
        span.textContent = `Dipilih: ${file.name}`;
        btn.disabled = false;
        selectedImportFiles.product = file;
    } else {
        span.textContent = 'Tidak ada file yang dipilih';
        btn.disabled = true;
        selectedImportFiles.product = null;
    }
}

async function processImport() {
    if (!selectedImportFiles.product) { alert('Pilih file dulu'); return; }
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(ws, { defval: '' });
            if (json.length === 0) { alert('File kosong'); return; }
            const hasProductName = 'Product Name' in json[0];
            const hasStock = 'Stock' in json[0];
            const hasSellingPrice = 'Selling Price' in json[0];
            const hasLegacyPrice = 'Price' in json[0];
            if (!hasProductName || !hasStock || (!hasSellingPrice && !hasLegacyPrice)) {
                const need = ['Product Name', 'Stock', 'Selling Price atau Price'];
                throw new Error(`Kolom wajib tidak ada atau tidak lengkap. Wajib: ${need.join(', ')}`);
            }

            const btn = document.getElementById('importFileBtn');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Mengimport...';

            const res = await fetch('/api/products/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ products: json })
            });
            const result = await res.json();
            if (!res.ok) throw new Error(result.message || 'Server error');
            alert(result.message);
            await loadProducts();
        } catch (error) {
            alert(`Gagal mengimport: ${error.message}`);
        } finally {
            document.getElementById('importFileInput').value = '';
            document.getElementById('selectedFileName').textContent = 'Tidak ada file yang dipilih';
            selectedImportFiles.product = null;
            const btn = document.getElementById('importFileBtn');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-upload"></i> Impor Sekarang'; }
        }
    };
    reader.readAsArrayBuffer(selectedImportFiles.product);
}

// === CATEGORIES ===
async function exportCategoriesToXlsx() {
    try {
        const res = await fetch('/api/categories/export');
        if (!res.ok) throw new Error('Export gagal');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'categories_export.xlsx';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        alert('Kategori berhasil diekspor!');
    } catch (error) {
        alert(`Gagal mengekspor: ${error.message}`);
    }
}

async function downloadCategoryTemplate() {
    try {
        const res = await fetch('/api/categories/template');
        if (!res.ok) throw new Error('Gagal mengunduh template');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'category_import_template.xlsx';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        alert('Template berhasil diunduh!');
    } catch (error) {
        alert(`Gagal mengunduh template: ${error.message}`);
    }
}

function triggerCategoryFileSelection() {
    document.getElementById('importCategoryFileInput')?.click();
}

function handleCategoryFileSelection(event) {
    const file = event.target.files[0];
    const span = document.getElementById('selectedCategoryFileName');
    const btn = document.getElementById('importCategoryFileBtn');
    if (file) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (!['xlsx', 'xls'].includes(ext)) {
            alert('Pilih file Excel (.xlsx atau .xls)');
            event.target.value = '';
            return;
        }
        span.textContent = `Dipilih: ${file.name}`;
        btn.disabled = false;
        selectedImportFiles.category = file;
    } else {
        span.textContent = 'Tidak ada file yang dipilih';
        btn.disabled = true;
        selectedImportFiles.category = null;
    }
}

async function processCategoryImport() {
    if (!selectedImportFiles.category) { alert('Pilih file dulu'); return; }
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(ws, { defval: '' });
            if (json.length === 0) { alert('File kosong'); return; }
            const hasName = 'Category Name' in json[0];
            if (!hasName) {
                throw new Error('Kolom wajib tidak ada atau tidak lengkap. Wajib: Category Name');
            }

            const btn = document.getElementById('importCategoryFileBtn');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Mengimport...';

            const res = await fetch('/api/categories/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ categories: json })
            });
            const result = await res.json();
            if (!res.ok) throw new Error(result.message || 'Server error');
            alert(result.message);
            await loadCategories();
            await loadInitialData();
        } catch (error) {
            alert(`Gagal mengimport: ${error.message}`);
        } finally {
            document.getElementById('importCategoryFileInput').value = '';
            document.getElementById('selectedCategoryFileName').textContent = 'Tidak ada file yang dipilih';
            selectedImportFiles.category = null;
            const btn = document.getElementById('importCategoryFileBtn');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-upload"></i> Impor Sekarang'; }
        }
    };
    reader.readAsArrayBuffer(selectedImportFiles.category);
}

// === TRANSACTIONS ===
async function exportTransactionsToXlsx() {
    try {
        const res = await fetch('/api/transactions/export');
        if (!res.ok) throw new Error('Export gagal');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'transactions_export.xlsx';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        alert('Transaksi berhasil diekspor!');
    } catch (error) {
        alert(`Gagal mengekspor: ${error.message}`);
    }
}

// === USERS ===
async function exportUsersToXlsx() {
    try {
        const res = await fetch('/api/users/export');
        if (!res.ok) throw new Error('Export gagal');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'users_export.xlsx';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        alert('User berhasil diekspor!');
    } catch (error) {
        alert(`Gagal mengekspor: ${error.message}`);
    }
}

async function downloadUserTemplate() {
    try {
        const res = await fetch('/api/users/template');
        if (!res.ok) throw new Error('Gagal mengunduh template');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'user_import_template.xlsx';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        alert('Template berhasil diunduh!');
    } catch (error) {
        alert(`Gagal mengunduh template: ${error.message}`);
    }
}

function triggerUserFileSelection() {
    document.getElementById('importUserFileInput')?.click();
}

function handleUserFileSelection(event) {
    const file = event.target.files[0];
    const span = document.getElementById('selectedUserFileName');
    const btn = document.getElementById('importUserFileBtn');
    if (file) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (!['xlsx', 'xls'].includes(ext)) {
            alert('Pilih file Excel (.xlsx atau .xls)');
            event.target.value = '';
            return;
        }
        span.textContent = `Dipilih: ${file.name}`;
        btn.disabled = false;
        selectedImportFiles.user = file;
    } else {
        span.textContent = 'Tidak ada file yang dipilih';
        btn.disabled = true;
        selectedImportFiles.user = null;
    }
}

async function processUserImport() {
    if (!selectedImportFiles.user) { alert('Pilih file dulu'); return; }
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(ws, { defval: '' });
            if (json.length === 0) { alert('File kosong'); return; }
            const hasUsername = 'Username' in json[0];
            const hasPassword = 'Password' in json[0];
            if (!hasUsername || !hasPassword) {
                throw new Error('Kolom wajib tidak ada atau tidak lengkap. Wajib: Username, Password');
            }

            const btn = document.getElementById('importUserFileBtn');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Mengimport...';

            const res = await fetch('/api/users/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ users: json })
            });
            const result = await res.json();
            if (!res.ok) throw new Error(result.message || 'Server error');
            alert(result.message);
            await loadUsers();
        } catch (error) {
            alert(`Gagal mengimport: ${error.message}`);
        } finally {
            document.getElementById('importUserFileInput').value = '';
            document.getElementById('selectedUserFileName').textContent = 'Tidak ada file yang dipilih';
            selectedImportFiles.user = null;
            const btn = document.getElementById('importUserFileBtn');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-upload"></i> Impor Sekarang'; }
        }
    };
    reader.readAsArrayBuffer(selectedImportFiles.user);
}

// === CUSTOMERS ===
async function exportCustomersToXlsx() {
    try {
        const res = await fetch('/api/customers/export');
        if (!res.ok) throw new Error('Export gagal');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'customers_export.xlsx';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        alert('Pelanggan berhasil diekspor!');
    } catch (error) {
        alert(`Gagal mengekspor: ${error.message}`);
    }
}

async function downloadCustomerTemplate() {
    try {
        const res = await fetch('/api/customers/template');
        if (!res.ok) throw new Error('Gagal mengunduh template');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'customer_import_template.xlsx';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        alert('Template berhasil diunduh!');
    } catch (error) {
        alert(`Gagal mengunduh template: ${error.message}`);
    }
}

function triggerCustomerFileSelection() {
    document.getElementById('importCustomerFileInput')?.click();
}

function handleCustomerFileSelection(event) {
    const file = event.target.files[0];
    const span = document.getElementById('selectedCustomerFileName');
    const btn = document.getElementById('importCustomerFileBtn');
    if (file) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (!['xlsx', 'xls'].includes(ext)) {
            alert('Pilih file Excel (.xlsx atau .xls)');
            event.target.value = '';
            return;
        }
        span.textContent = `Dipilih: ${file.name}`;
        btn.disabled = false;
        selectedImportFiles.customer = file;
    } else {
        span.textContent = 'Tidak ada file yang dipilih';
        btn.disabled = true;
        selectedImportFiles.customer = null;
    }
}

async function processCustomerImport() {
    if (!selectedImportFiles.customer) { alert('Pilih file dulu'); return; }
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(ws, { defval: '' });
            if (json.length === 0) { alert('File kosong'); return; }
            const hasName = 'Customer Name' in json[0];
            if (!hasName) {
                throw new Error('Kolom wajib tidak ada atau tidak lengkap. Wajib: Customer Name');
            }

            const btn = document.getElementById('importCustomerFileBtn');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Mengimport...';

            const res = await fetch('/api/customers/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ customers: json })
            });
            const result = await res.json();
            if (!res.ok) throw new Error(result.message || 'Server error');
            alert(result.message);
            await loadCustomers();
        } catch (error) {
            alert(`Gagal mengimport: ${error.message}`);
        } finally {
            document.getElementById('importCustomerFileInput').value = '';
            document.getElementById('selectedCustomerFileName').textContent = 'Tidak ada file yang dipilih';
            selectedImportFiles.customer = null;
            const btn = document.getElementById('importCustomerFileBtn');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-upload"></i> Impor Sekarang'; }
        }
    };
    reader.readAsArrayBuffer(selectedImportFiles.customer);
}

// Reset Password Modal
function openResetPasswordModal(userId, username) {
    document.getElementById('resetPasswordUsername').textContent = username;
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
    document.getElementById('confirmResetPasswordBtn').onclick = async () => {
        const np = document.getElementById('newPassword').value;
        const cp = document.getElementById('confirmPassword').value;
        if (!np) { alert('Password baru wajib diisi!'); return; }
        if (np !== cp) { alert('Password tidak cocok!'); return; }
        if (np.length < 6) { alert('Password minimal 6 karakter!'); return; }
        try {
            const res = await fetch(`/api/users/${userId}/reset-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ newPassword: np })
            });
            const result = await res.json();
            if (result.success) {
                alert(result.message);
                resetPasswordModal.hide();
            } else {
                alert(result.message || 'Gagal reset password');
            }
        } catch (error) {
            alert('Gagal reset password');
        }
    };
    resetPasswordModal.show();
}

function showValidationMessage(input, msg) {
    hideValidationMessage(input);
    const fb = document.createElement('div');
    fb.className = 'invalid-feedback';
    fb.textContent = msg;
    fb.style.display = 'block';
    input.parentNode.appendChild(fb);
}

function hideValidationMessage(input) {
    const fb = input.parentNode.querySelector('.invalid-feedback');
    if (fb) fb.remove();
}

// Call customer event listeners setup
setupCustomerEventListeners();

// --- Customers Management ---
async function loadCustomers() {
    try {
        const res = await fetch('/api/customers');
        if (!res.ok) throw new Error('Failed to load customers');
        customers = await res.json();
        renderCustomers();
    } catch (error) {
        console.error('Failed to load customers:', error);
        const tbody = document.getElementById('customerTableBody');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">Failed to load customers</td></tr>`;
        }
    }
}

function renderCustomers() {
    const tbody = document.getElementById('customerTableBody');
    if (!tbody) return;

    const filtered = getFilteredCustomers();
    const paginated = getPaginatedCustomers();

    if (paginated.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center">Tidak ada pelanggan ditemukan.</td></tr>`;
        return;
    }

    const start = (customerCurrentPage - 1) * customerPageSize;
    tbody.innerHTML = paginated.map((customer, idx) => {
        const createdDate = new Date(customer.createdAt).toLocaleDateString('id-ID');
        // Truncate long address for better display
        const shortAddress = customer.address && customer.address.length > 30 
            ? customer.address.substring(0, 30) + '...' 
            : customer.address || '-';
        const shortEmail = customer.email && customer.email.length > 25
            ? customer.email.substring(0, 25) + '...'
            : customer.email || '-';
        return `
        <tr>
            <td>${start + idx + 1}</td>
            <td>${customer.name}</td>
            <td>${customer.phone || '-'}</td>
            <td title="${customer.email || ''}">${shortEmail}</td>
            <td title="${customer.address || ''}">${shortAddress}</td>
            <td>${createdDate}</td>
            <td>
                <button class="btn btn-sm btn-warning" onclick="openCustomerModal('${customer.id}')" title="Edit">
                    <i class="bi bi-pencil"></i>
                </button>
                ${customer.id !== 1 ? `<button class="btn btn-sm btn-danger ms-1" onclick="deleteCustomer('${customer.id}')" title="Hapus">
                    <i class="bi bi-trash"></i>
                </button>` : ''}
            </td>
        </tr>`;
    }).join('');
    
    updateCustomerSummary(filtered);
    updateCustomerPagination();
}

function updateCustomerSummary(filtered) {
    const el = document.getElementById('customerSummary');
    if (!el) return;
    const total = filtered.length;
    el.innerHTML = `<small>Total: ${total} pelanggan</small>`;
}

function getFilteredCustomers() {
    let filtered = customers;
    if (customerSearchTerm) {
        const term = customerSearchTerm.toLowerCase();
        filtered = filtered.filter(c => 
            (c.name && c.name.toLowerCase().includes(term)) ||
            (c.phone && c.phone.includes(term)) ||
            (c.email && c.email.toLowerCase().includes(term))
        );
    }
    return filtered;
}

function getPaginatedCustomers() {
    const filtered = getFilteredCustomers();
    if (customerPageSize === 'all') return filtered;
    const start = (customerCurrentPage - 1) * customerPageSize;
    return filtered.slice(start, start + customerPageSize);
}

function updateCustomerPagination() {
    const filtered = getFilteredCustomers();
    const total = filtered.length;
    const totalPages = customerPageSize === 'all' ? 1 : Math.ceil(total / customerPageSize);
    
    // Update top pagination
    const topNav = document.getElementById('customerPaginationTop');
    if (topNav) {
        topNav.innerHTML = generatePaginationHTML(customerCurrentPage, totalPages, 'customer');
    }
    
    // Update bottom pagination
    const bottomNav = document.getElementById('customerPaginationBottom');
    if (bottomNav) {
        bottomNav.innerHTML = generatePaginationHTML(customerCurrentPage, totalPages, 'customer');
    }
}

function openCustomerModal(customerId = null) {
    const modalEl = document.getElementById('customerModal');
    if (!modalEl) return;
    
    const modal = new bootstrap.Modal(modalEl);
    const form = document.getElementById('customerForm');
    const title = modalEl.querySelector('.modal-title');
    
    // Reset form
    form.reset();
    document.getElementById('customerId').value = '';
    
    // Set modal title translation key based on mode
    if (customerId) {
        // Edit mode
        title.setAttribute('data-i18n', 'customers.edit_customer');
        
        // Load customer data
        const customer = customers.find(c => c.id.toString() === customerId.toString());
        if (customer) {
            document.getElementById('customerId').value = customer.id;
            document.getElementById('customerName').value = customer.name;
            document.getElementById('customerPhone').value = customer.phone || '';
            document.getElementById('customerEmail').value = customer.email || '';
            document.getElementById('customerAddress').value = customer.address || '';
        }
    } else {
        // Add mode
        title.setAttribute('data-i18n', 'customers.add_customer');
    }
    
    // Apply translations to modal
    modal.show();
}

// Flag to prevent double submit
let isSavingCustomer = false;

async function saveCustomer() {
    // Prevent double submit
    if (isSavingCustomer) {
        return;
    }
    
    const form = document.getElementById('customerForm');
    if (!form) {
        alert('Form tidak ditemukan!');
        return;
    }
    
    // Validasi form
    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }
    
    const customerId = document.getElementById('customerId').value;
    const name = document.getElementById('customerName').value.trim();
    const phone = document.getElementById('customerPhone').value.trim();
    const email = document.getElementById('customerEmail').value.trim();
    const address = document.getElementById('customerAddress').value.trim();
    
    // PERBAIKAN: Validasi nama wajib diisi
    if (!name) {
        alert('Nama pelanggan wajib diisi!');
        document.getElementById('customerName').focus();
        return;
    }
    
    const customerData = {
        name,
        phone,
        email,
        address
    };
    
    // Set flag dan disable tombol saat menyimpan
    isSavingCustomer = true;
    const saveCustomerBtn = document.getElementById('saveCustomerBtn');
    const originalText = saveCustomerBtn ? saveCustomerBtn.innerHTML : '';
    if (saveCustomerBtn) {
        saveCustomerBtn.disabled = true;
        saveCustomerBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Menyimpan...';
    }
    
    try {
        const url = customerId ? `/api/customers/${customerId}` : '/api/customers';
        const method = customerId ? 'PUT' : 'POST';
        
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(customerData)
        });
        
        const result = await res.json();
        if (!res.ok) {
            throw new Error(result.message || 'Failed to save customer');
        }
        
        // Close modal, then reload list after the modal is fully hidden to avoid leftover backdrop
        const modalEl = document.getElementById('customerModal');
        const modal = bootstrap.Modal.getInstance(modalEl);
        if (modal) {
            // Wait for hidden event once, then proceed
            await new Promise((resolve) => {
                const onHidden = () => {
                    // Safety cleanup if any backdrop/body class remains
                    try {
                        document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
                        document.body.classList.remove('modal-open');
                        document.body.style.removeProperty('padding-right');
                    } catch {}
                    modalEl.removeEventListener('hidden.bs.modal', onHidden);
                    resolve();
                };
                modalEl.addEventListener('hidden.bs.modal', onHidden, { once: true });
                modal.hide();
            });
        }

        await loadCustomers();
        alert(customerId ? 'Pelanggan berhasil diupdate!' : 'Pelanggan berhasil ditambahkan!');
        
    } catch (error) {
        console.error('Failed to save customer:', error);
        alert('Gagal menyimpan pelanggan: ' + error.message);
    } finally {
        // Reset flag dan re-enable tombol setelah selesai
        isSavingCustomer = false;
        if (saveCustomerBtn) {
            saveCustomerBtn.disabled = false;
            saveCustomerBtn.innerHTML = originalText;
        }
    }
}

async function deleteCustomer(customerId) {
    if (!confirm('Apakah Anda yakin ingin menghapus pelanggan ini?')) {
        return;
    }
    
    try {
        const res = await fetch(`/api/customers/${customerId}`, {
            method: 'DELETE'
        });
        
        const result = await res.json();
        if (!res.ok) {
            throw new Error(result.message || 'Failed to delete customer');
        }
        
        await loadCustomers();
        alert('Pelanggan berhasil dihapus!');
        
    } catch (error) {
        console.error('Failed to delete customer:', error);
        alert('Gagal menghapus pelanggan: ' + error.message);
    }
}

// --- Customer Variables ---
let customers = [];
let unitsList = [];
let customerCurrentPage = 1;
let customerPageSize = 10;
let customerSearchTerm = '';

function setupCustomerEventListeners() {
    // Event listener untuk tombol saveCustomerBtn
    const saveCustomerBtn = document.getElementById('saveCustomerBtn');
    if (saveCustomerBtn) {
        saveCustomerBtn.addEventListener('click', (e) => {
            e.preventDefault();
            saveCustomer();
        });
    }
    
    // Handle "Tambah Pelanggan" button click
    const addCustomerBtn = document.getElementById('addCustomerBtn');
    if (addCustomerBtn) {
        addCustomerBtn.addEventListener('click', (e) => {
            e.preventDefault();
            openCustomerModal(); // No parameter = add mode
        });
    }
    
    // Customer search - PERBAIKAN: dengan debouncing
    const customerSearchInput = document.getElementById('customerSearchInput');
    if (customerSearchInput) {
        customerSearchInput.addEventListener('input', (e) => {
            customerSearchTerm = e.target.value.trim();
            customerCurrentPage = 1;
            
            // Clear existing timer
            if (searchDebounceTimers.customer) {
                clearTimeout(searchDebounceTimers.customer);
            }
            
            // Set new timer
            searchDebounceTimers.customer = setTimeout(() => {
                renderCustomers();
            }, 300);
        });
    }
    
    // Clear customer search
    const clearCustomerSearchBtn = document.getElementById('clearCustomerSearchBtn');
    if (clearCustomerSearchBtn) {
        clearCustomerSearchBtn.addEventListener('click', () => {
            // Clear debounce timer
            if (searchDebounceTimers.customer) {
                clearTimeout(searchDebounceTimers.customer);
                searchDebounceTimers.customer = null;
            }
            const searchInput = document.getElementById('customerSearchInput');
            if (searchInput) searchInput.value = '';
            customerSearchTerm = '';
            customerCurrentPage = 1;
            renderCustomers();
        });
    }
    
    // Customer pagination size
    const customerPageSizeSelect = document.getElementById('customerPageSizeSelect');
    if (customerPageSizeSelect) {
        customerPageSizeSelect.addEventListener('change', (e) => {
            customerPageSize = e.target.value === 'all' ? 'all' : parseInt(e.target.value);
            customerCurrentPage = 1;
            renderCustomers();
        });
    }
}

function changeCustomerPage(page, type) {
    if (type === 'customer') {
        customerCurrentPage = page;
        renderCustomers();
    }
}

// Generate pagination HTML helper
function generatePaginationHTML(currentPage, totalPages, type) {
    if (totalPages <= 1) return '';

    let html = '<ul class="pagination mb-0 justify-content-center">';

    // Previous button
    const prevDisabled = currentPage === 1 ? ' disabled' : '';
    html += `<li class="page-item${prevDisabled}">`;
    html += `<a class="page-link" href="#" data-page="${currentPage - 1}">Previous</a>`;
    html += '</li>';

    // Page numbers
    const startPage = Math.max(1, currentPage - 2);
    const endPage = Math.min(totalPages, currentPage + 2);

    // First page and ellipsis if needed
    if (startPage > 1) {
        html += `<li class="page-item"><a class="page-link" href="#" data-page="1">1</a></li>`;
        if (startPage > 2) {
            html += '<li class="page-item disabled"><span class="page-link">...</span></li>';
        }
    }

    // Page numbers
    for (let i = startPage; i <= endPage; i++) {
        const active = i === currentPage ? ' active' : '';
        html += `<li class="page-item${active}">`;
        html += `<a class="page-link" href="#" data-page="${i}">${i}</a>`;
        html += '</li>';
    }

    // Last page and ellipsis if needed
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            html += '<li class="page-item disabled"><span class="page-link">...</span></li>';
        }
        html += `<li class="page-item"><a class="page-link" href="#" data-page="${totalPages}">${totalPages}</a></li>`;
    }

    // Next button
    const nextDisabled = currentPage === totalPages ? ' disabled' : '';
    html += `<li class="page-item${nextDisabled}">`;
    html += `<a class="page-link" href="#" data-page="${currentPage + 1}">Next</a>`;
    html += '</li>';

    html += '</ul>';
    return html;
}

// --- Suppliers & Stock-In Management ---
let suppliers = [];
let supplierCurrentPage = 1;
let supplierPageSize = 10;
let supplierSearchTerm = '';
let stockInProducts = [];
let stockInViewInitialized = false;
let stockInHistory = [];

async function loadSuppliers() {
    try {
        const res = await fetch('/api/suppliers');
        if (!res.ok) throw new Error('Failed to load suppliers');
        suppliers = await res.json();
        if (!Array.isArray(suppliers)) suppliers = [];
        renderSuppliers();
        // Isi dropdown supplier di form stock-in
        const sel = document.getElementById('stockInSupplierSelect');
        if (sel) {
            const current = sel.value;
            sel.innerHTML = '<option value="">Pilih Supplier...</option>' +
                suppliers.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
            if (current) sel.value = current;
        }
    } catch (error) {
        console.error('Failed to load suppliers:', error);
        const tbody = document.getElementById('supplierTableBody');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">Gagal memuat supplier</td></tr>`;
        }
    }
}

function getFilteredSuppliers() {
    let filtered = suppliers;
    if (supplierSearchTerm) {
        const term = supplierSearchTerm.toLowerCase();
        filtered = filtered.filter(s =>
            (s.name && s.name.toLowerCase().includes(term)) ||
            (s.phone && String(s.phone).includes(term))
        );
    }
    return filtered;
}

function getPaginatedSuppliers() {
    const filtered = getFilteredSuppliers();
    if (supplierPageSize === 'all') return filtered;
    const start = (supplierCurrentPage - 1) * supplierPageSize;
    return filtered.slice(start, start + supplierPageSize);
}

function updateSupplierPagination() {
    const filtered = getFilteredSuppliers();
    const total = filtered.length;
    const totalPages = supplierPageSize === 'all' ? 1 : Math.ceil(total / supplierPageSize);

    const topNav = document.getElementById('supplierPaginationTop');
    if (topNav) topNav.innerHTML = generatePaginationHTML(supplierCurrentPage, totalPages, 'supplier');
    const bottomNav = document.getElementById('supplierPaginationBottom');
    if (bottomNav) bottomNav.innerHTML = generatePaginationHTML(supplierCurrentPage, totalPages, 'supplier');

    // Delegasi klik pagination untuk supplier
    [topNav, bottomNav].forEach(nav => {
        if (!nav || nav._supplierBound) return;
        nav.addEventListener('click', (e) => {
            const link = e.target.closest('a.page-link');
            if (!link) return;
            e.preventDefault();
            const page = parseInt(link.dataset.page);
            if (!isNaN(page) && page > 0) {
                supplierCurrentPage = page;
                renderSuppliers();
            }
        });
        nav._supplierBound = true;
    });
}

function updateSupplierSummary(filtered) {
    const el = document.getElementById('supplierSummary');
    if (!el) return;
    const total = filtered.length;
    el.innerHTML = `<small>Total: ${total} supplier</small>`;
}

function renderSuppliers() {
    const tbody = document.getElementById('supplierTableBody');
    if (!tbody) return;

    const filtered = getFilteredSuppliers();
    const paginated = getPaginatedSuppliers();

    if (!paginated.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center">Tidak ada supplier.</td></tr>`;
        updateSupplierSummary(filtered);
        updateSupplierPagination();
        return;
    }

    const start = (supplierCurrentPage - 1) * (supplierPageSize === 'all' ? paginated.length : supplierPageSize);
    tbody.innerHTML = paginated.map((s, idx) => {
        const created = s.createdAt ? new Date(s.createdAt).toLocaleDateString('id-ID') : '-';
        const addrShort = s.address && s.address.length > 40 ? s.address.substring(0, 40) + '...' : (s.address || '-');
        const notesShort = s.notes && s.notes.length > 40 ? s.notes.substring(0, 40) + '...' : (s.notes || '-');
        return `
        <tr>
            <td>${start + idx + 1}</td>
            <td>${s.name || '-'}</td>
            <td>${s.phone || '-'}</td>
            <td title="${s.address || ''}">${addrShort}</td>
            <td title="${s.notes || ''}">${notesShort}</td>
            <td>${created}</td>
            <td>
                <button class="btn btn-sm btn-warning" onclick="editSupplier('${s.id}')" title="Edit">
                    <i class="bi bi-pencil"></i>
                </button>
                <button class="btn btn-sm btn-danger ms-1" onclick="deleteSupplier('${s.id}')" title="Hapus">
                    <i class="bi bi-trash"></i>
                </button>
            </td>
        </tr>`;
    }).join('');

    updateSupplierSummary(filtered);
    updateSupplierPagination();
}

function openSupplierPrompt(existing) {
    const name = prompt('Nama supplier:', existing ? existing.name || '' : '');
    if (!name || !name.trim()) return null;
    const phone = prompt('Telepon:', existing ? existing.phone || '' : '') || '';
    const address = prompt('Alamat:', existing ? existing.address || '' : '') || '';
    const notes = prompt('Catatan:', existing ? existing.notes || '' : '') || '';
    return { name: name.trim(), phone: phone.trim(), address: address.trim(), notes: notes.trim() };
}

async function addSupplierViaPrompt() {
    const data = openSupplierPrompt(null);
    if (!data) return;
    try {
        const res = await fetch('/api/suppliers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.message || 'Gagal menyimpan supplier');
        await loadSuppliers();
        alert('Supplier berhasil ditambahkan');
    } catch (e) {
        alert('Gagal menambah supplier: ' + e.message);
    }
}

async function editSupplier(id) {
    const sup = suppliers.find(s => String(s.id) === String(id));
    if (!sup) return;
    const data = openSupplierPrompt(sup);
    if (!data) return;
    try {
        const res = await fetch(`/api/suppliers/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.message || 'Gagal menyimpan supplier');
        await loadSuppliers();
        alert('Supplier berhasil diupdate');
    } catch (e) {
        alert('Gagal mengupdate supplier: ' + e.message);
    }
}

async function deleteSupplier(id) {
    if (!confirm('Hapus supplier ini?')) return;
    try {
        const res = await fetch(`/api/suppliers/${id}`, { method: 'DELETE' });
        const result = await res.json();
        if (!res.ok) throw new Error(result.message || 'Gagal menghapus supplier');
        await loadSuppliers();
        alert('Supplier berhasil dihapus');
    } catch (e) {
        alert('Gagal menghapus supplier: ' + e.message);
    }
}

async function loadStockInProducts() {
    try {
        const res = await fetch('/api/products');
        if (!res.ok) throw new Error('Failed to load products');
        stockInProducts = await res.json();
        if (!Array.isArray(stockInProducts)) stockInProducts = [];
    } catch (e) {
        console.error('Failed to load products for stock-in:', e);
        stockInProducts = [];
    }
}

function createStockInProductSelect(selectedId) {
    const sel = document.createElement('select');
    sel.className = 'form-select form-select-sm stock-in-product';
    sel.innerHTML = '<option value="">Pilih produk...</option>' +
        stockInProducts.map(p => {
            const unit = p.unit ? ` ${p.unit}` : '';
            return `<option value="${p.id}">${p.name} (${p.sku || p.id})${unit}</option>`;
        }).join('');
    if (selectedId) sel.value = String(selectedId);
    return sel;
}

function addStockInRow(defaultData) {
    const tbody = document.getElementById('stockInItemsBody');
    if (!tbody) return;
    const tr = document.createElement('tr');

    const tdProd = document.createElement('td');
    const prodSel = createStockInProductSelect(defaultData && defaultData.productId);
    tdProd.appendChild(prodSel);

    const tdQty = document.createElement('td');
    const qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.min = '1';
    qtyInput.value = defaultData && defaultData.qty ? defaultData.qty : 1;
    qtyInput.className = 'form-control form-control-sm stock-in-qty';
    tdQty.appendChild(qtyInput);

    const tdPrice = document.createElement('td');
    const priceInput = document.createElement('input');
    priceInput.type = 'number';
    priceInput.min = '0';
    priceInput.value = defaultData && defaultData.purchasePrice ? defaultData.purchasePrice : '';
    priceInput.className = 'form-control form-control-sm stock-in-price';
    tdPrice.appendChild(priceInput);

    const tdSub = document.createElement('td');
    const subSpan = document.createElement('span');
    subSpan.className = 'stock-in-subtotal';
    subSpan.textContent = '0';
    tdSub.appendChild(subSpan);

    const tdAct = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-sm btn-outline-danger';
    delBtn.innerHTML = '<i class="bi bi-trash"></i>';
    delBtn.addEventListener('click', () => {
        tr.remove();
        recalcStockInTotals();
    });
    tdAct.appendChild(delBtn);

    [tdProd, tdQty, tdPrice, tdSub, tdAct].forEach(td => tr.appendChild(td));

    [prodSel, qtyInput, priceInput].forEach(el => {
        el.addEventListener('change', recalcStockInTotals);
        el.addEventListener('input', recalcStockInTotals);
    });

    tbody.appendChild(tr);
    recalcStockInTotals();
}

async function handleCreateNewProductFromStockIn(selectEl) {
    // Reset pilihan jika user batal
    const resetSelect = () => {
        if (selectEl) selectEl.value = '';
    };

    const name = prompt('Nama produk baru:');
    if (!name || !name.trim()) {
        resetSelect();
        return;
    }
    const sku = prompt('SKU / Barcode (boleh dikosongkan):') || '';
    const purchaseStr = prompt('Harga beli (angka):', '0') || '0';
    const sellStr = prompt('Harga jual (angka):', purchaseStr || '0') || purchaseStr || '0';

    const purchasePrice = Number(purchaseStr.replace(/[^0-9.]/g, '')) || 0;
    const sellingPrice = Number(sellStr.replace(/[^0-9.]/g, '')) || 0;

    const payload = {
        name: name.trim(),
        sku: sku.trim() || undefined,
        purchasePrice,
        sellingPrice,
        price: sellingPrice,
        stock: 0
    };

    try {
        await ensureCsrfTokenReady();
        const token = (window.csrfToken || '');
        try { payload._csrf = token; } catch {}

        const res = await fetch('/api/products', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': token,
                'x-xsrf-token': token
            },
            credentials: 'include',
            body: JSON.stringify(payload)
        });
        const result = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(result.message || 'Gagal membuat produk baru');

        const newProduct = result.product || result || null;
        const newId = newProduct && (newProduct.id || newProduct._id);
        await loadStockInProducts();

        // Update ulang options select
        const fresh = createStockInProductSelect(newId);
        if (selectEl && selectEl.parentNode) {
            selectEl.parentNode.replaceChild(fresh, selectEl);
        }
        alert('Produk baru berhasil dibuat');
    } catch (e) {
        console.error('Gagal membuat produk baru dari stock-in:', e);
        alert('Gagal membuat produk baru: ' + (e.message || e));
        resetSelect();
    }
}

function recalcStockInTotals() {
    const tbody = document.getElementById('stockInItemsBody');
    if (!tbody) return;
    let totalQty = 0;
    let totalAmount = 0;
    tbody.querySelectorAll('tr').forEach(tr => {
        const qtyInput = tr.querySelector('.stock-in-qty');
        const priceInput = tr.querySelector('.stock-in-price');
        const subSpan = tr.querySelector('.stock-in-subtotal');
        const qty = Number(qtyInput && qtyInput.value ? qtyInput.value : 0) || 0;
        const price = Number(priceInput && priceInput.value ? priceInput.value : 0) || 0;
        const sub = qty * price;
        totalQty += qty;
        totalAmount += sub;
        if (subSpan) subSpan.textContent = formatCurrency(sub);
    });
    const totalQtyEl = document.getElementById('stockInTotalQty');
    if (totalQtyEl) totalQtyEl.textContent = totalQty;
    const totalAmountEl = document.getElementById('stockInTotalAmount');
    if (totalAmountEl) totalAmountEl.value = totalAmount || 0;
    // Hitung sisa
    const paidEl = document.getElementById('stockInPaidAmount');
    const remainingEl = document.getElementById('stockInRemainingAmount');
    if (paidEl && remainingEl) {
        const paid = Number(paidEl.value) || 0;
        remainingEl.value = Math.max(0, totalAmount - paid);
    }
}

async function saveStockIn(e) {
    if (e) e.preventDefault();
    const dateInput = document.getElementById('stockInDate');
    const supplierSel = document.getElementById('stockInSupplierSelect');
    const noteInput = document.getElementById('stockInNote');
    const totalAmountEl = document.getElementById('stockInTotalAmount');
    const paidAmountEl = document.getElementById('stockInPaidAmount');
    const remainingAmountEl = document.getElementById('stockInRemainingAmount');
    const paymentDateEl = document.getElementById('stockInPaymentDate');
    const tbody = document.getElementById('stockInItemsBody');
    if (!supplierSel || !tbody) return;
    const supplierId = supplierSel.value;
    if (!supplierId) {
        alert('Pilih supplier terlebih dahulu.');
        return;
    }
    const items = [];
    tbody.querySelectorAll('tr').forEach(tr => {
        const prodSel = tr.querySelector('.stock-in-product');
        const qtyInput = tr.querySelector('.stock-in-qty');
        const priceInput = tr.querySelector('.stock-in-price');
        const productId = prodSel && prodSel.value;
        const qty = Number(qtyInput && qtyInput.value ? qtyInput.value : 0) || 0;
        const purchasePrice = Number(priceInput && priceInput.value ? priceInput.value : 0) || 0;
        if (productId && qty > 0 && purchasePrice > 0) {
            items.push({ productId, qty, purchasePrice });
        }
    });
    if (items.length === 0) {
        alert('Tambahkan minimal satu barang dengan qty dan harga beli.');
        return;
    }
    const payload = {
        date: dateInput && dateInput.value ? dateInput.value : new Date().toISOString().slice(0,10),
        supplierId: Number(supplierId),
        note: noteInput ? noteInput.value.trim() : '',
        items,
        totalAmount: Number(totalAmountEl && totalAmountEl.value ? totalAmountEl.value : 0) || 0,
        paidAmount: Number(paidAmountEl && paidAmountEl.value ? paidAmountEl.value : 0) || 0,
        remainingAmount: Number(remainingAmountEl && remainingAmountEl.value ? remainingAmountEl.value : 0) || 0,
        paymentDate: paymentDateEl && paymentDateEl.value ? paymentDateEl.value : ''
    };
    const btn = document.getElementById('saveStockInBtn');
    const originalText = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Menyimpan...';
    }
    try {
        await ensureCsrfTokenReady();
        const token = (window.csrfToken || '');
        try { payload._csrf = token; } catch {}
        const res = await fetch('/api/stock-in', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': token,
                'x-xsrf-token': token
            },
            credentials: 'include',
            body: JSON.stringify(payload)
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.message || 'Gagal menyimpan barang masuk');
        alert('Barang masuk berhasil disimpan');
        // Reset form
        if (tbody) tbody.innerHTML = '';
        addStockInRow();
        recalcStockInTotals();
        if (totalAmountEl) totalAmountEl.value = '';
        if (paidAmountEl) paidAmountEl.value = '';
        if (remainingAmountEl) remainingAmountEl.value = '';
        if (paymentDateEl) paymentDateEl.value = '';
        // Refresh stok produk di halaman lain jika diperlukan
        try { await loadProducts(); } catch(e2) {}
        try { await loadStockInHistory(); } catch(e3) {}
        // Refresh credits page if it's currently active
        try { 
            const creditsView = document.getElementById('credits-view');
            if (creditsView && creditsView.style.display !== 'none') {
                await loadCredits(); 
            }
        } catch(e4) {}
    } catch (e) {
        console.error('Failed to save stock-in:', e);
        alert('Gagal menyimpan barang masuk: ' + e.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

function initStockInView() {
    if (stockInViewInitialized) return;
    stockInViewInitialized = true;

    const addSupplierBtn = document.getElementById('addSupplierBtn');
    if (addSupplierBtn) {
        addSupplierBtn.addEventListener('click', (e) => {
            e.preventDefault();
            addSupplierViaPrompt();
        });
    }

    const supplierSearchInput = document.getElementById('supplierSearchInput');
    if (supplierSearchInput) {
        supplierSearchInput.addEventListener('input', (e) => {
            supplierSearchTerm = (e.target.value || '').toString().trim();
            supplierCurrentPage = 1;
            renderSuppliers();
        });
    }
    const clearSupplierSearchBtn = document.getElementById('clearSupplierSearchBtn');
    if (clearSupplierSearchBtn) {
        clearSupplierSearchBtn.addEventListener('click', () => {
            supplierSearchTerm = '';
            const inp = document.getElementById('supplierSearchInput');
            if (inp) inp.value = '';
            supplierCurrentPage = 1;
            renderSuppliers();
        });
    }

    const supplierPageSizeSelect = document.getElementById('supplierPageSizeSelect');
    if (supplierPageSizeSelect) {
        supplierPageSizeSelect.addEventListener('change', (e) => {
            const v = e.target.value;
            supplierPageSize = v === 'all' ? 'all' : parseInt(v);
            supplierCurrentPage = 1;
            renderSuppliers();
        });
    }

    // Tanggal default hari ini
    const dateInput = document.getElementById('stockInDate');
    if (dateInput && !dateInput.value) {
        dateInput.value = new Date().toISOString().slice(0,10);
    }

    // Tanggal bayar default hari ini
    const paymentDateInput = document.getElementById('stockInPaymentDate');
    if (paymentDateInput && !paymentDateInput.value) {
        paymentDateInput.value = new Date().toISOString().slice(0,10);
    }

    // Event listener untuk Uang Dibayar
    const paidInput = document.getElementById('stockInPaidAmount');
    if (paidInput) {
        paidInput.addEventListener('input', recalcStockInTotals);
    }

    const stockInForm = document.getElementById('stockInForm');
    if (stockInForm) {
        stockInForm.addEventListener('submit', saveStockIn);
    }

    const addItemBtn = document.getElementById('addStockInItemBtn');
    if (addItemBtn) {
        addItemBtn.addEventListener('click', (e) => {
            e.preventDefault();
            addStockInRow();
        });
    }

    // Tambah satu baris awal
    addStockInRow();

    // Tombol buka modal produk dari halaman Stock-In
    const openProdBtn = document.getElementById('openProductModalFromStockInBtn');
    if (openProdBtn) {
        openProdBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const modalEl = document.getElementById('productModal');
            if (!modalEl || typeof bootstrap === 'undefined') return;
            const form = document.getElementById('productForm');
            if (form) form.reset();
            const idInput = document.getElementById('productId');
            if (idInput) idInput.value = '';
            const m = new bootstrap.Modal(modalEl);

            const onHidden = async () => {
                modalEl.removeEventListener('hidden.bs.modal', onHidden);
                try {
                    await loadProducts();
                } catch (e) {}
                try {
                    await loadStockInProducts();
                } catch (e) {}

                // Perbarui semua select stok-in dengan daftar produk terbaru
                const selects = document.querySelectorAll('#stockInItemsBody select.stock-in-product');
                selects.forEach(oldSel => {
                    const currentVal = oldSel.value;
                    const fresh = createStockInProductSelect(currentVal);
                    oldSel.parentNode.replaceChild(fresh, oldSel);
                });
            };

            modalEl.addEventListener('hidden.bs.modal', onHidden, { once: true });
            m.show();
        });
    }
}

// --- Event Listeners ---
function setupEventListeners() {
    // Replace select all checkbox with custom checkbox
    const selectAllOriginal = document.getElementById('selectAllProducts');
    if (selectAllOriginal) {
        const wrapper = document.createElement('div');
        wrapper.style.display = 'inline-block';
        selectAllOriginal.parentNode.insertBefore(wrapper, selectAllOriginal);
        
        const newCheckbox = document.createElement('input');
        newCheckbox.type = 'checkbox';
        newCheckbox.id = 'selectAllProducts';
        newCheckbox.className = 'custom-checkbox-input';
        newCheckbox.style.display = 'none';
        
        const label = document.createElement('label');
        label.htmlFor = 'selectAllProducts';
        label.className = 'custom-checkbox';
        label.innerHTML = `
            <svg width="18px" height="18px" viewBox="0 0 18 18">
                <path d="M1,9 L1,3.5 C1,2 2,1 3.5,1 L14.5,1 C16,1 17,2 17,3.5 L17,14.5 C17,16 16,17 14.5,17 L3.5,17 C2,17 1,16 1,14.5 L1,9 Z"></path>
                <polyline points="1 9 7 14 15 4"></polyline>
            </svg>
        `;
        
        wrapper.appendChild(newCheckbox);
        wrapper.appendChild(label);
        selectAllOriginal.remove();
    }
    
    // === PRODUCTS ===
    // Export/Import Products - Find button in products view
    setTimeout(() => {
        const productsView = document.getElementById('products-view');
        if (productsView) {
            const exportBtn = productsView.querySelector('button[data-i18n="buttons.export_xlsx"]');
            if (exportBtn) exportBtn.addEventListener('click', exportProductsToXlsx);
            const templateBtn = Array.from(productsView.querySelectorAll('button')).find(btn => 
                btn.innerHTML.includes('bi-file-earmark-spreadsheet') && btn.closest('#products-view')
            );
            if (templateBtn) templateBtn.addEventListener('click', downloadImportTemplate);
        }
    }, 100);
    
    document.getElementById('chooseFileBtn')?.addEventListener('click', triggerFileSelection);
    document.getElementById('importFileInput')?.addEventListener('change', handleFileSelection);
    document.getElementById('importFileBtn')?.addEventListener('click', processImport);
    
    // === CATEGORIES ===
    document.getElementById('exportCategoriesBtn')?.addEventListener('click', exportCategoriesToXlsx);
    document.getElementById('downloadCategoryTemplateBtn')?.addEventListener('click', downloadCategoryTemplate);
    document.getElementById('chooseCategoryFileBtn')?.addEventListener('click', triggerCategoryFileSelection);
    document.getElementById('importCategoryFileInput')?.addEventListener('change', handleCategoryFileSelection);
    document.getElementById('importCategoryFileBtn')?.addEventListener('click', processCategoryImport);
    
    // === UNITS (Satuan) ===
    document.getElementById('exportUnitsBtn')?.addEventListener('click', exportUnitsToXlsx);
    document.getElementById('downloadUnitTemplateBtn')?.addEventListener('click', downloadUnitTemplate);
    document.getElementById('chooseUnitFileBtn')?.addEventListener('click', triggerUnitFileSelection);
    document.getElementById('importUnitFileInput')?.addEventListener('change', handleUnitFileSelection);
    document.getElementById('importUnitFileBtn')?.addEventListener('click', processUnitImport);
    document.getElementById('saveUnitBtn')?.addEventListener('click', (e)=>{ e.preventDefault(); saveUnit(); });
    // Unit search with debounce
    const unitSearchInput = document.getElementById('unitSearchInput');
    if (unitSearchInput) {
        unitSearchInput.addEventListener('input', (e) => {
            unitSearchTerm = (e.target.value || '').toString().trim();
            unitCurrentPage = 1;
            if (searchDebounceTimers.unit) { clearTimeout(searchDebounceTimers.unit); }
            searchDebounceTimers.unit = setTimeout(()=>{ renderUnits(); }, 300);
        });
    }
    const clearUnitSearchBtn = document.getElementById('clearUnitSearchBtn');
    if (clearUnitSearchBtn) {
        clearUnitSearchBtn.addEventListener('click', () => {
            if (searchDebounceTimers.unit) { clearTimeout(searchDebounceTimers.unit); searchDebounceTimers.unit = null; }
            unitSearchTerm = '';
            const input = document.getElementById('unitSearchInput'); if (input) input.value = '';
            unitCurrentPage = 1; renderUnits();
        });
    }
    const unitPageSizeSelect = document.getElementById('unitPageSizeSelect');
    if (unitPageSizeSelect) {
        unitPageSizeSelect.addEventListener('change', (e) => {
            const v = e.target.value; unitPageSize = v === 'all' ? 'all' : parseInt(v); unitCurrentPage = 1; renderUnits();
        });
    }
    
    // === TRANSACTIONS ===
    document.getElementById('exportTransactionsBtn')?.addEventListener('click', exportTransactionsToXlsx);
    
    // === USERS ===
    document.getElementById('exportUsersBtn')?.addEventListener('click', exportUsersToXlsx);
    document.getElementById('downloadUserTemplateBtn')?.addEventListener('click', downloadUserTemplate);
    document.getElementById('chooseUserFileBtn')?.addEventListener('click', triggerUserFileSelection);
    document.getElementById('importUserFileInput')?.addEventListener('change', handleUserFileSelection);
    document.getElementById('importUserFileBtn')?.addEventListener('click', processUserImport);
    
    // === CUSTOMERS ===
    document.getElementById('exportCustomersBtn')?.addEventListener('click', exportCustomersToXlsx);
    document.getElementById('downloadCustomerTemplateBtn')?.addEventListener('click', downloadCustomerTemplate);
    document.getElementById('chooseCustomerFileBtn')?.addEventListener('click', triggerCustomerFileSelection);
    document.getElementById('importCustomerFileInput')?.addEventListener('change', handleCustomerFileSelection);
    document.getElementById('importCustomerFileBtn')?.addEventListener('click', processCustomerImport);

    // Product search - PERBAIKAN: dengan debouncing
    const productSearchInput = document.getElementById('productSearchInput');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    if (productSearchInput) {
        productSearchInput.addEventListener('input', (e) => {
            searchTerm = e.target.value || '';
            currentPage = 1;
            
            // Clear existing timer
            if (searchDebounceTimers.product) {
                clearTimeout(searchDebounceTimers.product);
            }
            
            // Set new timer - render setelah 300ms tidak ada input
            searchDebounceTimers.product = setTimeout(() => {
                renderProducts();
            }, 300);
        });
    }
    if (clearSearchBtn) {
        clearSearchBtn.addEventListener('click', () => {
            // Clear debounce timer saat clear
            if (searchDebounceTimers.product) {
                clearTimeout(searchDebounceTimers.product);
                searchDebounceTimers.product = null;
            }
            searchTerm = '';
            const input = document.getElementById('productSearchInput');
            if (input) input.value = '';
            currentPage = 1;
            renderProducts();
        });
    }

    // Produk: Tampilkan data (page size)
    const pageSizeSelect = document.getElementById('pageSizeSelect');
    if (pageSizeSelect) {
        pageSizeSelect.addEventListener('change', (e) => {
            const val = e.target.value;
            pageSize = val === 'all' ? 'all' : parseInt(val);
            currentPage = 1;
            renderProducts();
        });
    }

    // Kategori: pencarian - PERBAIKAN: dengan debouncing
    const categorySearchInput = document.getElementById('categorySearchInput');
    if (categorySearchInput) {
        categorySearchInput.addEventListener('input', (e) => {
            categorySearchTerm = (e.target.value || '').toString().trim();
            categoryCurrentPage = 1;
            
            // Clear existing timer
            if (searchDebounceTimers.category) {
                clearTimeout(searchDebounceTimers.category);
            }
            
            // Set new timer
            searchDebounceTimers.category = setTimeout(() => {
                renderCategories();
            }, 300);
        });
    }
    // Kategori: hapus pencarian
    const clearCategorySearchBtn = document.getElementById('clearCategorySearchBtn');
    if (clearCategorySearchBtn) {
        clearCategorySearchBtn.addEventListener('click', () => {
            // Clear debounce timer
            if (searchDebounceTimers.category) {
                clearTimeout(searchDebounceTimers.category);
                searchDebounceTimers.category = null;
            }
            categorySearchTerm = '';
            const inp = document.getElementById('categorySearchInput');
            if (inp) inp.value = '';
            categoryCurrentPage = 1;
            renderCategories();
        });
    }
    // Kategori: page size
    const categoryPageSizeSelect = document.getElementById('categoryPageSizeSelect');
    if (categoryPageSizeSelect) {
        categoryPageSizeSelect.addEventListener('change', (e) => {
            const v = e.target.value;
            categoryPageSize = v === 'all' ? 'all' : parseInt(v);
            categoryCurrentPage = 1;
            renderCategories();
        });
    }

    // Transaksi: pencarian - PERBAIKAN: dengan debouncing
    const txSearchInput = document.getElementById('transactionSearchInput');
    if (txSearchInput) {
        txSearchInput.addEventListener('input', (e) => {
            transactionSearchTerm = (e.target.value || '').trim();
            transactionCurrentPage = 1;
            
            // Clear existing timer
            if (searchDebounceTimers.transaction) {
                clearTimeout(searchDebounceTimers.transaction);
            }
            
            // Set new timer
            searchDebounceTimers.transaction = setTimeout(() => {
                renderTransactions();
            }, 300);
        });
    }
    const clearTxBtn = document.getElementById('clearTransactionSearchBtn');
    if (clearTxBtn) {
        clearTxBtn.addEventListener('click', () => {
            // Clear debounce timer
            if (searchDebounceTimers.transaction) {
                clearTimeout(searchDebounceTimers.transaction);
                searchDebounceTimers.transaction = null;
            }
            transactionSearchTerm = '';
            const inp = document.getElementById('transactionSearchInput');
            if (inp) inp.value = '';
            transactionCurrentPage = 1;
            renderTransactions();
        });
    }

    // Transaksi: filter metode
    const payFilter = document.getElementById('paymentMethodFilter');
    if (payFilter) {
        payFilter.addEventListener('change', (e) => {
            paymentMethodFilter = (e.target.value || '').toString().trim().toLowerCase();
            transactionCurrentPage = 1;
            renderTransactions();
        });
    }

    // Transaksi: filter tanggal
    const dateFilter = document.getElementById('dateRangeFilter');
    if (dateFilter) {
        dateFilter.addEventListener('change', (e) => {
            dateRangeFilter = e.target.value;
            if (dateRangeFilter === 'custom') {
                const s = document.getElementById('startDate');
                const e2 = document.getElementById('endDate');
                if (s) s.value = customStartDate || '';
                if (e2) e2.value = customEndDate || '';
                dateRangeModal.show();
            } else {
                customStartDate = '';
                customEndDate = '';
                transactionCurrentPage = 1;
                renderTransactions();
            }
        });
    }
    const applyDateBtn = document.getElementById('applyDateFilterBtn');
    if (applyDateBtn) {
        applyDateBtn.addEventListener('click', () => {
            const s = document.getElementById('startDate').value;
            const e = document.getElementById('endDate').value;
            customStartDate = s;
            customEndDate = e;
            dateRangeFilter = 'custom';
            dateRangeModal.hide();
            transactionCurrentPage = 1;
            renderTransactions();
        });
    }

    // Transaksi: page size
    const txPageSizeSel = document.getElementById('transactionPageSizeSelect');
    if (txPageSizeSel) {
        txPageSizeSel.addEventListener('change', (e) => {
            const v = e.target.value;
            transactionPageSize = v === 'all' ? 'all' : parseInt(v);
            transactionCurrentPage = 1;
            renderTransactions();
        });
    }

    // Shifts: filters & page size
    const shiftPageSizeSel = document.getElementById('shiftPageSizeSelect');
    if (shiftPageSizeSel) {
        shiftPageSizeSel.addEventListener('change', (e) => {
            const v = e.target.value;
            shiftPageSize = v === 'all' ? 'all' : parseInt(v);
            shiftCurrentPage = 1;
            renderShifts();
        });
    }
    const applyShiftFilterBtn = document.getElementById('applyShiftFilterBtn');
    if (applyShiftFilterBtn) {
        applyShiftFilterBtn.addEventListener('click', () => {
            const fromEl = document.getElementById('shiftDateFrom');
            const toEl = document.getElementById('shiftDateTo');
            shiftDateFromFilter = fromEl ? (fromEl.value || '') : '';
            shiftDateToFilter = toEl ? (toEl.value || '') : '';
            const sel = document.getElementById('shiftCashierFilter');
            shiftCashierFilterValue = sel ? (sel.value || '') : '';
            shiftCurrentPage = 1;
            renderShifts();
        });
    }
    const shiftCashierFilterSel = document.getElementById('shiftCashierFilter');
    if (shiftCashierFilterSel) {
        shiftCashierFilterSel.addEventListener('change', (e) => {
            shiftCashierFilterValue = e.target.value || '';
            shiftCurrentPage = 1;
            renderShifts();
        });
    }

    // Real-time validation
    const setupValidation = (inputId, checkUrl, errorMsg) => {
        const input = document.getElementById(inputId);
        if (!input) return;
        let timeout;
        input.addEventListener('input', () => {
            clearTimeout(timeout);
            const val = input.value.trim();
            if (val.length < (inputId === 'userUsername' ? 3 : 2)) {
                input.classList.remove('is-invalid', 'is-valid');
                return;
            }
            timeout = setTimeout(async () => {
                try {
                    const id = document.getElementById(inputId.replace('Name', 'Id') || 'userId')?.value;
                    const url = id ? `${checkUrl}/${id}` : checkUrl;
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(inputId === 'userUsername' ? { username: val } : { name: val })
                    });
                    const result = await res.json();
                    if (result.exists) {
                        input.classList.add('is-invalid');
                        input.classList.remove('is-valid');
                        showValidationMessage(input, errorMsg);
                    } else {
                        input.classList.add('is-valid');
                        input.classList.remove('is-invalid');
                        hideValidationMessage(input);
                    }
                } catch (error) {
                    console.error('Validation error:', error);
                }
            }, 500);
        });
        input.addEventListener('focus', () => {
            input.classList.remove('is-invalid', 'is-valid');
            hideValidationMessage(input);
        });
    };

    setupValidation('userUsername', '/api/users/check-username', 'Username sudah ada!');
    setupValidation('productName', '/api/products/check-name', 'Nama produk sudah ada!');
    setupValidation('categoryName', '/api/categories/check-name', 'Nama kategori sudah ada!');
    setupValidation('customerName', '/api/customers/check-name', 'Nama pelanggan sudah ada!');

    // ✅ Event delegation untuk pagination
    document.addEventListener('click', (e) => {
        if (e.target.matches('#paginationTop a.page-link, #paginationBottom a.page-link')) {
            e.preventDefault();
            const page = parseInt(e.target.dataset.page);
            if (!isNaN(page)) {
                currentPage = page;
                renderProducts();
            }
        }
        if (e.target.matches('#categoryPaginationTop a.page-link, #categoryPaginationBottom a.page-link')) {
            e.preventDefault();
            const page = parseInt(e.target.dataset.page);
            if (!isNaN(page)) {
                categoryCurrentPage = page;
                renderCategories();
            }
        }
        if (e.target.matches('#userPaginationTop a.page-link, #userPaginationBottom a.page-link')) {
            e.preventDefault();
            const page = parseInt(e.target.dataset.page);
            if (!isNaN(page) && page > 0) {
                userCurrentPage = page;
                renderUsers();
            }
        }
        if (e.target.matches('#transactionPaginationTop a.page-link, #transactionPaginationBottom a.page-link')) {
            e.preventDefault();
            const page = parseInt(e.target.dataset.page);
            if (!isNaN(page)) {
                transactionCurrentPage = page;
                renderTransactions();
            }
        }
        if (e.target.matches('#shiftPaginationTop a.page-link, #shiftPaginationBottom a.page-link')) {
            e.preventDefault();
            const page = parseInt(e.target.dataset.page);
            if (!isNaN(page)) {
                shiftCurrentPage = page;
                renderShifts();
            }
        }
        if (e.target.matches('#unitPaginationTop a.page-link, #unitPaginationBottom a.page-link')) {
            e.preventDefault();
            const page = parseInt(e.target.dataset.page);
            if (!isNaN(page)) {
                unitCurrentPage = page;
                renderUnits();
            }
        }
        if (e.target.matches('#customerPaginationTop a.page-link, #customerPaginationBottom a.page-link')) {
            e.preventDefault();
            const page = parseInt(e.target.dataset.page);
            if (!isNaN(page)) {
                customerCurrentPage = page;
                renderCustomers();
            }
        }
    });

    // User Filters - PERBAIKAN: dengan debouncing
    const userSearchInput = document.getElementById('userSearchInput');
    if (userSearchInput) {
        userSearchInput.addEventListener('input', (e) => {
            userSearchTerm = e.target.value;
            userCurrentPage = 1;
            
            // Clear existing timer
            if (searchDebounceTimers.user) {
                clearTimeout(searchDebounceTimers.user);
            }
            
            // Set new timer
            searchDebounceTimers.user = setTimeout(() => {
                renderUsers();
            }, 300);
        });
    }
    const clearUserSearchBtn = document.getElementById('clearUserSearchBtn');
    if (clearUserSearchBtn) {
        clearUserSearchBtn.addEventListener('click', () => {
            // Clear debounce timer
            if (searchDebounceTimers.user) {
                clearTimeout(searchDebounceTimers.user);
                searchDebounceTimers.user = null;
            }
            userSearchTerm = '';
            if (userSearchInput) userSearchInput.value = '';
            userCurrentPage = 1;
            renderUsers();
        });
    }
    document.getElementById('roleFilter')?.addEventListener('change', (e) => {
        roleFilter = e.target.value;
        userCurrentPage = 1;
        renderUsers();
    });
    document.getElementById('statusFilter')?.addEventListener('change', (e) => {
        statusFilter = e.target.value;
        userCurrentPage = 1;
        renderUsers();
    });
    document.getElementById('userPageSizeSelect')?.addEventListener('change', (e) => {
        userPageSize = e.target.value === 'all' ? 'all' : parseInt(e.target.value);
        userCurrentPage = 1;
        renderUsers();
    });

    // Backup buttons (bind once)
    if (!window.__backupListenersBound) {
        window.__backupListenersBound = true;
        const dlDb = document.getElementById('downloadDbBackupBtn');
        if (dlDb && !dlDb.dataset.bound) {
            dlDb.dataset.bound = '1';
            dlDb.addEventListener('click', async () => {
                const original = dlDb.innerHTML;
                dlDb.disabled = true; dlDb.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Memproses...';
                try {
                    const res = await fetch('/api/backup/database');
                    if (!res.ok) throw new Error('Gagal membuat backup database');
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = `backup-database-${Date.now()}.json`;
                    document.body.appendChild(a); a.click(); a.remove();
                    URL.revokeObjectURL(url);
                } catch (e) { alert('Gagal mengunduh backup database'); }
                finally { dlDb.disabled = false; dlDb.innerHTML = original; }
            });
        }
        const dlApp = document.getElementById('downloadAppZipBtn');
        if (dlApp && !dlApp.dataset.bound) {
            dlApp.dataset.bound = '1';
            dlApp.addEventListener('click', async () => {
                const original = dlApp.innerHTML;
                dlApp.disabled = true; dlApp.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Memproses...';
                try {
                    const res = await fetch('/api/backup/app-zip');
                    if (!res.ok) throw new Error('Gagal membuat backup aplikasi (ZIP)');
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = `backup-app-${Date.now()}.zip`;
                    document.body.appendChild(a); a.click(); a.remove();
                    URL.revokeObjectURL(url);
                } catch (e) { alert('Gagal mengunduh backup aplikasi (ZIP)'); }
                finally { dlApp.disabled = false; dlApp.innerHTML = original; }
            });
        }
        const dlDbZip = document.getElementById('downloadDbZipBtn');
        if (dlDbZip && !dlDbZip.dataset.bound) {
            dlDbZip.dataset.bound = '1';
            dlDbZip.addEventListener('click', async () => {
                const original = dlDbZip.innerHTML;
                dlDbZip.disabled = true; dlDbZip.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Memproses...';
                try {
                    const res = await fetch('/api/backup/database-zip');
                    if (!res.ok) throw new Error('Gagal membuat backup ZIP');
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = `backup-data-${Date.now()}.zip`;
                    document.body.appendChild(a); a.click(); a.remove();
                    URL.revokeObjectURL(url);
                } catch (e) { alert('Gagal mengunduh backup ZIP'); }
                finally { dlDbZip.disabled = false; dlDbZip.innerHTML = original; }
            });
        }
    }
}

// Language event handlers
// PERBAIKAN: loadLanguages(), updateUILanguage(), dan switchLanguage() tidak terdefinisi
// Fungsi-fungsi ini dihapus untuk mencegah error

// Language switcher
document.getElementById('switchLanguageBtn')?.addEventListener('click', async () => {
    const langSelect = document.getElementById('currentLanguageSelect');
    if (!langSelect) return;
    
    const newLang = langSelect.value;
    // PERBAIKAN: switchLanguage() tidak terdefinisi, gunakan localStorage langsung
    try {
        localStorage.setItem('language', newLang);
        alert('Bahasa berhasil diganti! Halaman akan dimuat ulang untuk menerapkan perubahan.');
        location.reload();
    } catch (e) {
        alert('Gagal mengubah bahasa: ' + e.message);
    }
});

// Language management functions
async function loadLanguageList() {
    try {
        const res = await fetch('/api/languages', { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load languages');
        languages = await res.json();
        renderLanguageList();
    } catch (error) {
        console.error('Failed to load language list:', error);
        const tbody = document.getElementById('languageTableBody');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">Gagal memuat bahasa</td></tr>`;
        }
    }
}

function renderLanguageList() {
    const tbody = document.getElementById('languageTableBody');
    if (!tbody) return;

    if (!languages || languages.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center">Tidak ada bahasa ditemukan</td></tr>`;
        return;
    }

    tbody.innerHTML = languages.map((lang, index) => `
        <tr>
            <td>${index + 1}</td>
            <td><code>${lang.code}</code></td>
            <td>${lang.name}</td>
            <td>${lang.flag || ''}</td>
            <td><span class="badge bg-${lang.active ? 'success' : 'secondary'}">${lang.active ? 'Aktif' : 'Tidak Aktif'}</span></td>
            <td>${Object.keys(lang.translations || {}).length}</td>
            <td>
                <button class="btn btn-sm btn-warning" onclick="openLanguageModal('${lang.id}')">Edit</button>
                ${lang.id !== 'id' ? `<button class="btn btn-sm btn-danger" onclick="deleteLanguage('${lang.id}')">Hapus</button>` : ''}
            </td>
        </tr>
    `).join('');
}

function openLanguageModal(languageId = null) {
    const modalEl = document.getElementById('languageModal');
    if (!modalEl) return;

    const modal = new bootstrap.Modal(modalEl);
    const form = document.getElementById('languageForm');
    const translationsContainer = document.getElementById('translationsContainer');

    // Reset form
    form.reset();
    translationsContainer.innerHTML = '';

    if (languageId) {
        // Edit mode
        const lang = languages.find(l => l.id === languageId);
        if (lang) {
            document.getElementById('languageId').value = lang.id;
            document.getElementById('languageCode').value = lang.code;
            document.getElementById('languageName').value = lang.name;
            document.getElementById('languageFlag').value = lang.flag || '';
            document.getElementById('languageActive').checked = lang.active;
            
            // Load translations
            renderTranslationFields(lang.translations || {});
        }
    } else {
        // Add mode - copy from default language
        const defaultLang = languages.find(l => l.code === 'id');
        if (defaultLang) {
            renderTranslationFields(defaultLang.translations || {});
        }
    }

    modal.show();
}

function renderTranslationFields(translations) {
    const container = document.getElementById('translationsContainer');
    if (!container) return;

    const fields = [];
    
    // Group translations by category
    const categories = {
        'nav': 'Navigasi',
        'buttons': 'Tombol',
        'messages': 'Pesan',
        'products': 'Produk',
        'cart': 'Keranjang',
        'transactions': 'Transaksi'
    };

    Object.keys(categories).forEach(category => {
        if (translations[category]) {
            fields.push(`
                <div class="card mb-3">
                    <div class="card-header">
                        <h6 class="mb-0">${categories[category]}</h6>
                    </div>
                    <div class="card-body">
            `);

            Object.keys(translations[category]).forEach(key => {
                const value = translations[category][key];
                fields.push(`
                    <div class="mb-2">
                        <label class="form-label small">${key}</label>
                        <input type="text" class="form-control form-control-sm" 
                               name="translation_${category}_${key}" 
                               value="${value || ''}" 
                               placeholder="Terjemahan...">
                    </div>
                `);
            });

            fields.push('</div></div>');
        }
    });

    container.innerHTML = fields.join('');
}

async function saveLanguage() {
    const languageId = document.getElementById('languageId').value;
    const code = document.getElementById('languageCode').value.trim();
    const name = document.getElementById('languageName').value.trim();
    const flag = document.getElementById('languageFlag').value.trim();
    const active = document.getElementById('languageActive').checked;

    if (!code || !name) {
        alert('Kode bahasa dan nama bahasa wajib diisi!');
        return;
    }

    // Collect translations
    const translations = {};
    const translationInputs = document.querySelectorAll('#translationsContainer input[name^="translation_"]');
    translationInputs.forEach(input => {
        const nameParts = input.name.split('_');
        if (nameParts.length >= 3) {
            const category = nameParts[1];
            const key = nameParts.slice(2).join('_');
            if (!translations[category]) translations[category] = {};
            translations[category][key] = input.value.trim();
        }
    });

    const data = { code, name, flag, active, translations };

    try {
        const url = languageId ? `/api/languages/${languageId}` : '/api/languages';
        const method = languageId ? 'PUT' : 'POST';

        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        const result = await res.json();
        if (!res.ok) throw new Error(result.message || 'Gagal menyimpan bahasa');

        alert(result.message);
        const modal = bootstrap.Modal.getInstance(document.getElementById('languageModal'));
        modal.hide();

        await loadLanguageList();

    } catch (error) {
        alert(`Gagal menyimpan bahasa: ${error.message}`);
    }
}

async function deleteLanguage(languageId) {
    if (languageId === 'id') {
        alert('Tidak dapat menghapus bahasa default!');
        return;
    }

    if (!confirm('Apakah Anda yakin ingin menghapus bahasa ini?')) return;

    try {
        const res = await fetch(`/api/languages/${languageId}`, { method: 'DELETE' });
        const result = await res.json();

        if (!res.ok) throw new Error(result.message || 'Gagal menghapus bahasa');

        alert(result.message);
        await loadLanguageList();

    } catch (error) {
        alert(`Gagal menghapus bahasa: ${error.message}`);
    }
}

// Language form submission
document.getElementById('saveLanguageBtn')?.addEventListener('click', saveLanguage);

// Add navigation handlers
document.addEventListener('click', (e) => {
    if (e.target.closest('a[data-view="languages"]')) {
        loadLanguageList();
    }
    if (e.target.closest('a[data-view="customers"]')) {
        loadCustomers();
        setupCustomerEventListeners();
    }
    if (e.target.closest('a[data-view="suppliers"]')) {
        // Muat semua data yang dibutuhkan untuk halaman Supplier & Barang Masuk
        loadSuppliers();
        loadStockInProducts();
        loadStockInHistory();
        initStockInView();
    }
    if (e.target.closest('a[data-view="credits"]')) {
        loadCredits();
    }
    if (e.target.closest('a[data-view="customer-debts"]')) {
        loadCustomerDebts();
    }
});

// --- Credits & Debt Management ---
let creditsData = [];
let creditsPagination = {
    currentPage: 1,
    pageSize: 10,
    totalItems: 0,
    totalPages: 0
};

async function loadCredits() {
    try {
        const tbody = document.getElementById('creditsTableBody');
        if (!tbody) return;

        tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted">Memuat data...</td></tr>';

        // Load stock-in data to calculate debts
        const stockInResponse = await fetch('/api/stock-in');
        const stockInData = await stockInResponse.json();
        
        if (!Array.isArray(stockInData)) {
            throw new Error('Invalid data format');
        }

        // Process stock-in data to extract debt information
        creditsData = stockInData
            .map(record => {
                // Calculate amounts if they don't exist
                let totalAmount = Number(record.totalAmount) || 0;
                let paidAmount = Number(record.paidAmount) || 0;
                let remainingAmount = Number(record.remainingAmount) || 0;
                
                // If totalAmount is not present, calculate from items
                if (!totalAmount && Array.isArray(record.items) && record.items.length > 0) {
                    totalAmount = record.items.reduce((sum, item) => {
                        const qty = Number(item.qty || 0) || 0;
                        const price = Number(item.purchasePrice || 0) || 0;
                        return sum + (qty * price);
                    }, 0);
                }
                
                // If remainingAmount is not present but we have totalAmount and paidAmount, calculate it
                if (!remainingAmount && totalAmount && paidAmount) {
                    remainingAmount = totalAmount - paidAmount;
                }
                
                // If paidAmount is 0 but totalAmount exists, set remainingAmount to totalAmount
                if (paidAmount === 0 && totalAmount > 0) {
                    remainingAmount = totalAmount;
                }
                
                // Calculate due date (30 days from stock-in date)
                const stockInDate = new Date(record.date);
                const dueDate = new Date(stockInDate);
                dueDate.setDate(dueDate.getDate() + 30);
                
                const isOverdue = new Date() > dueDate && remainingAmount > 0;
                
                return {
                    id: record.id,
                    supplierName: record.supplierName || 'Unknown',
                    date: record.date,
                    totalAmount,
                    paidAmount,
                    remainingAmount,
                    dueDate: dueDate.toISOString().split('T')[0],
                    isOverdue,
                    status: remainingAmount === 0 ? 'Lunas' : (paidAmount > 0 ? 'Bayar Sebagian' : 'Belum Bayar'),
                    note: record.note || ''
                };
            })
            .filter(record => record.totalAmount > 0) // Only show records with total amount (not empty records)
            .sort((a, b) => {
                // Sort by overdue status first, then by date
                if (a.isOverdue && !b.isOverdue) return -1;
                if (!a.isOverdue && b.isOverdue) return 1;
                return new Date(b.date) - new Date(a.date);
            });

        updateCreditSummary();
        renderCreditsTable();
        
    } catch (error) {
        console.error('Failed to load credits:', error);
        const tbody = document.getElementById('creditsTableBody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="10" class="text-center text-danger">Gagal memuat data</td></tr>';
        }
    }
}

function updateCreditSummary() {
    // Only calculate summary for records with actual debt (remainingAmount > 0)
    const debtRecords = creditsData.filter(credit => credit.remainingAmount > 0);
    const totalDebt = debtRecords.reduce((sum, credit) => sum + credit.remainingAmount, 0);
    const overdueDebt = debtRecords.filter(credit => credit.isOverdue).reduce((sum, credit) => sum + credit.remainingAmount, 0);
    const supplierCount = new Set(debtRecords.map(credit => credit.supplierName)).size;

    document.getElementById('totalDebt').textContent = formatCurrency(totalDebt);
    document.getElementById('overdueDebt').textContent = formatCurrency(overdueDebt);
    document.getElementById('supplierCount').textContent = supplierCount;
}

function renderCreditsTable() {
    const tbody = document.getElementById('creditsTableBody');
    if (!tbody) return;

    const pageSize = Number(document.getElementById('creditPageSizeSelect')?.value) || 10;
    const filter = document.getElementById('creditFilterSelect')?.value || 'all';
    const searchTerm = document.getElementById('creditSearchInput')?.value.toLowerCase() || '';

    // Filter data
    let filteredData = creditsData;
    
    if (filter !== 'all') {
        switch (filter) {
            case 'overdue':
                filteredData = filteredData.filter(credit => credit.isOverdue);
                break;
            case 'paid':
                filteredData = filteredData.filter(credit => credit.remainingAmount === 0);
                break;
            case 'partial':
                filteredData = filteredData.filter(credit => credit.paidAmount > 0 && credit.remainingAmount > 0);
                break;
        }
    }

    if (searchTerm) {
        filteredData = filteredData.filter(credit => 
            credit.supplierName.toLowerCase().includes(searchTerm) ||
            credit.id.toLowerCase().includes(searchTerm)
        );
    }

    // Pagination
    creditsPagination.totalItems = filteredData.length;
    creditsPagination.totalPages = pageSize === 'all' ? 1 : Math.ceil(filteredData.length / pageSize);
    creditsPagination.currentPage = 1; // Reset to first page when filtering

    const startIndex = pageSize === 'all' ? 0 : (creditsPagination.currentPage - 1) * pageSize;
    const endIndex = pageSize === 'all' ? filteredData.length : startIndex + pageSize;
    const paginatedData = filteredData.slice(startIndex, endIndex);

    // Render table rows
    const rows = paginatedData.map((credit, index) => {
        const statusClass = credit.isOverdue ? 'text-danger' : 
                           credit.remainingAmount === 0 ? 'text-success' : 'text-warning';
        const statusBadge = credit.isOverdue ? 'Jatuh Tempo' : credit.status;

        return `
            <tr>
                <td>${startIndex + index + 1}</td>
                <td>${credit.supplierName}</td>
                <td>${credit.id}</td>
                <td>${new Date(credit.date).toLocaleDateString('id-ID')}</td>
                <td class="text-end">${formatCurrency(credit.totalAmount)}</td>
                <td class="text-end">${formatCurrency(credit.paidAmount)}</td>
                <td class="text-end">${formatCurrency(credit.remainingAmount)}</td>
                <td>${new Date(credit.dueDate).toLocaleDateString('id-ID')}</td>
                <td><span class="badge ${statusClass}">${statusBadge}</span></td>
                <td>
                    <button class="btn btn-sm btn-success" onclick="makePayment('${credit.id}', ${credit.remainingAmount})" ${credit.remainingAmount === 0 ? 'disabled' : ''}>
                        Bayar
                    </button>
                    <button class="btn btn-sm btn-info" onclick="viewCreditDetails('${credit.id}')">
                        Detail
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    tbody.innerHTML = rows || '<tr><td colspan="10" class="text-center text-muted">Tidak ada data</td></tr>';

    // Update summary
    const summary = document.getElementById('creditsSummary');
    if (summary) {
        summary.textContent = `Menampilkan ${startIndex + 1}-${Math.min(endIndex, filteredData.length)} dari ${filteredData.length} data`;
    }

    // Render pagination
    renderCreditsPagination();
}

function renderCreditsPagination() {
    const pagination = document.getElementById('creditsPagination');
    if (!pagination || creditsPagination.totalPages <= 1) {
        pagination.innerHTML = '';
        return;
    }

    let paginationHtml = '<ul class="pagination">';
    
    // Previous button
    paginationHtml += `
        <li class="page-item ${creditsPagination.currentPage === 1 ? 'disabled' : ''}">
            <a class="page-link" href="#" onclick="changeCreditsPage(${creditsPagination.currentPage - 1}); return false;">Previous</a>
        </li>
    `;

    // Page numbers
    for (let i = 1; i <= creditsPagination.totalPages; i++) {
        paginationHtml += `
            <li class="page-item ${creditsPagination.currentPage === i ? 'active' : ''}">
                <a class="page-link" href="#" onclick="changeCreditsPage(${i}); return false;">${i}</a>
            </li>
        `;
    }

    // Next button
    paginationHtml += `
        <li class="page-item ${creditsPagination.currentPage === creditsPagination.totalPages ? 'disabled' : ''}">
            <a class="page-link" href="#" onclick="changeCreditsPage(${creditsPagination.currentPage + 1}); return false;">Next</a>
        </li>
    `;

    paginationHtml += '</ul>';
    pagination.innerHTML = paginationHtml;
}

function changeCreditsPage(page) {
    if (page < 1 || page > creditsPagination.totalPages) return;
    
    creditsPagination.currentPage = page;
    renderCreditsTable();
}

function makePayment(creditId, remainingAmount) {
    // Create payment modal
    const modalHtml = `
        <div class="modal fade" id="paymentModal" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Pembayaran Hutang</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="mb-3">
                            <label class="form-label">ID Transaksi</label>
                            <input type="text" class="form-control" value="${creditId}" readonly>
                        </div>
                        <div class="mb-3">
                            <label class="form-label">Jumlah Pembayaran</label>
                            <input type="number" class="form-control" id="paymentAmount" value="${remainingAmount}" min="1" max="${remainingAmount}">
                        </div>
                        <div class="mb-3">
                            <label class="form-label">Tanggal Pembayaran</label>
                            <input type="date" class="form-control" id="paymentDate" value="${new Date().toISOString().split('T')[0]}">
                        </div>
                        <div class="mb-3">
                            <label class="form-label">Catatan</label>
                            <textarea class="form-control" id="paymentNote" placeholder="Catatan pembayaran..."></textarea>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Batal</button>
                        <button type="button" class="btn btn-success" onclick="savePayment('${creditId}')">Bayar</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Remove existing modal if present
    const existingModal = document.getElementById('paymentModal');
    if (existingModal) existingModal.remove();

    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('paymentModal'));
    modal.show();
}

async function savePayment(creditId) {
    try {
        const paymentAmount = Number(document.getElementById('paymentAmount').value) || 0;
        const paymentDate = document.getElementById('paymentDate').value;
        const paymentNote = document.getElementById('paymentNote').value;

        if (paymentAmount <= 0) {
            alert('Jumlah pembayaran harus lebih dari 0');
            return;
        }

        // Find the credit record
        const credit = creditsData.find(c => c.id === creditId);
        if (!credit) {
            alert('Data hutang tidak ditemukan');
            return;
        }

        // Calculate new amounts
        const newPaidAmount = credit.paidAmount + paymentAmount;
        const newRemainingAmount = Math.max(0, credit.remainingAmount - paymentAmount);

        // Update the stock-in record
        await ensureCsrfTokenReady();
        const token = (window.csrfToken || '');

        const response = await fetch(`/api/stock-in/${creditId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': token,
                'x-xsrf-token': token
            },
            credentials: 'include',
            body: JSON.stringify({
                paidAmount: newPaidAmount,
                remainingAmount: newRemainingAmount,
                paymentDate: paymentDate,
                _csrf: token
            })
        });

        if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            throw new Error(result.message || 'Gagal memproses pembayaran');
        }

        // Close modal
        const modal = bootstrap.Modal.getInstance(document.getElementById('paymentModal'));
        modal.hide();

        // Refresh data
        await loadCredits();

        alert('Pembayaran berhasil diproses');
    } catch (error) {
        console.error('Failed to save payment:', error);
        alert('Gagal memproses pembayaran: ' + (error.message || error));
    }
}

function viewCreditDetails(creditId) {
    const credit = creditsData.find(c => c.id === creditId);
    if (!credit) return;

    const modalHtml = `
        <div class="modal fade" id="creditDetailsModal" tabindex="-1">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Detail Hutang</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="row mb-3">
                            <div class="col-md-6">
                                <strong>ID Transaksi:</strong> ${credit.id}
                            </div>
                            <div class="col-md-6">
                                <strong>Supplier:</strong> ${credit.supplierName}
                            </div>
                        </div>
                        <div class="row mb-3">
                            <div class="col-md-6">
                                <strong>Tanggal:</strong> ${new Date(credit.date).toLocaleDateString('id-ID')}
                            </div>
                            <div class="col-md-6">
                                <strong>Jatuh Tempo:</strong> ${new Date(credit.dueDate).toLocaleDateString('id-ID')}
                            </div>
                        </div>
                        <div class="row mb-3">
                            <div class="col-md-12">
                                <strong>Status:</strong> <span class="badge ${credit.isOverdue ? 'bg-danger' : 'bg-warning'}">${credit.isOverdue ? 'Jatuh Tempo' : credit.status}</span>
                            </div>
                        </div>
                        <div class="row mb-3">
                            <div class="col-md-4">
                                <strong>Total Tagihan:</strong> ${formatCurrency(credit.totalAmount)}
                            </div>
                            <div class="col-md-4">
                                <strong>Dibayar:</strong> ${formatCurrency(credit.paidAmount)}
                            </div>
                            <div class="col-md-4">
                                <strong>Sisa:</strong> ${formatCurrency(credit.remainingAmount)}
                            </div>
                        </div>
                        ${credit.note ? `<div class="row mb-3"><div class="col-md-12"><strong>Catatan:</strong> ${credit.note}</div></div>` : ''}
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Tutup</button>
                        <button type="button" class="btn btn-success" onclick="makePayment('${credit.id}', ${credit.remainingAmount})" ${credit.remainingAmount === 0 ? 'disabled' : ''}>
                            Bayar
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Remove existing modal if present
    const existingModal = document.getElementById('creditDetailsModal');
    if (existingModal) existingModal.remove();

    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('creditDetailsModal'));
    modal.show();
}

// Event listeners for credits page
document.addEventListener('click', (e) => {
    if (e.target.closest('#addPaymentBtn')) {
        // For now, redirect to credits view (could be enhanced later)
        loadCredits();
    }
    
    if (e.target.closest('#refreshCreditsBtn')) {
        loadCredits();
    }
});

document.addEventListener('change', (e) => {
    if (e.target.closest('#creditPageSizeSelect') || e.target.closest('#creditFilterSelect')) {
        renderCreditsTable();
    }
});

document.addEventListener('input', (e) => {
    if (e.target.closest('#creditSearchInput')) {
        renderCreditsTable();
    }
});

document.addEventListener('click', (e) => {
    if (e.target.closest('#clearCreditSearchBtn')) {
        const searchInput = document.getElementById('creditSearchInput');
        if (searchInput) {
            searchInput.value = '';
            renderCreditsTable();
        }
    }
});

// --- Customer Debts Management ---
let customerDebtsData = [];
let customerDebtsPagination = {
    currentPage: 1,
    pageSize: 10,
    totalItems: 0,
    totalPages: 0
};

async function loadCustomerDebts() {
    try {
        const tbody = document.getElementById('customerDebtsTableBody');
        if (!tbody) return;

        tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted">Memuat data...</td></tr>';

        // Load transactions data to calculate customer debts
        const transactionsResponse = await fetch('/api/transactions');
        const transactionsData = await transactionsResponse.json();
        
        if (!Array.isArray(transactionsData)) {
            throw new Error('Invalid data format');
        }

        // Process transactions data to extract customer debt information
        // Utamakan transaksi yang punya field hutang eksplisit,
        // tapi juga dukung transaksi lama/implisit (kembalian negatif)
        customerDebtsData = transactionsData
            .map(record => {
                const hasExplicitDebt = record.paidAmount != null || record.remainingAmount != null;
                const isImplicitPartialCash = !hasExplicitDebt
                    && record.paymentMethod === 'cash'
                    && record.customerId && record.customerId !== 'default'
                    && Number(record.change || 0) < 0;

                // Jika bukan hutang eksplisit maupun implisit, abaikan (transaksi biasa/lunas)
                if (!hasExplicitDebt && !isImplicitPartialCash) {
                    return null;
                }

                let totalAmount = Number(record.totalAmount) || 0;
                let paidAmount = Number(record.paidAmount) || 0;
                let remainingAmount = Number(record.remainingAmount) || 0;

                // Hutang implisit (pembayaran parsial dengan kembalian negatif)
                if (isImplicitPartialCash) {
                    const amountReceived = Number(record.amountReceived || 0) || 0;
                    paidAmount = amountReceived;
                    remainingAmount = Math.max(0, totalAmount - paidAmount);
                }

                // Jika hanya paidAmount yang ada, hitung sisa dari total
                if (!isImplicitPartialCash && remainingAmount === 0 && totalAmount && paidAmount && paidAmount < totalAmount) {
                    remainingAmount = totalAmount - paidAmount;
                }

                // Calculate due date (7 days from transaction date for customer debts)
                // Handle invalid dates safely
                let transactionDate;
                try {
                    transactionDate = new Date(record.date || record.timestamp);
                    if (isNaN(transactionDate.getTime())) {
                        transactionDate = new Date(); // Fallback to current date
                    }
                } catch (e) {
                    transactionDate = new Date(); // Fallback to current date
                }

                const dueDate = new Date(transactionDate);
                dueDate.setDate(dueDate.getDate() + 7);

                const isOverdue = new Date() > dueDate && remainingAmount > 0;

                return {
                    id: record.id,
                    customerName: record.customerName || 'Unknown',
                    date: record.date || (record.timestamp ? new Date(record.timestamp).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]),
                    totalAmount,
                    paidAmount,
                    remainingAmount,
                    dueDate: dueDate.toISOString().split('T')[0],
                    isOverdue,
                    status: remainingAmount === 0 ? 'Lunas' : (paidAmount > 0 ? 'Hutang (Bayar Sebagian)' : 'Belum Bayar'),
                    note: record.note || ''
                };
            })
            .filter(record => record && record.totalAmount > 0) // Hanya record hutang yang valid
            .sort((a, b) => {
                // Sort by overdue status first, then by date
                if (a.isOverdue && !b.isOverdue) return -1;
                if (!a.isOverdue && b.isOverdue) return 1;
                return new Date(b.date) - new Date(a.date);
            });

        updateCustomerDebtSummary();
        renderCustomerDebtsTable();
        
    } catch (error) {
        console.error('Failed to load customer debts:', error);
        const tbody = document.getElementById('customerDebtsTableBody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="10" class="text-center text-danger">Gagal memuat data</td></tr>';
        }
    }
}

function updateCustomerDebtSummary() {
    // Only calculate summary for records with actual debt (remainingAmount > 0)
    const debtRecords = customerDebtsData.filter(debt => debt.remainingAmount > 0);
    const totalDebt = debtRecords.reduce((sum, debt) => sum + debt.remainingAmount, 0);
    const overdueDebt = debtRecords.filter(debt => debt.isOverdue).reduce((sum, debt) => sum + debt.remainingAmount, 0);
    const customerCount = new Set(debtRecords.map(debt => debt.customerName)).size;

    document.getElementById('totalCustomerDebt').textContent = formatCurrency(totalDebt);
    document.getElementById('overdueCustomerDebt').textContent = formatCurrency(overdueDebt);
    document.getElementById('customerDebtCount').textContent = customerCount;
}

function renderCustomerDebtsTable() {
    const tbody = document.getElementById('customerDebtsTableBody');
    if (!tbody) return;

    const pageSize = Number(document.getElementById('customerDebtPageSizeSelect')?.value) || 10;
    const filter = document.getElementById('customerDebtFilterSelect')?.value || 'all';
    const searchTerm = document.getElementById('customerDebtSearchInput')?.value.toLowerCase() || '';

    // Filter data
    let filteredData = customerDebtsData;
    
    if (filter !== 'all') {
        switch (filter) {
            case 'overdue':
                filteredData = filteredData.filter(debt => debt.isOverdue);
                break;
            case 'paid':
                filteredData = filteredData.filter(debt => debt.remainingAmount === 0);
                break;
            case 'partial':
                filteredData = filteredData.filter(debt => debt.paidAmount > 0 && debt.remainingAmount > 0);
                break;
        }
    }

    if (searchTerm) {
        filteredData = filteredData.filter(debt => 
            debt.customerName.toLowerCase().includes(searchTerm) ||
            debt.id.toLowerCase().includes(searchTerm)
        );
    }

    // Pagination
    customerDebtsPagination.totalItems = filteredData.length;
    customerDebtsPagination.totalPages = pageSize === 'all' ? 1 : Math.ceil(filteredData.length / pageSize);
    customerDebtsPagination.currentPage = 1; // Reset to first page when filtering

    const startIndex = pageSize === 'all' ? 0 : (customerDebtsPagination.currentPage - 1) * pageSize;
    const endIndex = pageSize === 'all' ? filteredData.length : startIndex + pageSize;
    const paginatedData = filteredData.slice(startIndex, endIndex);

    // Render table rows
    const rows = paginatedData.map((debt, index) => {
        const statusClass = debt.isOverdue ? 'text-danger' : 
                           debt.remainingAmount === 0 ? 'text-success' : 'text-warning';
        const statusBadge = debt.isOverdue ? 'Jatuh Tempo' : debt.status;

        // Safe date formatting
        let formattedDate = '';
        let formattedDueDate = '';
        try {
            formattedDate = new Date(debt.date).toLocaleDateString('id-ID');
        } catch (e) {
            formattedDate = debt.date || '-';
        }
        try {
            formattedDueDate = new Date(debt.dueDate).toLocaleDateString('id-ID');
        } catch (e) {
            formattedDueDate = debt.dueDate || '-';
        }

        return `
            <tr>
                <td>${startIndex + index + 1}</td>
                <td>${debt.customerName}</td>
                <td>${debt.id}</td>
                <td>${formattedDate}</td>
                <td class="text-end">${formatCurrency(debt.totalAmount)}</td>
                <td class="text-end">${formatCurrency(debt.paidAmount)}</td>
                <td class="text-end">${formatCurrency(debt.remainingAmount)}</td>
                <td>${formattedDueDate}</td>
                <td><span class="badge ${statusClass}">${statusBadge}</span></td>
                <td>
                    <button class="btn btn-sm btn-success" onclick="makeCustomerPayment('${debt.id}', ${debt.remainingAmount})" ${debt.remainingAmount === 0 ? 'disabled' : ''}>
                        Bayar
                    </button>
                    <button class="btn btn-sm btn-info" onclick="viewCustomerDebtDetails('${debt.id}')">
                        Detail
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    tbody.innerHTML = rows || '<tr><td colspan="10" class="text-center text-muted">Tidak ada data</td></tr>';

    // Update summary
    const summary = document.getElementById('customerDebtsSummary');
    if (summary) {
        summary.textContent = `Menampilkan ${startIndex + 1}-${Math.min(endIndex, filteredData.length)} dari ${filteredData.length} data`;
    }

    // Render pagination
    renderCustomerDebtsPagination();
}

function renderCustomerDebtsPagination() {
    const pagination = document.getElementById('customerDebtsPagination');
    if (!pagination || customerDebtsPagination.totalPages <= 1) {
        pagination.innerHTML = '';
        return;
    }

    let paginationHtml = '<ul class="pagination">';
    
    // Previous button
    paginationHtml += `
        <li class="page-item ${customerDebtsPagination.currentPage === 1 ? 'disabled' : ''}">
            <a class="page-link" href="#" onclick="changeCustomerDebtsPage(${customerDebtsPagination.currentPage - 1}); return false;">Previous</a>
        </li>
    `;

    // Page numbers
    for (let i = 1; i <= customerDebtsPagination.totalPages; i++) {
        paginationHtml += `
            <li class="page-item ${customerDebtsPagination.currentPage === i ? 'active' : ''}">
                <a class="page-link" href="#" onclick="changeCustomerDebtsPage(${i}); return false;">${i}</a>
            </li>
        `;
    }

    // Next button
    paginationHtml += `
        <li class="page-item ${customerDebtsPagination.currentPage === customerDebtsPagination.totalPages ? 'disabled' : ''}">
            <a class="page-link" href="#" onclick="changeCustomerDebtsPage(${customerDebtsPagination.currentPage + 1}); return false;">Next</a>
        </li>
    `;

    paginationHtml += '</ul>';
    pagination.innerHTML = paginationHtml;
}

function changeCustomerDebtsPage(page) {
    if (page < 1 || page > customerDebtsPagination.totalPages) return;
    
    customerDebtsPagination.currentPage = page;
    renderCustomerDebtsTable();
}

function makeCustomerPayment(debtId, remainingAmount) {
    // Create payment modal
    const modalHtml = `
        <div class="modal fade" id="customerPaymentModal" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Pembayaran Piutang Customer</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="mb-3">
                            <label class="form-label">ID Transaksi</label>
                            <input type="text" class="form-control" value="${debtId}" readonly>
                        </div>
                        <div class="mb-3">
                            <label class="form-label">Jumlah Pembayaran</label>
                            <input type="number" class="form-control" id="customerPaymentAmount" value="${remainingAmount}" min="1" max="${remainingAmount}">
                        </div>
                        <div class="mb-3">
                            <label class="form-label">Tanggal Pembayaran</label>
                            <input type="date" class="form-control" id="customerPaymentDate" value="${new Date().toISOString().split('T')[0]}">
                        </div>
                        <div class="mb-3">
                            <label class="form-label">Catatan</label>
                            <textarea class="form-control" id="customerPaymentNote" placeholder="Catatan pembayaran..."></textarea>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Batal</button>
                        <button type="button" class="btn btn-success" onclick="saveCustomerPayment('${debtId}')">Bayar</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Remove existing modal if present
    const existingModal = document.getElementById('customerPaymentModal');
    if (existingModal) existingModal.remove();

    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('customerPaymentModal'));
    modal.show();
}

async function saveCustomerPayment(debtId) {
    try {
        const paymentAmount = Number(document.getElementById('customerPaymentAmount').value) || 0;
        const paymentDate = document.getElementById('customerPaymentDate').value;
        const paymentNote = document.getElementById('customerPaymentNote').value;

        if (paymentAmount <= 0) {
            alert('Jumlah pembayaran harus lebih dari 0');
            return;
        }

        // Find the debt record
        const debt = customerDebtsData.find(d => d.id === debtId);
        if (!debt) {
            alert('Data piutang tidak ditemukan');
            return;
        }

        // Calculate new amounts
        const newPaidAmount = debt.paidAmount + paymentAmount;
        const newRemainingAmount = Math.max(0, debt.remainingAmount - paymentAmount);

        // Update the transaction record
        await ensureCsrfTokenReady();
        const token = (window.csrfToken || '');

        const response = await fetch(`/api/transactions/${debtId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': token,
                'x-xsrf-token': token
            },
            credentials: 'include',
            body: JSON.stringify({
                paidAmount: newPaidAmount,
                remainingAmount: newRemainingAmount,
                paymentDate: paymentDate,
                _csrf: token
            })
        });

        if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            throw new Error(result.message || 'Gagal memproses pembayaran');
        }

        // Close modal
        const modal = bootstrap.Modal.getInstance(document.getElementById('customerPaymentModal'));
        modal.hide();

        // Refresh data
        await loadCustomerDebts();

        alert('Pembayaran berhasil diproses');
    } catch (error) {
        console.error('Failed to save customer payment:', error);
        alert('Gagal memproses pembayaran: ' + (error.message || error));
    }
}

function viewCustomerDebtDetails(debtId) {
    const debt = customerDebtsData.find(d => d.id === debtId);
    if (!debt) return;

    // Safe date formatting
    let formattedDate = '';
    let formattedDueDate = '';
    try {
        formattedDate = new Date(debt.date).toLocaleDateString('id-ID');
    } catch (e) {
        formattedDate = debt.date || '-';
    }
    try {
        formattedDueDate = new Date(debt.dueDate).toLocaleDateString('id-ID');
    } catch (e) {
        formattedDueDate = debt.dueDate || '-';
    }

    const modalHtml = `
        <div class="modal fade" id="customerDebtDetailsModal" tabindex="-1">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Detail Piutang Customer</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="row mb-3">
                            <div class="col-md-6">
                                <strong>ID Transaksi:</strong> ${debt.id}
                            </div>
                            <div class="col-md-6">
                                <strong>Customer:</strong> ${debt.customerName}
                            </div>
                        </div>
                        <div class="row mb-3">
                            <div class="col-md-6">
                                <strong>Tanggal:</strong> ${formattedDate}
                            </div>
                            <div class="col-md-6">
                                <strong>Jatuh Tempo:</strong> ${formattedDueDate}
                            </div>
                        </div>
                        <div class="row mb-3">
                            <div class="col-md-12">
                                <strong>Status:</strong> <span class="badge ${debt.isOverdue ? 'bg-danger' : 'bg-warning'}">${debt.isOverdue ? 'Jatuh Tempo' : debt.status}</span>
                            </div>
                        </div>
                        <div class="row mb-3">
                            <div class="col-md-4">
                                <strong>Total Tagihan:</strong> ${formatCurrency(debt.totalAmount)}
                            </div>
                            <div class="col-md-4">
                                <strong>Dibayar:</strong> ${formatCurrency(debt.paidAmount)}
                            </div>
                            <div class="col-md-4">
                                <strong>Sisa:</strong> ${formatCurrency(debt.remainingAmount)}
                            </div>
                        </div>
                        ${debt.note ? `<div class="row mb-3"><div class="col-md-12"><strong>Catatan:</strong> ${debt.note}</div></div>` : ''}
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Tutup</button>
                        <button type="button" class="btn btn-success" onclick="makeCustomerPayment('${debt.id}', ${debt.remainingAmount})" ${debt.remainingAmount === 0 ? 'disabled' : ''}>
                            Bayar
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Remove existing modal if present
    const existingModal = document.getElementById('customerDebtDetailsModal');
    if (existingModal) existingModal.remove();

    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('customerDebtDetailsModal'));
    modal.show();
}

// Event listeners for customer debts page
document.addEventListener('click', (e) => {
    if (e.target.closest('#addCustomerPaymentBtn')) {
        // For now, redirect to customer debts view (could be enhanced later)
        loadCustomerDebts();
    }
    
    if (e.target.closest('#refreshCustomerDebtsBtn')) {
        loadCustomerDebts();
    }
});

document.addEventListener('change', (e) => {
    if (e.target.closest('#customerDebtPageSizeSelect') || e.target.closest('#customerDebtFilterSelect')) {
        renderCustomerDebtsTable();
    }
});

document.addEventListener('input', (e) => {
    if (e.target.closest('#customerDebtSearchInput')) {
        renderCustomerDebtsTable();
    }
});

document.addEventListener('click', (e) => {
    if (e.target.closest('#clearCustomerDebtSearchBtn')) {
        const searchInput = document.getElementById('customerDebtSearchInput');
        if (searchInput) {
            searchInput.value = '';
            renderCustomerDebtsTable();
        }
    }
});

// Event listener untuk tombol hapus semua database
document.addEventListener('click', async (e) => {
    if (e.target.closest('#deleteAllDatabaseBtn')) {
        e.preventDefault();
        
        // Konfirmasi pertama
        if (!confirm('PERINGATAN EXTREME!\n\nAnda akan menghapus SEMUA data aplikasi termasuk:\n• Semua produk dan kategori\n• Semua transaksi dan pembayaran\n• Semua pelanggan dan supplier\n• Semua pengguna (kecuali admin yang sedang login)\n• Semua pengaturan dan backup\n\nTINDAKAN INI TIDAK BISA DIURUNGGI!\n\nLanjutkan?')) {
            return;
        }
        
        // Konfirmasi kedua dengan kata kunci
        const keyword = 'DELETE_ALL_DATABASE_PERMANENTLY';
        const input = prompt(`Konfirmasi dengan mengetik: ${keyword}`);
        if (!input || input.trim() !== keyword) {
            alert('Konfirmasi tidak cocok! Operasi dibatalkan.');
            return;
        }
        
        // Konfirmasi ketiga
        if (!confirm('KONFIRMASI AKHIR:\n\nSemua data akan PERMANEN dihapus dan tidak bisa dikembalikan.\n\nApakah Anda YAKIN 100%?')) {
            return;
        }
        
        try {
            const btn = document.getElementById('deleteAllDatabaseBtn');
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Menghapus...';
            }
            
            const response = await fetch('/api/database/delete-all', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    confirm: keyword
                })
            });
            
            const result = await response.json();
            
            if (response.ok && result.success) {
                alert('Semua database berhasil dihapus! Aplikasi akan dimuat ulang...');
                // Reload halaman setelah 2 detik
                setTimeout(() => {
                    window.location.reload();
                }, 2000);
            } else {
                throw new Error(result.message || 'Gagal menghapus database');
            }
        } catch (error) {
            console.error('Error deleting database:', error);
            alert('Gagal menghapus database: ' + error.message);
        } finally {
            const btn = document.getElementById('deleteAllDatabaseBtn');
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-trash-fill"></i> Hapus Semua Database';
            }
        }
    }
});

// Load app version
async function loadAppVersion() {
  try {
    const response = await fetch('/api/app-version');
    const result = await response.json();
    if (result.success) {
      const versionElement = document.getElementById('appVersion');
      if (versionElement) {
        versionElement.textContent = `v${result.version}`;
      }
    }
  } catch (error) {
    console.error('Error loading app version:', error);
  }
}

// Event listener untuk tombol cek update
document.addEventListener('click', async (e) => {
    if (e.target.closest('#checkUpdateBtn')) {
        e.preventDefault();
        await checkForUpdate();
    }
});

// Fungsi untuk mengecek update aplikasi
async function checkForUpdate() {
    const modal = new bootstrap.Modal(document.getElementById('updateCheckModal'));
    const content = document.getElementById('updateCheckContent');
    const downloadBtn = document.getElementById('downloadUpdateBtn');
    
    // Tampilkan modal dengan loading
    content.innerHTML = `
        <div class="text-center">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Memeriksa update...</span>
            </div>
            <p class="mt-3">Sedang memeriksa update aplikasi...</p>
        </div>
    `;
    
    if (downloadBtn) {
        downloadBtn.classList.add('d-none');
    }
    
    modal.show();
    
    try {
        const response = await fetch('/api/check-update');
        const result = await response.json();
        
        if (!result.success) {
            throw new Error(result.message || 'Gagal memeriksa update');
        }
        
        let updateHtml = '';
        
        if (result.hasUpdate) {
            updateHtml = `
                <div class="alert alert-info">
                    <h6><i class="bi bi-info-circle"></i> Update Tersedia!</h6>
                    <p class="mb-2">Versi terbaru: <strong>${result.latestVersion}</strong></p>
                    <p class="mb-2">Versi saat ini: <strong>${result.currentVersion}</strong></p>
                    <p class="mb-0">Update tersedia. Silakan download versi terbaru.</p>
                </div>
                <div class="card">
                    <div class="card-body">
                        <h6 class="card-title">${result.releaseInfo.name}</h6>
                        <p class="card-text small text-muted">Dirilis: ${new Date(result.releaseInfo.publishedAt).toLocaleDateString('id-ID')}</p>
                        <div class="mb-3">
                            <strong>Catatan Rilis:</strong>
                            <div class="mt-2 small" style="max-height: 200px; overflow-y: auto;">
                                ${result.releaseInfo.releaseNotes || 'Tidak ada catatan rilis.'}
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            if (downloadBtn) {
                downloadBtn.classList.remove('d-none');
                downloadBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Hot-Reload (No Restart)';
                downloadBtn.onclick = async () => {
                    if (confirm(`Hot-Reload ke versi ${result.latestVersion}?\n\nAplikasi akan:\n1. Download source code terbaru\n2. Update files langsung\n3. TANPA RESTART aplikasi\n\nServer tetap berjalan normal!`)) {
                        await performHotReload();
                    }
                };
                
                // Add restart update button
                const restartBtn = document.createElement('button');
                restartBtn.className = 'btn btn-warning ms-2';
                restartBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Update + Restart';
                restartBtn.onclick = async () => {
                    if (confirm(`Update dengan restart ke versi ${result.latestVersion}?\n\nAplikasi akan:\n1. Download update terbaru\n2. Stop aplikasi\n3. Replace files\n4. Restart otomatis\n\nProses akan memakan waktu beberapa menit.`)) {
                        await performRestartUpdate();
                    }
                };
                
                downloadBtn.parentNode.appendChild(restartBtn);
            }
        } else {
            updateHtml = `
                <div class="alert alert-success">
                    <h6><i class="bi bi-check-circle"></i> Aplikasi Terbaru!</h6>
                    <p class="mb-2">Versi saat ini: <strong>${result.currentVersion}</strong></p>
                    <p class="mb-0">${result.message || 'Anda menggunakan versi terbaru.'}</p>
                </div>
            `;
        }
        
        content.innerHTML = updateHtml;
        
    } catch (error) {
        console.error('Error checking update:', error);
        content.innerHTML = `
            <div class="alert alert-danger">
                <h6><i class="bi bi-exclamation-triangle"></i> Error</h6>
                <p class="mb-0">Gagal memeriksa update: ${error.message}</p>
            </div>
        `;
    }
}

// Fungsi untuk melakukan hot-reload update
async function performHotReload() {
    const content = document.getElementById('updateCheckContent');
    const downloadBtn = document.getElementById('downloadUpdateBtn');
    
    // Show progress
    content.innerHTML = `
        <div class="text-center">
            <div class="spinner-border text-success" role="status">
                <span class="visually-hidden">Hot-Reloading...</span>
            </div>
            <p class="mt-3">Memulai hot-reload update...</p>
            <div class="progress mt-3">
                <div class="progress-bar bg-success progress-bar-striped progress-bar-animated" role="progressbar" style="width: 0%" id="updateProgress">0%</div>
            </div>
        </div>
    `;
    
    if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Hot-Reloading...';
    }
    
    try {
        const updateProgress = (percent) => {
            const progressBar = document.getElementById('updateProgress');
            if (progressBar) {
                progressBar.style.width = percent + '%';
                progressBar.textContent = percent + '%';
            }
        };
        
        updateProgress(10);
        
        const response = await fetch('/api/auto-update', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        updateProgress(50);
        
        const result = await response.json();
        
        if (result.success) {
            updateProgress(100);
            content.innerHTML = `
                <div class="alert alert-success">
                    <h6><i class="bi bi-check-circle"></i> Hot-Reload Berhasil!</h6>
                    <p class="mb-2">Versi: ${result.currentVersion} → ${result.latestVersion}</p>
                    <p class="mb-0">${result.message}</p>
                </div>
                <div class="text-center mt-3">
                    <i class="bi bi-check-circle text-success" style="font-size: 3rem;"></i>
                    <p class="mt-3">Aplikasi berhasil diupdate tanpa restart!</p>
                    <button class="btn btn-primary mt-2" onclick="window.location.reload()">
                        <i class="bi bi-arrow-clockwise"></i> Refresh Halaman
                    </button>
                </div>
            `;
        } else if (result.isCodeSandbox) {
            // CodeSandbox environment detected
            content.innerHTML = `
                <div class="alert alert-warning">
                    <h6><i class="bi bi-exclamation-triangle"></i> CodeSandbox Environment</h6>
                    <p class="mb-2">${result.message}</p>
                    <p class="mb-0">Auto-update tidak tersedia di CodeSandbox.</p>
                </div>
                <div class="text-center mt-3">
                    <i class="bi bi-cloud text-warning" style="font-size: 3rem;"></i>
                    <p class="mt-3">Update manual diperlukan</p>
                    <button class="btn btn-primary mt-2" onclick="window.open('${result.manualUpdateUrl}', '_blank')">
                        <i class="bi bi-github"></i> Download dari GitHub
                    </button>
                    <div class="mt-3">
                        <small class="text-muted">
                            Untuk auto-update penuh, deploy ke server lokal atau VPS.
                        </small>
                    </div>
                </div>
            `;
        } else {
            throw new Error(result.message || 'Hot-reload failed');
        }
        
    } catch (error) {
        console.error('Hot-reload error:', error);
        content.innerHTML = `
            <div class="alert alert-danger">
                <h6><i class="bi bi-exclamation-triangle"></i> Hot-Reload Gagal</h6>
                <p class="mb-0">Hot-reload gagal: ${error.message}</p>
                <hr>
                <p class="mb-2">Alternatif:</p>
                <button class="btn btn-outline-warning" onclick="performRestartUpdate()">
                    <i class="bi bi-arrow-repeat"></i> Coba Update + Restart
                </button>
            </div>
        `;
        
        if (downloadBtn) {
            downloadBtn.disabled = false;
            downloadBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Hot-Reload (No Restart)';
        }
    }
}

// Fungsi untuk melakukan restart update
async function performRestartUpdate() {
    const content = document.getElementById('updateCheckContent');
    const downloadBtn = document.getElementById('downloadUpdateBtn');
    
    // Show progress
    content.innerHTML = `
        <div class="text-center">
            <div class="spinner-border text-warning" role="status">
                <span class="visually-hidden">Updating...</span>
            </div>
            <p class="mt-3">Memulai update dengan restart...</p>
            <div class="progress mt-3">
                <div class="progress-bar bg-warning progress-bar-striped progress-bar-animated" role="progressbar" style="width: 0%" id="updateProgress">0%</div>
            </div>
        </div>
    `;
    
    if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Updating...';
    }
    
    try {
        const updateProgress = (percent) => {
            const progressBar = document.getElementById('updateProgress');
            if (progressBar) {
                progressBar.style.width = percent + '%';
                progressBar.textContent = percent + '%';
            }
        };
        
        updateProgress(10);
        
        const response = await fetch('/api/auto-update-restart', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        updateProgress(30);
        
        const result = await response.json();
        
        if (result.success) {
            updateProgress(100);
            content.innerHTML = `
                <div class="alert alert-success">
                    <h6><i class="bi bi-check-circle"></i> Update Dimulai!</h6>
                    <p class="mb-2">Versi: ${result.currentVersion} → ${result.latestVersion}</p>
                    <p class="mb-0">${result.message}</p>
                </div>
                <div class="text-center mt-3">
                    <div class="spinner-border text-success" role="status">
                        <span class="visually-hidden">Aplikasi akan restart...</span>
                    </div>
                    <p class="mt-3">Aplikasi akan restart otomatis dalam beberapa detik...</p>
                    <p class="text-muted small">Jangan tutup browser ini sampai aplikasi restart.</p>
                </div>
            `;
            
            // Check if application restarted
            let restartAttempts = 0;
            const maxAttempts = 30;
            
            const checkRestart = setInterval(async () => {
                restartAttempts++;
                updateProgress(100);
                
                try {
                    const healthResponse = await fetch('/api/settings', { 
                        method: 'HEAD',
                        cache: 'no-store',
                        timeout: 2000
                    });
                    
                    if (healthResponse.ok) {
                        clearInterval(checkRestart);
                        content.innerHTML = `
                            <div class="alert alert-success">
                                <h6><i class="bi bi-check-circle"></i> Update Berhasil!</h6>
                                <p class="mb-0">Aplikasi berhasil diupdate dan restart.</p>
                            </div>
                        `;
                        
                        setTimeout(() => {
                            window.location.reload();
                        }, 2000);
                    }
                } catch (e) {
                    if (restartAttempts >= maxAttempts) {
                        clearInterval(checkRestart);
                        content.innerHTML = `
                            <div class="alert alert-warning">
                                <h6><i class="bi bi-exclamation-triangle"></i> Restart Timeout</h6>
                                <p class="mb-0">Update mungkin berhasil, tapi aplikasi tidak merespond. Silakan refresh browser secara manual.</p>
                            </div>
                        `;
                    }
                }
            }, 1000);
            
        } else {
            throw new Error(result.message || 'Restart update failed');
        }
        
    } catch (error) {
        console.error('Restart update error:', error);
        content.innerHTML = `
            <div class="alert alert-danger">
                <h6><i class="bi bi-exclamation-triangle"></i> Update Gagal</h6>
                <p class="mb-0">Update gagal: ${error.message}</p>
                <hr>
                <p class="mb-2">Alternatif:</p>
                <button class="btn btn-outline-primary" onclick="window.open('https://github.com/MrSoe94/pospremium/releases', '_blank')">
                    <i class="bi bi-download"></i> Download Manual
                </button>
            </div>
        `;
        
        if (downloadBtn) {
            downloadBtn.disabled = false;
            downloadBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Hot-Reload (No Restart)';
        }
    }
}

// Fungsi untuk melakukan auto-update (deprecated - kept for compatibility)
async function performAutoUpdate() {
    const content = document.getElementById('updateCheckContent');
    const downloadBtn = document.getElementById('downloadUpdateBtn');
    
    // Show progress
    content.innerHTML = `
        <div class="text-center">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Memulai update...</span>
            </div>
            <p class="mt-3">Memulai proses update otomatis...</p>
            <div class="progress mt-3">
                <div class="progress-bar progress-bar-striped progress-bar-animated" role="progressbar" style="width: 0%" id="updateProgress">0%</div>
            </div>
        </div>
    `;
    
    if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Updating...';
    }
    
    try {
        // Update progress
        const updateProgress = (percent) => {
            const progressBar = document.getElementById('updateProgress');
            if (progressBar) {
                progressBar.style.width = percent + '%';
                progressBar.textContent = percent + '%';
            }
        };
        
        updateProgress(10);
        
        const response = await fetch('/api/auto-update', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        updateProgress(30);
        
        const result = await response.json();
        
        if (result.success) {
            updateProgress(100);
            content.innerHTML = `
                <div class="alert alert-success">
                    <h6><i class="bi bi-check-circle"></i> Update Dimulai!</h6>
                    <p class="mb-2">Versi: ${result.currentVersion} → ${result.latestVersion}</p>
                    <p class="mb-0">${result.message}</p>
                </div>
                <div class="text-center mt-3">
                    <div class="spinner-border text-success" role="status">
                        <span class="visually-hidden">Aplikasi akan restart...</span>
                    </div>
                    <p class="mt-3">Aplikasi akan restart otomatis dalam beberapa detik...</p>
                    <p class="text-muted small">Jangan tutup browser ini sampai aplikasi restart.</p>
                </div>
            `;
            
            // Check if application restarted (polling)
            let restartAttempts = 0;
            const maxAttempts = 30; // 30 seconds timeout
            
            const checkRestart = setInterval(async () => {
                restartAttempts++;
                updateProgress(100);
                
                try {
                    const healthResponse = await fetch('/api/settings', { 
                        method: 'HEAD',
                        cache: 'no-store',
                        timeout: 2000
                    });
                    
                    if (healthResponse.ok) {
                        clearInterval(checkRestart);
                        content.innerHTML = `
                            <div class="alert alert-success">
                                <h6><i class="bi bi-check-circle"></i> Update Berhasil!</h6>
                                <p class="mb-0">Aplikasi berhasil diupdate dan restart.</p>
                            </div>
                        `;
                        
                        // Reload page after 2 seconds
                        setTimeout(() => {
                            window.location.reload();
                        }, 2000);
                    }
                } catch (e) {
                    // Still restarting
                    if (restartAttempts >= maxAttempts) {
                        clearInterval(checkRestart);
                        content.innerHTML = `
                            <div class="alert alert-warning">
                                <h6><i class="bi bi-exclamation-triangle"></i> Restart Timeout</h6>
                                <p class="mb-0">Update mungkin berhasil, tapi aplikasi tidak merespond. Silakan refresh browser secara manual.</p>
                            </div>
                        `;
                    }
                }
            }, 1000);
            
        } else {
            throw new Error(result.message || 'Auto update failed');
        }
        
    } catch (error) {
        console.error('Auto update error:', error);
        content.innerHTML = `
            <div class="alert alert-danger">
                <h6><i class="bi bi-exclamation-triangle"></i> Update Gagal</h6>
                <p class="mb-0">Auto update gagal: ${error.message}</p>
                <hr>
                <p class="mb-2">Alternatif:</p>
                <button class="btn btn-outline-primary" onclick="window.open('https://github.com/MrSoe94/pospremium/releases', '_blank')">
                    <i class="bi bi-download"></i> Download Manual
                </button>
            </div>
        `;
        
        if (downloadBtn) {
            downloadBtn.disabled = false;
            downloadBtn.innerHTML = '<i class="bi bi-download"></i> Update Otomatis';
        }
    }
}