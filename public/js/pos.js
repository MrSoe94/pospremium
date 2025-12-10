// --- USB Scanner Handling ---
let usbScannerEnabled = false;
let usbScanBuffer = '';
let usbScanTimer = null;
function setUsbScannerEnabled(on) {
    usbScannerEnabled = !!on;
    try { localStorage.setItem('pos_usb_scanner', usbScannerEnabled ? '1' : '0'); } catch (e) {}
    if (scannerToggle) scannerToggle.checked = usbScannerEnabled;
    if (scannerStatus) scannerStatus.textContent = usbScannerEnabled ? 'USB Scanner: Aktif' : 'USB Scanner: Nonaktif';
}

function forceCloseCameraUI(){
    try { autoRescanEnabled = false; } catch (e) {}
    try {
        const modalEl = document.getElementById('cameraScannerModal');
        if (modalEl && window.bootstrap && typeof bootstrap.Modal !== 'undefined') {
            const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
            try { modal.hide(); } catch (e) {}
        }
    } catch (e) {}
    try {
        const ov = document.getElementById('cameraScannerOverlay');
        if (ov && ov.parentNode) ov.remove();
    } catch (e) {}
    try {
        // Remove any lingering elements related to camera scanner
        document.querySelectorAll('[id^="cameraScanner"]').forEach(el=>{ try { el.remove(); } catch (e) {} });
        document.querySelectorAll('.modal-backdrop').forEach(el=>{ try { el.remove(); } catch (e) {} });
    } catch (e) {}
    try {
        const v = document.getElementById('cameraScannerVideo');
        if (v) { try { v.srcObject = null; } catch (e) {} }
    } catch (e) {}
    try { stopCameraScanner(); } catch (e) {}
}
function handleUsbKeydown(e) {
    if (!usbScannerEnabled) return;
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    // Abaikan saat mengetik di input/textarea/select
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.isComposing) return;
    const key = e.key;
    if (key === 'Enter') {
        const code = usbScanBuffer.trim();
        usbScanBuffer = '';
        if (code) {
            try { handleScannedCode(code); } catch (err) { console.warn('USB scan handle error', err); }
        }
        if (usbScanTimer) { clearTimeout(usbScanTimer); usbScanTimer = null; }
        e.preventDefault();
        return;
    }
    if (key && key.length === 1) {
        usbScanBuffer += key;
        if (usbScanTimer) clearTimeout(usbScanTimer);
        // Reset buffer jika tidak ada input lanjutan dalam 200ms
        usbScanTimer = setTimeout(()=>{ usbScanBuffer = ''; }, 200);
    }
}
document.addEventListener('keydown', handleUsbKeydown);

// pos.js
if (window.__POS_JS_LOADED__) {
    console.warn('pos.js already loaded, skipping second execution');
    throw new Error('pos.js already loaded');
}

// Open camera in overlay (extracted helper)
async function openOverlayCamera() {
    try {
        let overlay = document.getElementById('cameraScannerOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'cameraScannerOverlay';
            overlay.innerHTML = `
            <div style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1055;display:flex;align-items:center;justify-content:center;">
              <div style="background:#111;border-radius:8px;padding:12px;max-width:90vw;width:640px;color:#fff;">
                <div class="d-flex justify-content-between align-items-center mb-2">
                  <strong>Scan Kamera</strong>
                  <button id="closeCameraScannerBtn" class="btn btn-sm btn-outline-light">Tutup</button>
                </div>
                <video id="cameraScannerVideo" style="width:100%;max-height:60vh;background:#000" autoplay muted playsinline webkit-playsinline></video>
                <small class="text-muted">Arahkan kode ke dalam kamera. Sistem akan otomatis mendeteksi.</small>
              </div>
            </div>`;
            document.body.appendChild(overlay);
        }

        const videoEl = overlay.querySelector('#cameraScannerVideo') || document.getElementById('cameraScannerVideo');
        if (!videoEl) {
            alert('Video element tidak ditemukan');
            return;
        }

        const closeBtn = overlay.querySelector('#closeCameraScannerBtn') || document.getElementById('closeCameraScannerBtn');
        if (closeBtn) {
            closeBtn.onclick = () => {
                autoRescanEnabled = false; // user manual close disables auto-rescan
                stopCameraScanner();
                const ov = document.getElementById('cameraScannerOverlay');
                if (ov && ov.parentNode) ov.remove();
            };
        }

        // Ensure video element has required attributes for mobile
        videoEl.setAttribute('playsinline', '');
        videoEl.setAttribute('webkit-playsinline', '');
        videoEl.setAttribute('width', '100%');
        videoEl.setAttribute('height', 'auto');
        videoEl.muted = true;
        videoEl.playsInline = true;

        // Try to get camera
        let constraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
        try {
            camStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e) {
            try {
                constraints = { video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
                camStream = await navigator.mediaDevices.getUserMedia(constraints);
            } catch (e2) {
                try {
                    camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                } catch (e3) {
                    alert('Gagal mengakses kamera.');
                    const ov = document.getElementById('cameraScannerOverlay');
                    if (ov && ov.parentNode) ov.remove();
                    return;
                }
            }
        }

        videoEl.srcObject = camStream;
        try { videoEl.load(); } catch (e) {}
        try {
            if (videoEl.readyState < 2) {
                await new Promise((resolve) => {
                    const onCanPlay = () => { videoEl.removeEventListener('canplay', onCanPlay); resolve(); };
                    videoEl.addEventListener('canplay', onCanPlay);
                    setTimeout(() => { videoEl.removeEventListener('canplay', onCanPlay); resolve(); }, 1500);
                });
            }
            if (videoEl.paused) await videoEl.play();
        } catch (playError) {
            console.warn('Autoplay blocked', playError);
            videoEl.controls = true;
        }

        // Start detection
        try {
            const ok = await ensureZXing();
            const ReaderCtor = getZXingReaderCtor();
            if (ok && ReaderCtor) {
                camReader = new ReaderCtor();
                camReader.decodeFromVideoDevice(null, videoEl, (result, err) => {
                    if (err) return;
                    if (result && result.getText) {
                        const text = String(result.getText());
                        const now = Date.now();
                        if (text === lastCamScan.text && now - lastCamScan.time < 1500) return;
                        lastCamScan = { text, time: now };
                        handleScannedCode(text);
                    }
                });
            } else if (await startNativeDetector(videoEl, (text)=>{
                const t = String(text);
                const now = Date.now();
                if (t === lastCamScan.text && now - lastCamScan.time < 1500) return;
                lastCamScan = { text: t, time: now };
                handleScannedCode(t);
            })) {
                // started native detector
            } else {
                alert('Scanner tidak tersedia (ZXing gagal dimuat dan BarcodeDetector tidak didukung).');
                stopCameraScanner();
                const ov = document.getElementById('cameraScannerOverlay');
                if (ov && ov.parentNode) ov.remove();
                return;
            }
            cameraTarget = 'overlay';
        } catch (e) {
            alert('Inisialisasi pemindai gagal: ' + (e.message || e));
            await stopCameraScanner();
            const ov = document.getElementById('cameraScannerOverlay');
            if (ov && ov.parentNode) ov.remove();
        }
    } catch (e) {
        alert('Gagal membuka kamera: ' + (e.message || e));
    }
}
// Expose functions globally for inline handlers in pos.html
try { window.loadRecentTransactions = loadRecentTransactions; } catch (e) {}
try { window.showTransactionDetails = showTransactionDetails; } catch (e) {}
try { window.loadDrafts = loadDrafts; } catch (e) {}
window.__POS_JS_LOADED__ = true;

// OPTIMASI: Fungsi untuk caching API requests
const apiCache = new Map();
const API_CACHE_DURATION = 60000; // 1 menit dalam milidetik

async function fetchWithCache(url, options = {}) {
    const cacheKey = url + JSON.stringify(options);
    const now = Date.now();
    const cachedData = apiCache.get(cacheKey);
    
    // Gunakan cache jika masih valid
    if (cachedData && (now - cachedData.timestamp < API_CACHE_DURATION)) {
        console.log(`[CACHE] Using cached data for ${url}`);
        return new Response(new Blob([JSON.stringify(cachedData.data)], {type: 'application/json'}), {
            status: 200,
            statusText: 'OK',
            headers: {'Content-Type': 'application/json'}
        });
    }
    
    // Jika tidak ada cache atau sudah expired, fetch baru
    console.log(`[API] Fetching ${url}`);
    const response = await fetch(url, {
        ...options,
        credentials: 'include',
        headers: {
            ...options.headers,
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        }
    });
    
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    // Clone response sebelum menggunakan json() agar bisa dikembalikan
    const clonedResponse = response.clone();
    const data = await response.json();
    
    // Simpan ke cache
    apiCache.set(cacheKey, {
        data,
        timestamp: now
    });
    
    return clonedResponse;
}
// --- DEBUG LOG: Cek apakah script ini berjalan ---
console.log("pos.js v4 loaded");

let cart = window.cart || [];
let products = [];
let categories = [];
let currentFilter = 'all';
let currentCategory = 'all';
let searchTerm = '';
let qrisImageSrc = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjY2NjIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtZmFtaWx5PSJBcmlhbCwgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIxNCIgZmlsbD0iIzAwMCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPk5vIFFSSVM8L3RleHQ+PC9zdmc+';
const PLACEHOLDER_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
// OPTIMASI: Variabel untuk meningkatkan performa
let productMap = new Map(); // Map untuk pencarian produk lebih cepat
let filteredProductsCache = {}; // Cache untuk hasil filter
let pendingRender = null; // Untuk throttling render
let lastRenderTime = 0; // Untuk throttling render
let searchDebounceTimer = null; // Untuk debounce pencarian
let recentTransactions = [];
let bestSellerIds = new Set();
let appSettings = null;
let discountType = 'percent';
let discountValue = 0;
let selectedCustomer = { id: 'default', name: 'Pelanggan Umum' };
let customers = [];
// Variant selection state
let selectedVariantIdx = -1;
let drafts = [];
let pendingVariantProduct = null;
let variantSelectModal = null;
let transactionToVoidId = null;

// --- PERBAIKAN: Stabilitas & Performance ---
let isRendering = false;
let isLoading = false;
let activeTooltips = [];
let cartEventListeners = [];

// DOM Elements
const productList = document.getElementById('productList');
const cartItems = document.getElementById('cartItems');
const cartTotal = document.getElementById('cartTotal');
const checkoutBtn = document.getElementById('checkoutBtn');
const logoutBtn = document.getElementById('logoutBtn');
const userNameSpan = document.getElementById('userName');
const bannerContainer = document.getElementById('bannerContainer');
const recentTransactionsList = document.getElementById('recentTransactionsList');
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const categoryDropdownMenu = document.getElementById('categoryDropdownMenu');
const categoryDropdownToggle = document.getElementById('categoryDropdownToggle');
const saveDraftBtn = document.getElementById('saveDraftBtn');
const draftsList = document.getElementById('draftsList');
const discountTypeSelect = document.getElementById('discountType');
const discountValueInput = document.getElementById('discountValue');
const cartSubtotalSpan = document.getElementById('cartSubtotal');
const cartDiscountSpan = document.getElementById('cartDiscount');
const cartTaxSpan = document.getElementById('cartTax');
const cartServiceSpan = document.getElementById('cartService');
const resetCategoryBtn = document.getElementById('resetCategoryBtn');
// const scannerToggle = document.getElementById('scannerToggle');
// const scannerStatus = document.getElementById('scannerStatus');
// Filter buttons
const filterAllBtn = document.getElementById('filterAll');
const filterTopBtn = document.getElementById('filterTop');
const filterBestBtn = document.getElementById('filterBest');
const filterDiscountedBtn = document.getElementById('filterDiscounted');

// Customer Selection Elements
const customerSelect = document.getElementById('customerSelect');
const customerInfo = document.getElementById('customerInfo');

// POS Settings Modal
let posSettingsModal, checkoutModal, transactionDetailsModal, paymentSuccessModal;
const posSettingsBtn = document.getElementById('posSettingsBtn');
const savePosSettingsBtn = document.getElementById('savePosSettingsBtn');
const posPaperWidth = document.getElementById('posPaperWidth');
const posStoreName = document.getElementById('posStoreName');
const posShowAddress = document.getElementById('posShowAddress');
const posShowPhone = document.getElementById('posShowPhone');
const posShowFooter = document.getElementById('posShowFooter');
const modalTotal = document.getElementById('modalTotal');
const amountReceivedInput = document.getElementById('amountReceived');
const transferTotalBtn = document.getElementById('transferTotalBtn');
const changeAmountSpan = document.getElementById('changeAmount');

// Debug: Check if elements are found
console.log('Elements found:', {
    modalTotal: !!modalTotal,
    amountReceivedInput: !!amountReceivedInput,
    transferTotalBtn: !!transferTotalBtn,
    changeAmountSpan: !!changeAmountSpan
});
const confirmPaymentBtn = document.getElementById('confirmPaymentBtn');
const cashPaymentSection = document.getElementById('cashPaymentSection');
const qrisPaymentSection = document.getElementById('qrisPaymentSection');
const voidTransactionBtn = document.getElementById('voidTransactionBtn');
const printReceiptBtn = document.getElementById('printReceiptBtn');
const printReceiptFromDetailsBtn = document.getElementById('printReceiptFromDetailsBtn');
// Variant modal elements
const variantOptionsBox = document.getElementById('variantOptions');
const confirmVariantBtn = document.getElementById('confirmVariantBtn');
// Scanner toggle elements
const scannerToggle = document.getElementById('scannerToggle');
const scannerStatus = document.getElementById('scannerStatus');
// Sidebar toggle element
const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
let scannerEnabled = false;
let scanBuffer = '';
let lastKeyTime = 0;
let scanTimer = null;
let camReader = null;
let camStream = null;
let cameraTarget = null; // 'banner' | 'modal' | 'overlay'
let prevBannerHTML = '';
let nativeDetectorActive = false;
let lastCamScan = { text: '', time: 0 };
let camReloading = false;
let lastCamReloadAt = 0;
let autoRescanEnabled = true; // keep reopening after each scan unless user closes
let programmaticRescan = false; // mark when we hide modal to reopen automatically

// Safely hide bootstrap modal: blur focused element inside modal to avoid aria-hidden focus warning
function hideModalSafely(modalInstance, modalElement) {
    try {
        const active = document.activeElement;
        if (active && modalElement && modalElement.contains(active)) {
            try { active.blur(); } catch (e) {}
            try { document.body.focus(); } catch (e) {}
        }
    } catch (e) {}
    try { modalInstance && modalInstance.hide && modalInstance.hide(); } catch (e) {}
}

async function loadScript(url){
    return new Promise((resolve,reject)=>{
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Fail load '+url));
        document.head.appendChild(s);
    });
}

async function startNativeDetector(videoEl, onText){
    if (!('BarcodeDetector' in window)) return false;
    try {
        const formats = ['qr_code','ean_13','ean_8','code_128','code_39','upc_a','upc_e'];
        const detector = new window.BarcodeDetector({ formats });
        nativeDetectorActive = true;
        const loop = async () => {
            if (!nativeDetectorActive) return;
            try {
                const codes = await detector.detect(videoEl);
                if (codes && codes.length > 0) {
                    const text = String(codes[0].rawValue || codes[0].rawText || '');
                    if (text) { onText(text); }
                }
            } catch (e) {}
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        return true;
    } catch (e) { return false; }
}

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
    for (const url of candidates) {
        try {
            await loadScript(url);
            if ((window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader) || (window.ZXing && window.ZXing.BrowserMultiFormatReader)) return true;
        } catch (e) {}
    }
    return false;
}

function getZXingReaderCtor(){
    if (window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader) return window.ZXingBrowser.BrowserMultiFormatReader;
    if (window.ZXing && window.ZXing.BrowserMultiFormatReader) return window.ZXing.BrowserMultiFormatReader;
    return null;
}

// Stop camera scanner and cleanup
async function stopCameraScanner() {
    try {
        nativeDetectorActive = false;
        if (camReader) {
            try {
                if (typeof camReader.stopAsyncStreams === 'function') {
                    camReader.stopAsyncStreams();
                } else if (typeof camReader.reset === 'function') {
                    camReader.reset();
                }
            } catch (e) {
                console.warn('Error stopping camera reader:', e);
            }
            camReader = null;
        }
        if (camStream) {
            camStream.getTracks().forEach(track => {
                track.stop();
            });
            camStream = null;
        }
        const videoEl = document.getElementById('cameraScannerVideo');
        if (videoEl) {
            videoEl.srcObject = null;
        }
        // Always remove overlay element if exists
        try {
            const ov = document.getElementById('cameraScannerOverlay');
            if (ov && ov.parentNode) ov.remove();
        } catch (e) {}
        cameraTarget = null;
    } catch (e) {
        console.warn('Error in stopCameraScanner:', e);
    }
}

// Light camera reload without closing UI
async function reloadCameraStream() {
    try {
        if (camReloading) return;
        const videoEl = document.getElementById('cameraScannerVideo');
        if (!videoEl) return;
        camReloading = true;
        // Stop previous tracks but do NOT close modal/overlay
        try { if (camStream) { camStream.getTracks().forEach(t=>t.stop()); } } catch (e) {}
        try { videoEl.srcObject = null; } catch (e) {}
        // Try to reacquire preferred camera
        let constraints = {
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        };
        try {
            camStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e) {
            try { camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
            catch (e2) { console.warn('Reload camera failed', e2); camReloading = false; return; }
        }
        videoEl.srcObject = camStream;
        try { videoEl.load(); } catch (e) {}
        try { if (videoEl.paused) await videoEl.play(); } catch (e) {}
    } finally {
        camReloading = false;
    }
}

// Check if device is mobile
function isMobileDevice() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

// Try to open native camera/scanner app using file input
function openNativeScannerApp() {
    return new Promise((resolve) => {
        // Create a hidden file input that triggers camera
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.capture = 'environment'; // Use back camera
        input.style.display = 'none';
        
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) {
                resolve(false);
                return;
            }
            
            try {
                // Read the image file
                const reader = new FileReader();
                reader.onload = async (event) => {
                    try {
                        // Try to decode QR/barcode from image using ZXing
                        const imageData = event.target.result;
                        
                        // Create image element
                        const img = new Image();
                        img.onload = async () => {
                            try {
                                // Try using ZXing to decode
                                const ok = await ensureZXing();
                                const ReaderCtor = getZXingReaderCtor();
                                
                                if (ok && ReaderCtor) {
                                    const reader = new ReaderCtor();
                                    try {
                                        // Try different decode methods based on ZXing version
                                        let result = null;
                                        if (typeof reader.decodeFromImageElement === 'function') {
                                            result = await reader.decodeFromImageElement(img);
                                        } else if (typeof reader.decodeFromImage === 'function') {
                                            result = await reader.decodeFromImage(img);
                                        } else if (typeof reader.decode === 'function') {
                                            result = await reader.decode(img);
                                        }
                                        
                                        if (result) {
                                            const text = result.getText ? result.getText() : (result.text || String(result));
                                            if (text) {
                                                handleScannedCode(String(text));
                                                resolve(true);
                                                return;
                                            }
                                        }
                                    } catch (decodeError) {
                                        console.warn('Failed to decode from image:', decodeError);
                                    }
                                }
                                
                                // Try native BarcodeDetector if available
                                if ('BarcodeDetector' in window) {
                                    try {
                                        const formats = ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e'];
                                        const detector = new window.BarcodeDetector({ formats });
                                        const codes = await detector.detect(img);
                                        if (codes && codes.length > 0 && codes[0].rawValue) {
                                            handleScannedCode(String(codes[0].rawValue));
                                            resolve(true);
                                            return;
                                        }
                                    } catch (detectorError) {
                                        console.warn('BarcodeDetector failed:', detectorError);
                                    }
                                }
                                
                                alert('Tidak dapat membaca barcode/QR code dari gambar. Pastikan gambar jelas dan barcode/QR code terlihat dengan baik.');
                                resolve(false);
                            } catch (error) {
                                console.error('Error processing image:', error);
                                alert('Terjadi kesalahan saat memproses gambar.');
                                resolve(false);
                            }
                        };
                        img.src = imageData;
                    } catch (error) {
                        console.error('Error reading file:', error);
                        resolve(false);
                    }
                };
                reader.readAsDataURL(file);
            } catch (error) {
                console.error('Error handling file:', error);
                resolve(false);
            } finally {
                // Cleanup
                document.body.removeChild(input);
            }
        };
        
        input.oncancel = () => {
            document.body.removeChild(input);
            resolve(false);
        };
        
        // Add to body and trigger click
        document.body.appendChild(input);
        input.click();
    });
}

// Start camera scanner in banner area (if needed)
async function startBannerCameraScanner(banner) {
    // For now, just use modal instead of banner to avoid complexity
    // This can be implemented later if needed
    const modalEl = document.getElementById('cameraScannerModal');
    if (modalEl && window.bootstrap && typeof bootstrap.Modal !== 'undefined') {
        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        modal.show();
        return;
    }
    // Fall through to overlay method
}

// --- Cleanup function ---
function cleanup() {
    // Clear search debounce timer
    if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
    }
    
    // Dispose all tooltips
    activeTooltips.forEach(tooltip => {
        try {
            if (tooltip && typeof tooltip.dispose === 'function') {
                tooltip.dispose();
            }
        } catch (e) {
            // Ignore errors during cleanup
        }
    });
    activeTooltips = [];
    
    // Cleanup event listeners
    cartEventListeners.forEach(cleanup => {
        try {
            cleanup();
        } catch (e) {
            // Ignore errors during cleanup
        }
    });
    cartEventListeners = [];
}

function updateScannerStatus(extra){
    if (!scannerStatus) return;
    const base = scannerEnabled ? 'Scanner aktif' : 'Scanner non-aktif';
    scannerStatus.textContent = extra ? `${base} – ${extra}` : base;
}

function setupScannerEvents(){
    if (!scannerToggle) return;
    scannerToggle.addEventListener('change', () => {
        scannerEnabled = !!scannerToggle.checked;
        try { localStorage.setItem('pos_scannerEnabled', scannerEnabled ? '1' : '0'); } catch (e) {}
        updateScannerStatus('');
    });

    document.addEventListener('keydown', (e) => {
        if (!scannerEnabled) return;
        // Ignore typing in inputs/textareas/selects
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
        const type = (e.target && e.target.type) ? String(e.target.type).toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || type === 'number' || type === 'text') return;

        const now = Date.now();
        const delta = now - lastKeyTime;
        lastKeyTime = now;

        // If too slow or invalid key, reset buffer except for digits/letters and some symbols
        if (delta > 100) {
            scanBuffer = '';
        }

        if (e.key === 'Enter') {
            e.preventDefault();
            const code = scanBuffer.trim();
            scanBuffer = '';
            if (code.length >= 3) {
                handleScannedCode(code);
            }
            return;
        }

        // Acceptable characters: digits, letters, dash, underscore
        if (/^[0-9A-Za-z-_]$/.test(e.key)) {
            scanBuffer += e.key;
            // Fallback timeout: if no Enter arrives, finalize after short delay
            if (scanTimer) clearTimeout(scanTimer);
            scanTimer = setTimeout(() => {
                const code = scanBuffer.trim();
                scanBuffer = '';
                if (code.length >= 6) handleScannedCode(code);
            }, 80);
        }
    });

    // Camera scanner open button
    const openBtn = document.getElementById('openCameraScannerBtn');
    if (openBtn) {
        openBtn.addEventListener('click', async function(){
            try {
                if (camReader) { await stopCameraScanner(); }

                // Always use browser camera (direct access)
                openBrowserCamera();
            } catch (e) {
                console.error('Error opening camera scanner:', e);
                alert('Gagal membuka scanner: ' + (e.message || e));
            }
        });
    }

    // Function to open browser camera
    async function openBrowserCamera() {
        try {
            // Check if mediaDevices API is available
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                alert('Peramban Anda tidak mendukung akses kamera. Silakan gunakan peramban yang lebih baru atau perbarui peramban Anda.');
                return;
            }

            // Secure context check (required by mobile browsers)
            if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
                alert('Kamera hanya dapat diakses di HTTPS atau localhost. Akses halaman ini via HTTPS (mis. ngrok/Cloudflare Tunnel) atau jalankan di localhost.');
                return;
            }

            // Prefer rendering camera in banner area if available
            const banner = document.getElementById('bannerContainer');
            if (banner) {
                // no-op; modal initialization handled below
            }

            // If Bootstrap modal exists, use it
            const modalEl = document.getElementById('cameraScannerModal');
            if (modalEl && window.bootstrap && typeof bootstrap.Modal !== 'undefined') {
                const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
                
                const onShown = async () => {
                    try {
                        console.log('Modal shown, initializing camera...');
                        autoRescanEnabled = true; // reset on each show
                        const videoEl = document.getElementById('cameraScannerVideo');
                        if (!videoEl) {
                            console.error('Video element not found');
                            alert('Video element tidak ditemukan');
                            return;
                        }
                        
                        console.log('Video element found, setting up...');
                        
                        // Ensure video element has required attributes for mobile
                        videoEl.setAttribute('playsinline', '');
                        videoEl.setAttribute('webkit-playsinline', '');
                        videoEl.setAttribute('width', '100%');
                        videoEl.setAttribute('height', 'auto');
                        videoEl.muted = true; // Required for autoplay
                        videoEl.playsInline = true; // For iOS
                        videoEl.autoplay = true;
                        
                        // Clear any existing stream first
                        if (videoEl.srcObject) {
                            const oldStream = videoEl.srcObject;
                            oldStream.getTracks().forEach(track => track.stop());
                            videoEl.srcObject = null;
                        }
                        
                        // Try to get back camera first (for mobile devices)
                        let constraints = { 
                            video: { 
                                facingMode: { ideal: 'environment' },
                                width: { ideal: 1280 },
                                height: { ideal: 720 }
                            }, 
                            audio: false 
                        };
                        
                        console.log('Requesting camera access...');
                        try {
                            camStream = await navigator.mediaDevices.getUserMedia(constraints);
                            console.log('Camera access granted, stream:', camStream);
                        } catch (e) {
                            console.warn('Failed with back camera, trying front camera:', e);
                            // Try front camera
                            try {
                                constraints = { 
                                    video: { 
                                        facingMode: { ideal: 'user' },
                                        width: { ideal: 1280 },
                                        height: { ideal: 720 }
                                    }, 
                                    audio: false 
                                };
                                camStream = await navigator.mediaDevices.getUserMedia(constraints);
                                console.log('Front camera access granted');
                            } catch (e2) {
                                // Last fallback: any camera
                                try {
                                    camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                                    console.log('Any camera access granted');
                                } catch (e3) {
                                    console.error('getUserMedia failed completely:', e3);
                                    let errorMsg = 'Gagal mengakses kamera.';
                                    if (e3.name === 'NotAllowedError' || e3.name === 'PermissionDeniedError') {
                                        errorMsg += '\n\nAnda perlu memberikan izin akses kamera. Silakan periksa pengaturan peramban Anda.';
                                    } else if (e3.name === 'NotFoundError' || e3.name === 'DevicesNotFoundError') {
                                        errorMsg += '\n\nTidak ada kamera yang terdeteksi pada perangkat ini.';
                                    } else {
                                        errorMsg += '\n\nError: ' + (e3.message || e3.name || 'Unknown error');
                                    }
                                    alert(errorMsg);
                                    modal.hide();
                                    return;
                                }
                            }
                        }
                        
                        console.log('Attaching stream to video element...');
                        videoEl.srcObject = camStream;
                        console.log('Stream attached, waiting for video to load...');
                        
                        // Load video metadata
                        videoEl.load();
                        
                        // Wait for video metadata to load
                        await new Promise((resolve) => {
                            if (videoEl.readyState >= 2) {
                                console.log('Video already ready');
                                resolve();
                            } else {
                                const onLoadedMetadata = () => {
                                    console.log('Video metadata loaded');
                                    videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
                                    videoEl.removeEventListener('error', onError);
                                    resolve();
                                };
                                const onError = (e) => {
                                    console.error('Video error:', e);
                                    videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
                                    videoEl.removeEventListener('error', onError);
                                    resolve(); // Continue anyway
                                };
                                videoEl.addEventListener('loadedmetadata', onLoadedMetadata);
                                videoEl.addEventListener('error', onError);
                                
                                // Timeout fallback
                                setTimeout(() => {
                                    console.log('Video load timeout, continuing anyway');
                                    videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
                                    videoEl.removeEventListener('error', onError);
                                    resolve();
                                }, 3000);
                            }
                        });
                        
                        // Ensure video is playing
                        try {
                            // Wait for video to be ready to play
                            if (videoEl.readyState < 2) {
                                await new Promise((resolve) => {
                                    const onCanPlay = () => {
                                        console.log('Video can play');
                                        videoEl.removeEventListener('canplay', onCanPlay);
                                        resolve();
                                    };
                                    videoEl.addEventListener('canplay', onCanPlay);
                                });
                            }
                            
                            if (videoEl.paused) {
                                await videoEl.play();
                            }
                            
                            // Force play if still paused
                            if (videoEl.paused) {
                                videoEl.play().catch(e => console.warn('Force play failed:', e));
                            }
                        } catch (playError) {
                            console.warn('Auto-play prevented:', playError);
                            // Try to enable controls as fallback
                            videoEl.controls = true;
                            alert('Video autoplay diblokir. Klik play untuk memulai kamera.');
                        }
                        
                        // Try to start barcode detection
                        const ok = await ensureZXing();
                        const ReaderCtor = getZXingReaderCtor();
                        if (ok && ReaderCtor) {
                            camReader = new ReaderCtor();
                            if (typeof camReader.decodeFromVideoDevice === 'function') {
                                camReader.decodeFromVideoDevice(null, videoEl, (result, err) => {
                                    if (err) {
                                        return;
                                    }
                                    if (result && result.getText) {
                                        const text = String(result.getText());
                                        const now = Date.now();
                                        if (text === lastCamScan.text && now - lastCamScan.time < 1500) return;
                                        lastCamScan = { text, time: now };
                                        handleScannedCode(text);
                                    }
                                });
                            } else if (typeof camReader.decodeFromVideoElement === 'function') {
                                camReader.decodeFromVideoElement(videoEl, (result, err) => {
                                    if (err) {
                                        return;
                                    }
                                    if (result && result.getText) {
                                        const text = String(result.getText());
                                        const now = Date.now();
                                        if (text === lastCamScan.text && now - lastCamScan.time < 1500) return;
                                        lastCamScan = { text, time: now };
                                        handleScannedCode(text);
                                    }
                                });
                            } else if (typeof camReader.decodeFromInputVideoDevice === 'function') {
                                try {
                                    const result = await camReader.decodeFromInputVideoDevice(undefined, videoEl);
                                    const text = result && (result.getText ? result.getText() : result.text);
                                    if (text) {
                                        const t = String(text);
                                        const now = Date.now();
                                        if (t === lastCamScan.text && now - lastCamScan.time < 1500) {
                                            // keep camera open
                                        } else {
                                            lastCamScan = { text: t, time: now };
                                            handleScannedCode(t);
                                        }
                                    }
                                } catch (e) {
                                    console.warn('decodeFromInputVideoDevice failed:', e);
                                }
                            } else if (typeof camReader.decodeFromVideoSource === 'function') {
                                try {
                                    // Use current stream by binding srcObject already set on videoEl
                                    // decodeFromVideoSource expects a URL string; fallback to native below if not supported
                                } catch (e) {}
                            } else {
                                console.warn('ZXing reader has no compatible decode methods; falling back to native detector');
                                if (!(await startNativeDetector(videoEl, (text)=>{
                                    const t = String(text);
                                    const now = Date.now();
                                    if (t === lastCamScan.text && now - lastCamScan.time < 1500) return;
                                    lastCamScan = { text: t, time: now };
                                    handleScannedCode(t);
                                }))) {
                                    alert('Scanner tidak tersedia (metode ZXing tidak didukung dan BarcodeDetector tidak tersedia).');
                                    stopCameraScanner();
                                    modal.hide();
                                    return;
                                }
                            }
                        } else if (await startNativeDetector(videoEl, (text)=>{
                            const t = String(text);
                            const now = Date.now();
                            if (t === lastCamScan.text && now - lastCamScan.time < 1500) return;
                            lastCamScan = { text: t, time: now };
                            handleScannedCode(t);
                        })) {
                            // started native detector
                        } else {
                            alert('Scanner tidak tersedia (ZXing gagal dimuat dan BarcodeDetector tidak didukung).');
                            stopCameraScanner();
                            modal.hide();
                            return;
                        }
                        cameraTarget = 'modal';
                    } catch (e) {
                        console.error('Error starting camera:', e);
                        alert('Gagal membuka kamera: ' + (e.message || e));
                        stopCameraScanner();
                    }
                };
                
                // Remove existing listeners to prevent duplicates
                modalEl.removeEventListener('shown.bs.modal', onShown);
                modalEl.addEventListener('shown.bs.modal', onShown, { once: true });

                // Handle hidden: always stop camera; if programmatic, reopen after a short delay
                const onHidden = () => {
                    try { stopCameraScanner(); } catch (e) {}
                    if (programmaticRescan && autoRescanEnabled) {
                        programmaticRescan = false;
                        setTimeout(() => { try { modal.show(); } catch(e){} }, 80);
                    }
                };
                const onHide = () => {
                    // If user initiates hide (no programmatic flag), disable auto-rescan
                    if (!programmaticRescan) {
                        autoRescanEnabled = false;
                    }
                };
                modalEl.removeEventListener('hidden.bs.modal', onHidden);
                modalEl.addEventListener('hidden.bs.modal', onHidden);
                modalEl.removeEventListener('hide.bs.modal', onHide);
                modalEl.addEventListener('hide.bs.modal', onHide);

                modal.show();
                return;
            }

            // Create overlay if not exists
            let overlay = document.getElementById('cameraScannerOverlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'cameraScannerOverlay';
                overlay.innerHTML = `
                <div style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1055;display:flex;align-items:center;justify-content:center;">
                  <div style="background:#111;border-radius:8px;padding:12px;max-width:90vw;width:640px;color:#fff;">
                    <div class="d-flex justify-content-between align-items-center mb-2">
                      <strong>Scan Kamera</strong>
                      <button id="closeCameraScannerBtn" class="btn btn-sm btn-outline-light">Tutup</button>
                    </div>
                    <video id="cameraScannerVideo" style="width:100%;max-height:60vh;background:#000" autoplay muted playsinline webkit-playsinline></video>
                    <small class="text-muted">Arahkan kode ke dalam kamera. Sistem akan otomatis mendeteksi.</small>
                  </div>
                </div>`;
                document.body.appendChild(overlay);
            }

            const videoEl = overlay.querySelector('#cameraScannerVideo') || document.getElementById('cameraScannerVideo');
            if (!videoEl) {
                alert('Video element tidak ditemukan');
                return;
            }
            
            const closeBtn = overlay.querySelector('#closeCameraScannerBtn') || document.getElementById('closeCameraScannerBtn');
            if (closeBtn) {
                closeBtn.onclick = () => { 
                    autoRescanEnabled = false; // user manual close disables auto-rescan
                    stopCameraScanner(); 
                    if (overlay && overlay.parentNode) {
                        overlay.remove(); 
                    }
                };
            }

            // Ensure video element has required attributes for mobile
            videoEl.setAttribute('playsinline', '');
            videoEl.setAttribute('webkit-playsinline', '');
            videoEl.setAttribute('width', '100%');
            videoEl.setAttribute('height', 'auto');
            videoEl.muted = true; // Required for autoplay
            videoEl.playsInline = true; // For iOS
            
            // Try to get back camera first (for mobile devices)
            let constraints = { 
                video: { 
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                }, 
                audio: false 
            };
            
            try {
                camStream = await navigator.mediaDevices.getUserMedia(constraints);
            } catch (e) {
                console.warn('Failed with back camera, trying front camera:', e);
                // Try front camera
                try {
                    constraints = { 
                        video: { 
                            facingMode: { ideal: 'user' },
                            width: { ideal: 1280 },
                            height: { ideal: 720 }
                        }, 
                        audio: false 
                    };
                    camStream = await navigator.mediaDevices.getUserMedia(constraints);
                } catch (e2) {
                    // Last fallback: any camera
                    try {
                        camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                    } catch (e3) {
                        console.error('getUserMedia failed completely:', e3);
                        let errorMsg = 'Gagal mengakses kamera.';
                        if (e3.name === 'NotAllowedError' || e3.name === 'PermissionDeniedError') {
                            errorMsg += '\n\nAnda perlu memberikan izin akses kamera. Silakan periksa pengaturan peramban Anda.';
                        } else if (e3.name === 'NotFoundError' || e3.name === 'DevicesNotFoundError') {
                            errorMsg += '\n\nTidak ada kamera yang terdeteksi pada perangkat ini.';
                        } else {
                            errorMsg += '\n\nError: ' + (e3.message || e3.name || 'Unknown error');
                        }
                        alert(errorMsg);
                        const overlayEl = document.getElementById('cameraScannerOverlay');
                        if (overlayEl && overlayEl.parentNode) {
                            overlayEl.remove();
                        }
                        return;
                    }
                }
            }
            
            videoEl.srcObject = camStream;
            
            // Load video metadata
            videoEl.load();
            
            // Wait for video metadata to load
            await new Promise((resolve, reject) => {
                if (videoEl.readyState >= 2) {
                    resolve();
                } else {
                    const onLoadedMetadata = () => {
                        videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
                        videoEl.removeEventListener('error', onError);
                        resolve();
                    };
                    const onError = (e) => {
                        videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
                        videoEl.removeEventListener('error', onError);
                        reject(e);
                    };
                    videoEl.addEventListener('loadedmetadata', onLoadedMetadata);
                    videoEl.addEventListener('error', onError);
                    
                    // Timeout fallback
                    setTimeout(() => {
                        videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
                        videoEl.removeEventListener('error', onError);
                        resolve(); // Resolve anyway to continue
                    }, 5000);
                }
            });
            
            // Ensure video is playing
            try {
                // Wait for video to be ready to play
                if (videoEl.readyState < 2) {
                    await new Promise((resolve) => {
                        const onCanPlay = () => {
                            videoEl.removeEventListener('canplay', onCanPlay);
                            resolve();
                        };
                        videoEl.addEventListener('canplay', onCanPlay);
                    });
                }
                
                if (videoEl.paused) {
                    await videoEl.play();
                }
                
                // Force play if still paused
                if (videoEl.paused) {
                    videoEl.play().catch(e => console.warn('Play failed:', e));
                }
            } catch (playError) {
                console.warn('Auto-play prevented, trying again:', playError);
                // Try to enable controls as fallback
                videoEl.controls = true;
                alert('Video autoplay diblokir. Klik play untuk memulai kamera.');
            }

            // ZXing reader
            try {
                const ok = await ensureZXing();
                const ReaderCtor = getZXingReaderCtor();
                if (ok && ReaderCtor) {
                    camReader = new ReaderCtor();
                    camReader.decodeFromVideoDevice(null, videoEl, (result, err) => {
                        if (err) {
                            // Ignore continuous errors
                            return;
                        }
                        if (result && result.getText) {
                            const text = String(result.getText());
                            const now = Date.now();
                            if (text === lastCamScan.text && now - lastCamScan.time < 1500) return;
                            lastCamScan = { text, time: now };
                            handleScannedCode(text);
                        }
                    });
                } else if (await startNativeDetector(videoEl, (text)=>{
                    const t = String(text);
                    const now = Date.now();
                    if (t === lastCamScan.text && now - lastCamScan.time < 1500) return;
                    lastCamScan = { text: t, time: now };
                    handleScannedCode(t);
                })) {
                    // started native detector
                } else {
                    alert('Scanner tidak tersedia (ZXing gagal dimuat dan BarcodeDetector tidak didukung).');
                    stopCameraScanner();
                    return;
                }
                cameraTarget = 'overlay';
            } catch (e) {
                console.error('ZXing init error:', e);
                alert('Inisialisasi pemindai gagal: ' + (e.message || e));
                await stopCameraScanner();
            }
        } catch (e) {
            alert('Gagal membuka kamera: ' + (e.message || e));
        }
    }
}

function handleScannedCode(raw){
    try {
        const code = String(raw || '').trim();
        updateScannerStatus(`kode: ${code}`);
        if (!code) return;

        // Build candidate codes from various QR formats
        const candidates = new Set();
        const push = (v) => { if (v != null && String(v).trim() !== '') candidates.add(String(v).trim()); };

        // 1) Raw as-is
        push(code);

        // 2) If URL, extract common params and last path segment
        try {
            const u = new URL(code);
            const params = ['sku','qr','q','code','id'];
            const push = v => { if (v != null && String(v).trim()) candidates.add(String(v).trim()); };
            params.forEach(k => push(u.searchParams.get(k)));
            const parts = u.pathname.split('/').filter(Boolean);
            if (parts.length > 0) push(parts[parts.length-1]);
        } catch (e) {}

        // 3) If JSON, try keys sku/qrCode/code/id
        try {
            const obj = JSON.parse(code);
            ['sku','qrCode','code','id','productId'].forEach(k=> push(obj?.[k]));
        } catch (e) {}

        // 4) Normalize: remove spaces and hyphens for barcode-like
        Array.from(candidates).forEach(v=>{
            const compact = v.replace(/[\s-]+/g,'');
            if (compact !== v) push(compact);
        });

        // Try to find product by multiple candidates
        const lowerSet = new Set(Array.from(candidates).map(x=>x.toLowerCase()));
        const prod = (products || []).find(p => lowerSet.has(String(p.sku||'').toLowerCase()))
            || (products || []).find(p => candidates.has(String(p.id)))
            || (products || []).find(p => lowerSet.has(String(p.qrCode||'').toLowerCase()));

        if (!prod) {
            updateScannerStatus(`kode tidak dikenal: ${code}`);
            return;
        }
        addToCart(prod.id);
        updateScannerStatus(`ditambahkan: ${prod.name || prod.sku || prod.id}`);
        // Close camera immediately (no auto reopen)
        try { forceCloseCameraUI(); } catch (e) {}
    } catch (err) {
        console.warn('handleScannedCode error', err);
    }
}

// CSRF token handling for POS
var __csrfPosToken = null;
try {
    (async function initPosCsrf(){
        try {
            const r = await fetch('/api/csrf', { cache: 'no-store' });
            const j = await r.json().catch(()=>({}));
            if (j && j.csrfToken) __csrfPosToken = j.csrfToken;
        } catch (e) {}
    })();
    (function(){
        const of = window.fetch;
        window.fetch = async function(input, init){
            init = init || {};
            const url = (typeof input === 'string') ? input : (input && input.url) || '';
            const method = String((init.method || 'GET')).toUpperCase();
            const needs = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
            const isApi = typeof url === 'string' && url.indexOf('/api/') !== -1 && url.startsWith('/');
            if (needs && isApi && __csrfPosToken) {
                init.headers = Object.assign({}, init.headers, { 'X-CSRF-Token': __csrfPosToken });
            }
            return of(input, init);
        };
    })();
} catch (e) {}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    console.log("DOM fully loaded. Initializing app...");
    
    try {
        try {
            const savedCart = JSON.parse(localStorage.getItem('pos_cart') || '[]');
            if (Array.isArray(savedCart)) cart = savedCart;
        } catch (e) {}
        // Render cart immediately so user sees items persisted after refresh
        try { renderCart(); } catch (e) { console.warn('Render cart on load failed:', e); }
        // Restore discount settings
        try {
            const dt = localStorage.getItem('pos_discountType');
            const dv = localStorage.getItem('pos_discountValue');
            if (dt && (dt === 'amount' || dt === 'percent')) {
                discountType = dt;
                if (discountTypeSelect) discountTypeSelect.value = dt;
            }
            if (dv != null && dv !== '') {
                const num = parseFloat(dv);
                if (!Number.isNaN(num)) {
                    discountValue = Math.max(0, num);
                    if (discountValueInput) discountValueInput.value = String(discountValue);
                }
            }
        } catch (e) {}
        // Restore payment method
        try {
            const pm = localStorage.getItem('pos_paymentMethod');
            if (pm) {
                const radio = document.querySelector(`input[name="paymentMethod"][value="${pm}"]`);
                if (radio) {
                    radio.checked = true;
                    if (pm === 'cash') {
                        if (cashPaymentSection) cashPaymentSection.style.display = 'block';
                        if (qrisPaymentSection) qrisPaymentSection.style.display = 'none';
                    } else {
                        if (cashPaymentSection) cashPaymentSection.style.display = 'none';
                        if (qrisPaymentSection) qrisPaymentSection.style.display = 'block';
                    }
                }
            }
        } catch (e) {}
        // Initialize modals after DOM is ready, guard if bootstrap is not yet available
        const posSettingsModalEl = document.getElementById('posSettingsModal');
        const checkoutModalEl = document.getElementById('checkoutModal');
        const transactionDetailsModalEl = document.getElementById('transactionDetailsModal');
        const paymentSuccessModalEl = document.getElementById('paymentSuccessModal');

        function initModals() {
            try {
                if (typeof window.bootstrap === 'undefined') return false;
                if (posSettingsModalEl) posSettingsModal = new bootstrap.Modal(posSettingsModalEl);
                if (checkoutModalEl) checkoutModal = new bootstrap.Modal(checkoutModalEl);
                if (transactionDetailsModalEl) transactionDetailsModal = new bootstrap.Modal(transactionDetailsModalEl);
                if (paymentSuccessModalEl) paymentSuccessModal = new bootstrap.Modal(paymentSuccessModalEl);
                return true;
            } catch (e) {
                console.error('Bootstrap modal init failed:', e);
                return false;
            }
        }
        if (!initModals()) {
            window.addEventListener('load', () => { initModals(); });
        }
        // Bind POS Settings button to open the modal
        try {
            if (posSettingsBtn && !posSettingsBtn._bound) {
                posSettingsBtn._bound = true;
                posSettingsBtn.addEventListener('click', () => {
                    try { if (!posSettingsModal) initModals(); } catch (e) {}
                    try { if (typeof loadPosSettingsToModal === 'function') loadPosSettingsToModal(); } catch (e) {}
                    try { posSettingsModal && posSettingsModal.show && posSettingsModal.show(); } catch (e) {}
                });
            }
        } catch (e) {}
        // Bind Save button in POS Settings modal
        try {
            if (savePosSettingsBtn && !savePosSettingsBtn._bound) {
                savePosSettingsBtn._bound = true;
                savePosSettingsBtn.addEventListener('click', async () => {
                    try {
                        if (typeof savePosSettingsFromModal === 'function') {
                            await savePosSettingsFromModal();
                        }
                    } catch (e) {}
                });
            }
        } catch (e) {}
        
        // PERBAIKAN: Load data dengan error handling yang lebih baik
        console.log("Loading settings...");
        await loadSettingsPOS().catch(err => console.error('Failed to load settings:', err));
        
        console.log("Fetching user info...");
        await fetchUserInfo().catch(err => console.error('Failed to fetch user info:', err));
        
        console.log("Loading categories...");
        await loadCategories().catch(err => console.error('Failed to load categories:', err));
        
        console.log("Loading banner...");
        await loadBanner().catch(err => console.error('Failed to load banner:', err));
        
        console.log("Loading products...");
        await loadProducts().catch(err => console.error('Failed to load products:', err));
        // Re-render cart to update any stock-related warnings after products are loaded
        try { renderCart(); } catch (e) {}
        
        console.log("Loading QRIS image...");
        await loadQrisImage().catch(err => console.error('Failed to load QRIS:', err));
        
        console.log("Loading recent transactions...");
        await loadRecentTransactions().catch(err => console.error('Failed to load transactions:', err));
        
        console.log("Loading customers...");
        await loadCustomers().catch(err => console.error('Failed to load customers:', err));
        // Restore selected customer after customers loaded
        try {
            const sc = localStorage.getItem('pos_customerId');
            if (sc) {
                if (sc === 'default') {
                    selectedCustomer = { id: 'default', name: 'Pelanggan Umum' };
                } else {
                    const c = customers.find(x => String(x.id) === String(sc));
                    if (c) selectedCustomer = { id: c.id, name: c.name };
                }
                populateCustomerSelect();
            }
        } catch (e) {}
        
        console.log("Loading drafts...");
        await loadDrafts().catch(err => console.error('Failed to load drafts:', err));
        
        console.log("Setting up event listeners...");
        setupEventListeners();
        setupScannerEvents();

        // Init scanner from localStorage
        try {
            const v = localStorage.getItem('pos_scannerEnabled');
            scannerEnabled = v === '1';
            if (scannerToggle) scannerToggle.checked = scannerEnabled;
            updateScannerStatus('');
        } catch (e) {}
        
        console.log("App initialization complete.");
    } catch (error) {
        console.error('Critical error during initialization:', error);
        alert('Terjadi kesalahan saat memuat aplikasi. Silakan refresh halaman.');
    }
});

// PERBAIKAN: Cleanup saat halaman ditutup
window.addEventListener('beforeunload', cleanup);
window.addEventListener('pagehide', cleanup);

// Prevent aria-hidden focus warning by blurring focus inside modals before hide
try {
    document.addEventListener('hidden.bs.modal', (ev) => {
        try {
            const modalEl = ev.target;
            const active = document.activeElement;
            if (modalEl && active && modalEl.contains(active)) {
                try { active.blur(); } catch (e) {}
                try { document.body.focus(); } catch (e) {}
            }
        } catch (e) {}
    });
} catch (e) {}

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
    const body = precision > 0 ? intPart + dec + decPart : intPart;
    return (neg ? '-' : '') + symbol + ' ' + body.trim();
}

function computeTotals() {
    let baseSubtotal = 0;
    let perProductDiscountTotal = 0;
    let perProductTaxTotal = 0;
    const items = cart;
    let afterItemDiscountSubtotal = 0;
    items.forEach((item) => {
        const product = products.find(p => p.id === item.productId) || {};
        const itemBase = (item.price || 0) * (item.qty || 0);
        baseSubtotal += itemBase;
        const pDisc = Math.max(0, Number(product.discountPercent || 0));
        const pTax = Math.max(0, Number(product.taxRate || 0));
        const itemDisc = Math.round(itemBase * (pDisc / 100));
        const itemNet = itemBase - itemDisc;
        const itemTax = Math.round(itemNet * (pTax / 100));
        perProductDiscountTotal += itemDisc;
        perProductTaxTotal += itemTax;
        afterItemDiscountSubtotal += itemNet;
    });

    const taxRate = Number(appSettings?.taxRate || 0);
    const serviceRate = Number(appSettings?.serviceRate || 0);
    const priceIncludesTax = Boolean(appSettings?.priceIncludesTax || false);

    // Cart-level discount
    let discVal = Math.max(0, Number(discountValue) || 0);
    let cartDiscount = 0;
    if (discountType === 'percent' && discVal > 0) {
        cartDiscount = Math.round(afterItemDiscountSubtotal * (discVal / 100));
    } else if (discountType === 'amount' && discVal > 0) {
        cartDiscount = Math.round(discVal);
    }
    if (cartDiscount > afterItemDiscountSubtotal) cartDiscount = afterItemDiscountSubtotal;

    const netAfterCartDiscount = afterItemDiscountSubtotal - cartDiscount;
    const globalTax = priceIncludesTax ? 0 : Math.round(netAfterCartDiscount * (taxRate / 100));
    const serviceAmount = priceIncludesTax ? 0 : Math.round(netAfterCartDiscount * (serviceRate / 100));
    const taxAmount = perProductTaxTotal + globalTax;
    const grandTotal = netAfterCartDiscount + taxAmount + serviceAmount;

    const subtotal = baseSubtotal;
    const discountAmount = perProductDiscountTotal + cartDiscount;
    return { subtotal, discountAmount, taxAmount, serviceAmount, grandTotal };
}

async function loadSettingsPOS() {
    try {
        const res = await fetch('/api/settings', { cache: 'no-store' });
        if (!res.ok) return;
        appSettings = await res.json();
        const name = appSettings?.storeName || 'POS System';
        try { document.title = name + ' - Kasir'; } catch (e) {}
        const brand = document.getElementById('brandName');
        if (brand) brand.textContent = name;
        const brandLogo = document.getElementById('brandLogo');
        if (brandLogo) {
            if (appSettings?.logoBase64) {
                brandLogo.src = appSettings.logoBase64;
                brandLogo.style.display = 'inline-block';
            } else {
                brandLogo.style.display = 'none';
                brandLogo.src = '';
            }
        }
        // Apply theme color
        const theme = appSettings?.themeColor || '#198754';
        let styleEl = document.getElementById('themeStylePos');
        const css = `
          .navbar { background-color: ${theme} !important; }
          .btn-primary { background-color: ${theme} !important; border-color: ${theme} !important; }
          .form-check-input:checked { background-color: ${theme}; border-color: ${theme}; }
          .badge.bg-secondary { background-color: ${theme} !important; }
        `;
        if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'themeStylePos'; document.head.appendChild(styleEl); }
        styleEl.textContent = css;
        // Refresh favicon: use base64 if available, otherwise use default favicon
        const link = document.querySelector('link[rel="icon"]');
        if (link) {
            const v = Date.now();
            if (appSettings?.faviconBase64) {
                // Use base64 favicon from settings
                link.setAttribute('href', appSettings.faviconBase64);
            } else {
                // Use default favicon with cache busting
                link.setAttribute('href', `/favicon.ico?v=${v}`);
            }
        }
    } catch (e) {
        // ignore
    }
}

async function fetchUserInfo() { 
    if (userNameSpan) {
        userNameSpan.textContent = 'Cashier'; 
    }
}

async function loadCategories() {
    try {
        const res = await fetch('/api/categories', { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load categories');
        categories = await res.json();
        console.log("Categories fetched:", categories.length);
        // populateCategoryDropdown() tidak dipanggil di sini lagi
    } catch (error) {
        console.error("Failed to load categories:", error);
    }
}

function populateCategoryDropdown() {
    if (!categoryDropdownMenu) return;

    const itemsToKeep = categoryDropdownMenu.querySelectorAll('li:first-child, li:nth-child(2)');
    categoryDropdownMenu.innerHTML = '';
    itemsToKeep.forEach(item => categoryDropdownMenu.appendChild(item));

    const hasStockByCategory = new Map();
    products.forEach(p => {
        const cid = p.categoryId;
        if (cid == null) return;
        if (!hasStockByCategory.has(cid)) hasStockByCategory.set(cid, false);
        if ((p.stock || 0) > 0) hasStockByCategory.set(cid, true);
    });

    categories.forEach(category => {
        if (!hasStockByCategory.get(category.id)) return; // only show categories with stock
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.classList.add('dropdown-item');
        a.href = '#';
        a.setAttribute('data-category-id', category.id);
        a.textContent = category.name;
        li.appendChild(a);
        categoryDropdownMenu.appendChild(li);
    });
}

async function loadBanner() {
    try {
        // Periksa pengaturan posShowBanner
        if (appSettings && appSettings.posShowBanner === false) {
            // Jika banner diatur untuk disembunyikan, kosongkan container
            if (bannerContainer) {
                bannerContainer.innerHTML = '';
            }
            return;
        }
        
        const res = await fetch('/api/banner', { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load banner');
        const banner = await res.json();
        const bannerImage = (banner && banner.imageBase64) ? banner.imageBase64 : PLACEHOLDER_IMAGE;
        if (bannerContainer) {
            const title = banner && banner.title ? banner.title : '';
            const subtitle = banner && banner.subtitle ? banner.subtitle : '';
            bannerContainer.innerHTML = `
                <div class="card text-white bg-dark">
                    <img src="${bannerImage}" class="card-img" alt="${title}" style="object-fit: cover; height: 200px;">
                    <div class="card-img-overlay d-flex flex-column justify-content-center">
                        <h2 class="card-title">${title}</h2>
                        <p class="card-text">${subtitle}</p>
                    </div>
                </div>`;
        }
    } catch (error) {
        console.error('Failed to load banner:', error);
    }
}

async function loadQrisImage() {
    try {
        const res = await fetch('/api/qris', { cache: 'no-store' }); 
        const qris = await res.json();
        if (qris && qris.imageBase64) { 
            qrisImageSrc = qris.imageBase64; 
        } else { 
            qrisImageSrc = PLACEHOLDER_IMAGE; 
        }
        const qrisCheckoutImage = document.getElementById('qrisCheckoutImage');
        if (qrisCheckoutImage) {
            qrisCheckoutImage.src = qrisImageSrc;
        }
    } catch (error) { 
        console.error("Failed to load QRIS image:", error); 
    }
}

async function loadCustomers() {
    try {
        const res = await fetch('/api/customers', { cache: 'no-store' });
        if (!res.ok) {
            console.warn('Failed to load customers, using fallback');
            customers = [{ id: 1, name: 'Pelanggan Umum' }];
            populateCustomerSelect();
            return;
        }
        customers = await res.json();
        console.log('Customers loaded:', customers.length);
        populateCustomerSelect();
    } catch (error) {
        console.error('Failed to load customers:', error);
        // Fallback to default customer only
        customers = [{ id: 1, name: 'Pelanggan Umum' }];
        populateCustomerSelect();
    }
}

function populateCustomerSelect() {
    if (!customerSelect) return;

    // Clear existing options except default
    const defaultOption = customerSelect.querySelector('option[value="default"]');
    customerSelect.innerHTML = '';
    customerSelect.appendChild(defaultOption);

    // Add customer options
    customers.forEach(customer => {
        if (customer.id !== 1) { // Skip default customer as it's already added
            const option = document.createElement('option');
            option.value = customer.id.toString();
            option.textContent = customer.name;
            customerSelect.appendChild(option);
        }
    });

    // Set selected customer
    if (selectedCustomer && selectedCustomer.id !== 'default') {
        customerSelect.value = selectedCustomer.id.toString();
    }
    updateCustomerInfo();
}

function updateCustomerInfo() {
    if (!customerInfo) return;

    if (selectedCustomer.id === 'default') {
        customerInfo.innerHTML = `
            <strong>Pelanggan Umum</strong><br>
            <span class="text-muted">Tidak ada informasi tambahan</span>
        `;
    } else {
        const customer = customers.find(c => c.id.toString() === selectedCustomer.id.toString());
        if (customer) {
            customerInfo.innerHTML = (
                '<strong>' + customer.name + '</strong><br>' +
                (customer.phone ? '<span class="text-muted">📱 ' + customer.phone + '</span><br>' : '') +
                (customer.email ? '<span class="text-muted">✉️ ' + customer.email + '</span><br>' : '') +
                (customer.address ? '<span class="text-muted">📍 ' + customer.address + '</span>' : '')
            ).trim();
        }
    }
}

// Gunakan productMap yang sudah dideklarasikan sebelumnya
// var productMap = new Map();

async function loadProducts() {
    try {
        console.log("Fetching products from API...");
        const res = await fetchWithCache('/api/products'); 
        if (!res.ok) { 
            throw new Error(`HTTP error! status: ${res.status}`); 
        }
        const data = await res.json();
        
        // PERBAIKAN: Validasi data produk
        if (!Array.isArray(data)) {
            console.warn('Products data is not an array, using empty array');
            products = [];
        } else {
            products = data;
            
            // OPTIMASI: Buat Map untuk pencarian produk yang lebih cepat
            productMap.clear();
            for (let i = 0; i < products.length; i++) {
                if (products[i] && products[i].id) {
                    productMap.set(products[i].id, products[i]);
                    
                    // Tambahkan SKU dan barcode untuk pencarian cepat
                    if (products[i].sku) {
                        productMap.set(`sku-${products[i].sku}`, products[i]);
                    }
                    if (products[i].barcode) {
                        productMap.set(`barcode-${products[i].barcode}`, products[i]);
                    }
                }
            }
            
            // Reset cache hasil filter
            filteredProductsCache = {};
        }
        
        console.log("Products fetched:", products.length);
        renderProducts();
        populateCategoryDropdown(); // populateCategoryDropdown dipanggil di sini setelah products dimuat
    } catch (error) { 
        console.error("Failed to load products:", error); 
        if (productList) {
            productList.innerHTML = `<div class="col-12"><div class="alert alert-danger">Gagal memuat produk. Silakan refresh halaman atau coba lagi nanti.</div></div>`; 
        }
        // Set empty array to prevent errors
        products = [];
    }
}

function getFilteredProducts() {
    // OPTIMASI: Gunakan caching untuk hasil filter
    const cacheKey = `${searchTerm}_${currentCategory}_${currentFilter}`;
    if (filteredProductsCache[cacheKey]) {
        return filteredProductsCache[cacheKey];
    }
    
    console.log('[FILTER] currentFilter=', currentFilter, 'category=', currentCategory, 'search=', searchTerm);
    let filteredProducts = Array.isArray(products) ? [...products] : [];
    
    // OPTIMASI: Gunakan loop for tradisional untuk performa lebih baik
    if (currentCategory !== 'all') {
        const result = [];
        for (let i = 0; i < filteredProducts.length; i++) {
            const p = filteredProducts[i];
            if (p.categoryId && p.categoryId.toString() === currentCategory) {
                result.push(p);
            }
        }
        filteredProducts = result;
    }

    if (searchTerm) {
        const lowerCaseSearchTerm = searchTerm.toLowerCase();
        const result = [];
        for (let i = 0; i < filteredProducts.length; i++) {
            const product = filteredProducts[i];
            const productNameMatch = product.name && product.name.toLowerCase().includes(lowerCaseSearchTerm);
            
            // OPTIMASI: Gunakan Map untuk lookup kategori
            let categoryNameMatch = false;
            if (product.categoryId) {
                const category = categories.find(c => c.id === product.categoryId);
                categoryNameMatch = category && category.name && category.name.toLowerCase().includes(lowerCaseSearchTerm);
            }
            
            if (productNameMatch || categoryNameMatch) {
                result.push(product);
            }
        }
        filteredProducts = result;
    }

    if (currentFilter === 'top') {
        filteredProducts = filteredProducts.filter(p => p && p.isTopProduct === true);
    } else if (currentFilter === 'best') {
        filteredProducts = filteredProducts.filter(p => p && p.isBestSeller === true);
    } else if (currentFilter === 'discounted') {
        // Use explicit flag; fallback to computed when flag not present
        const byFlag = filteredProducts.filter(p => p && p.isDiscounted === true);
        if (byFlag.length > 0) {
            filteredProducts = byFlag;
        } else {
            const byPercent = (p) => Number(p.discountPercent || 0) > 0;
            const bySalePrice = (p) => {
              const sp = Number(p.salePrice);
              const pr = Number(p.price);
              return Number.isFinite(sp) && Number.isFinite(pr) && sp >= 0 && sp < pr;
            };
            filteredProducts = filteredProducts.filter(p => byPercent(p) || bySalePrice(p));
        }
    }
    console.log('[FILTER] result count=', filteredProducts.length);
    // Sort newest -> oldest by updatedAt/createdAt/date/timestamp/id
    try {
        const ts = v => {
            const cands = [v?.updatedAt, v?.createdAt, v?.created_at, v?.date, v?.timestamp, v?.id];
            for (const x of cands) { if (x != null) { const n = new Date(x).valueOf(); if (!isNaN(n)) return n; if (typeof x === 'number') return x; } }
            return 0;
        };
        filteredProducts.sort((a,b)=> ts(b) - ts(a));
    } catch (e) {}
    
    return filteredProducts;
}

function renderProducts() {
    if (!productList) return;
    
    // Prevent concurrent renders
    if (isRendering) {
        console.warn('Render already in progress, skipping...');
        // Jadwalkan render berikutnya jika ada permintaan bersamaan
        if (!pendingRender) {
            pendingRender = setTimeout(() => {
                pendingRender = null;
                renderProducts();
            }, 100);
        }
        return;
    }
    isRendering = true;

    // OPTIMASI: Gunakan requestAnimationFrame untuk rendering
    requestAnimationFrame(() => {
        // PERBAIKAN: Dispose semua tooltip sebelum render - dengan batching
        try {
            // Batch tooltip disposal untuk performa lebih baik
            if (activeTooltips.length > 0) {
                for (let i = 0; i < activeTooltips.length; i++) {
                    try {
                        if (activeTooltips[i] && typeof activeTooltips[i].dispose === 'function') {
                            activeTooltips[i].dispose();
                        }
                    } catch (e) {}
                }
                activeTooltips = [];
            }
            
            // Optimasi: Hanya dispose tooltip yang terlihat
            const visibleTooltips = document.querySelectorAll('[data-bs-toggle="tooltip"]:hover, [data-bs-toggle="tooltip"]:focus');
            if (visibleTooltips.length > 0) {
                for (let i = 0; i < visibleTooltips.length; i++) {
                    try {
                        const tooltip = bootstrap.Tooltip.getInstance(visibleTooltips[i]); 
                        if (tooltip) tooltip.dispose();
                    } catch (e) {}
                }
            }
        } catch (e) {}

        const filteredProducts = getFilteredProducts();
        
        if (filteredProducts.length === 0) { 
            productList.innerHTML = '<div class="col-12"><p class="text-muted">Produk tidak ditemukan.</p></div>'; 
            isRendering = false;
            return; 
        }
        
        // OPTIMASI: Batasi jumlah produk yang dirender sekaligus untuk menghindari jank
        const maxProductsPerRender = 50;
        const productsToRender = filteredProducts.slice(0, maxProductsPerRender);
        
        productList.innerHTML = productsToRender.map(product => {
        const productId = product.id || 0;
        const productName = product.name || 'Produk Tidak Dikenal';
        const productPriceNum = Number(product.price || 0);
        const productStock = product.stock || 0;
        const productImage = product.imageBase64 || PLACEHOLDER_IMAGE;
        const tooltipContent = '<strong>' + productName + '</strong><img src="' + productImage + '" alt="' + productName + '">';

        const salePriceNum = Number(product.salePrice);
        const discountPercentNum = Number(product.discountPercent || 0);
        let discountedPrice = null;
        if (Number.isFinite(salePriceNum) && Number.isFinite(productPriceNum) && salePriceNum >= 0 && salePriceNum < productPriceNum) {
            discountedPrice = salePriceNum;
        } else if (discountPercentNum > 0 && Number.isFinite(productPriceNum)) {
            discountedPrice = Math.max(0, Math.round(productPriceNum * (1 - (discountPercentNum / 100))));
        }

        const priceHtml = (discountedPrice != null)
          ? '<p class="card-text mb-1"><del>' + formatCurrency(productPriceNum) + '</del> <span class="text-danger fw-semibold ms-1">' + formatCurrency(discountedPrice) + '</span></p>'
          : '<p class="card-text mb-1">' + formatCurrency(productPriceNum) + '</p>';

        const isTop = !!product.isTopProduct;
        const isBest = !!product.isBestSeller;
        const isDiscFlag = !!product.isDiscounted;
        // Determine discount percent for badge label
        let discPct = 0;
        if (discountPercentNum > 0) {
            discPct = Math.round(discountPercentNum);
        } else if (discountedPrice != null && Number.isFinite(productPriceNum) && productPriceNum > 0) {
            const pct = 100 - Math.round((discountedPrice / productPriceNum) * 100);
            discPct = Math.max(0, pct);
        }
        const showDiscBadge = isDiscFlag || (discountedPrice != null);
        const discLabel = discPct > 0 ? 'Diskon ' + discPct + '%' : 'Diskon';
        const badges = '<div class="badge-stack">' + (isTop ? '<span class="badge bg-warning text-dark">TOP</span>' : '') + (isBest ? '<span class="badge bg-primary">BEST</span>' : '') + (showDiscBadge ? '<span class="badge bg-danger">' + discLabel + '</span>' : '') + ((productStock <= 0) ? '<span class="badge bg-secondary">HABIS</span>' : '') + '</div>';
        
        return '<div class="col-md-6 col-lg-4"><div class="card product-card h-100 position-relative" onclick="addToCart(' + productId + ')">' + badges + '<img src="' + productImage + '" class="card-img-top" alt="' + productName + '" data-bs-toggle="tooltip" data-bs-html="true" data-bs-title="' + tooltipContent.replace(/"/g, '&quot;') + '"><div class="card-body"><h5 class="card-title">' + productName + '</h5>' + priceHtml + '<span class="badge bg-secondary">Stock: ' + productStock + '</span></div></div></div>';
    }).join('');

    // PERBAIKAN: Initialize tooltips and track them
    try {
        const newTooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
        newTooltipTriggerList.forEach(function (tooltipTriggerEl) { 
            try {
                const tooltip = new bootstrap.Tooltip(tooltipTriggerEl, { 
                    trigger: 'hover focus', 
                    placement: 'auto', 
                    delay: { "show": 300, "hide": 100 }
                });
                activeTooltips.push(tooltip);
            } catch (e) {
                console.warn('Error creating tooltip:', e);
            }
        });
    } catch (e) {
        console.warn('Error initializing tooltips:', e);
    }
    
    isRendering = false;
});
}

function addToCart(productId) {
    // PERBAIKAN: Validasi produk dan stok
    const product = products.find(p => p.id === productId);
    if (!product) {
        console.warn('Product not found:', productId);
        return;
    }

    // Jika produk memiliki varian harga, tampilkan modal pilihan terlebih dahulu
    if (Array.isArray(product.unitPrices) && product.unitPrices.length > 0) {
        try {
            openVariantSelection(product);
            return; // lanjut setelah user konfirmasi
        } catch (e) {
            console.warn('Variant selection failed, fallback to base price', e);
        }
    }


    // PERBAIKAN: Validasi stok sebelum menambah ke keranjang
    const currentStock = Number(product.stock || 0);
    const existingItem = cart.find(item => item.productId === productId);
    const currentQty = existingItem ? (existingItem.qty || 0) : 0;
    
    if (currentStock <= 0) {
        console.warn('Produk ini habis, tetapi diizinkan untuk ditambahkan ke keranjang.');
        // Diizinkan lanjut
    }
    
    if (currentQty >= currentStock) {
        console.warn(`Qty melebihi stok (${currentStock}). Diizinkan lanjut.`);
        // Diizinkan lanjut
    }
    
    if (existingItem) { 
        existingItem.qty++; 
    } else { 
        cart.push({ 
            productId, 
            name: product.name || 'Unknown Product', 
            price: product.price || 0, 
            qty: 1 
        }); 
    }
    
    // Putar suara notifikasi jika diaktifkan
    if (appSettings && appSettings.enableCartSound && appSettings.cartSoundBase64) {
        try {
            const audio = new Audio(appSettings.cartSoundBase64);
            audio.play();
        } catch (e) {
            console.warn('Gagal memutar suara notifikasi', e);
        }
    }
    
    renderCart();
}

function openVariantSelection(product){
    pendingVariantProduct = product;
    selectedVariantIdx = 0;
    if (!variantSelectModal) {
        const el = document.getElementById('variantSelectModal');
        if (el && window.bootstrap) variantSelectModal = bootstrap.Modal.getOrCreateInstance(el);
    }
    if (!variantOptionsBox) return;
    const opts = (product.unitPrices || []).map((v, idx) => {
        const qty = Number(v.qty || 0);
        const unit = String(v.unit || '').trim();
        const price = Number(v.price || 0);
        const id = 'variant_' + product.id + '_' + idx;
        return '<div class="form-check mb-1"><input class="form-check-input" type="radio" name="variantOption" id="' + id + '" value="' + idx + '" ' + (idx===0?'checked':'') + '><label class="form-check-label" for="' + id + '"><strong>' + qty + ' ' + unit + '</strong> — ' + formatCurrency(price) + '</label></div>';
    }).join('');
    variantOptionsBox.innerHTML = opts || '<p class="text-muted">Tidak ada varian tersedia.</p>';
    // bind change
    variantOptionsBox.querySelectorAll('input[name="variantOption"]').forEach(r=>{
        r.addEventListener('change', (e)=>{ selectedVariantIdx = parseInt(e.target.value)||0; });
    });
    if (confirmVariantBtn && !confirmVariantBtn._bound) {
        confirmVariantBtn._bound = true;
        confirmVariantBtn.addEventListener('click', () => {
            try { applySelectedVariant(); } catch(e) { console.warn(e); }
        });
    }
    if (variantSelectModal) variantSelectModal.show();
}

function applySelectedVariant(){
    if (!pendingVariantProduct) return;
    const product = pendingVariantProduct;
    const list = Array.isArray(product.unitPrices) ? product.unitPrices : [];
    const idx = Math.min(Math.max(0, selectedVariantIdx||0), Math.max(0, list.length-1));
    const chosen = list[idx] || {};
    const variantQty = Number(chosen.qty||1);
    const variantUnit = String(chosen.unit||'');
    const variantPrice = Number(chosen.price||0);

    // Tambahkan sebagai paket: qty item = 1 paket, price = harga paket
    cart.push({
        productId: product.id,
        name: product.name || 'Unknown Product',
        price: variantPrice,
        qty: 1,
        variantQty,
        variantUnit
    });
    if (variantSelectModal) variantSelectModal.hide();
    pendingVariantProduct = null;
    selectedVariantIdx = -1;
    renderCart();
}

// Variabel untuk throttling render cart
var pendingCartRender = null;
var lastCartRenderTime = 0;

function renderCart() {
    if (!cartItems || !cartTotal) return;
    
    // OPTIMASI: Throttle rendering untuk mencegah terlalu banyak render dalam waktu singkat
    const now = Date.now();
    if (now - lastCartRenderTime < 100) {
        // Jika terlalu cepat, jadwalkan render berikutnya
        if (!pendingCartRender) {
            pendingCartRender = setTimeout(() => {
                pendingCartRender = null;
                renderCart();
            }, 100);
        }
        return;
    }
    lastCartRenderTime = now;
    
    // PERBAIKAN: Cleanup event listeners sebelum re-render dengan optimasi
    if (cartEventListeners.length > 0) {
        for (let i = 0; i < cartEventListeners.length; i++) {
            try {
                cartEventListeners[i]();
            } catch (e) {}
        }
        cartEventListeners = [];
    }
    
    if (cart.length === 0) { 
        cartItems.innerHTML = '<p class="text-muted">Keranjang kosong.</p>'; 
        if (cartSubtotalSpan) cartSubtotalSpan.textContent = formatCurrency(0);
        if (cartDiscountSpan) cartDiscountSpan.textContent = formatCurrency(0);
        if (cartTaxSpan) cartTaxSpan.textContent = formatCurrency(0);
        if (cartServiceSpan) cartServiceSpan.textContent = formatCurrency(0);
        cartTotal.textContent = formatCurrency(0); 
        try { 
            // OPTIMASI: Gunakan localStorage hanya jika nilai berubah
            const currentCart = localStorage.getItem('pos_cart');
            if (currentCart !== '[]') {
                localStorage.setItem('pos_cart', '[]'); 
            }
        } catch (e) {}
        return; 
    }
    
    // OPTIMASI: Gunakan DocumentFragment untuk mengurangi reflow
    const fragment = document.createDocumentFragment();
    const tempContainer = document.createElement('div');
    
    // OPTIMASI: Buat HTML string sekali saja daripada map+join
    let cartHtml = '';
    for (let i = 0; i < cart.length; i++) {
        const item = cart[i];
        const itemName = item.name || 'Item Tidak Dikenal';
        const itemPrice = item.price || 0;
        const itemQty = item.qty || 0;
        
        // OPTIMASI: Gunakan Map untuk lookup produk daripada find
        const product = productMap.get(item.productId) || {};
        const productStock = product.stock || 0;
        const variantMeta = (item.variantQty && item.variantUnit) ? '<br><small class="text-muted">Varian: ' + item.variantQty + ' ' + item.variantUnit + '</small>' : '';
        
        cartHtml += '<div class="d-flex justify-content-between align-items-center mb-2"><div><strong>' + itemName + '</strong>' + variantMeta + '<br><small>' + formatCurrency(itemPrice) + ' x ' + itemQty + '</small>' + (productStock < itemQty ? '<br><small class="text-danger">⚠ Stok terbatas</small>' : '') + '</div><div class="d-flex align-items-center gap-1"><button class="btn btn-sm btn-outline-secondary qty-btn" data-action="decrease" data-index="' + i + '">-</button><input type="number" class="form-control form-control-sm text-center qty-input" style="width: 60px; flex-shrink: 0;" min="1" value="' + itemQty + '" data-index="' + i + '"><button class="btn btn-sm btn-outline-secondary qty-btn" data-action="increase" data-index="' + i + '">+</button><button class="btn btn-sm btn-danger ms-2 remove-btn" data-index="' + i + '">&times;</button></div></div>';
    }
    
    tempContainer.innerHTML = cartHtml;
    while (tempContainer.firstChild) {
        fragment.appendChild(tempContainer.firstChild);
    }
    
    // Kosongkan dan tambahkan fragment
    cartItems.innerHTML = '';
    cartItems.appendChild(fragment);
    
    // OPTIMASI: Gunakan event delegation untuk mengurangi jumlah event listener
    const cartClickHandler = (e) => {
        const target = e.target;
        if (target.classList.contains('qty-btn')) {
            const index = parseInt(target.dataset.index);
            if (isNaN(index)) return;
            const action = target.dataset.action;
            updateCartQty(index, action === 'increase' ? 1 : -1);
        } else if (target.classList.contains('remove-btn')) {
            const index = parseInt(target.dataset.index);
            if (isNaN(index)) return;
            removeFromCart(index);
        }
    };
    cartItems.addEventListener('click', cartClickHandler);
    cartEventListeners.push(() => cartItems.removeEventListener('click', cartClickHandler));
    
    // Attach change listeners untuk input
    const qtyInputs = cartItems.querySelectorAll('.qty-input');
    for (let i = 0; i < qtyInputs.length; i++) {
        const input = qtyInputs[i];
        const handler = (e) => {
            const index = parseInt(e.target.dataset.index);
            if (isNaN(index)) return;
            setCartQty(index, e.target.value);
        };
        input.addEventListener('change', handler);
        cartEventListeners.push(() => input.removeEventListener('change', handler));
    }
    
    // OPTIMASI: Hitung total hanya sekali
    const totals = computeTotals();
    if (cartSubtotalSpan) cartSubtotalSpan.textContent = formatCurrency(totals.subtotal);
    if (cartDiscountSpan) cartDiscountSpan.textContent = formatCurrency(totals.discountAmount);
    if (cartTaxSpan) cartTaxSpan.textContent = formatCurrency(totals.taxAmount);
    if (cartServiceSpan) cartServiceSpan.textContent = formatCurrency(totals.serviceAmount);
    cartTotal.textContent = formatCurrency(totals.grandTotal);
    
    // OPTIMASI: Simpan ke localStorage hanya jika perlu
    try {
        const cartJson = JSON.stringify(cart);
        const currentCart = localStorage.getItem('pos_cart');
        if (currentCart !== cartJson) {
            localStorage.setItem('pos_cart', cartJson);
        }
    } catch (e) {}
}

function setCartQty(index, newQty) {
    if (index < 0 || index >= cart.length) return;
    
    const product = products.find(p => p.id === cart[index].productId);
    if (!product) {
        console.warn('Product not found for cart item at index:', index);
        return;
    }
    
    const qty = parseInt(newQty) || 0;
    const maxStock = Number(product.stock || 0);
    
    // PERBAIKAN: Validasi stok
    if (qty <= 0) {
        removeFromCart(index);
    } else {
        // Izinkan qty melebihi stok tanpa membatasi ke maxStock
        cart[index].qty = qty;
        renderCart();
    }
}

function updateCartQty(index, change) {
    if (index < 0 || index >= cart.length) return;
    
    const product = products.find(p => p.id === cart[index].productId);
    if (!product) {
        console.warn('Product not found for cart item at index:', index);
        return;
    }
    
    const currentQty = cart[index].qty || 0;
    const newQty = currentQty + change;
    const maxStock = Number(product.stock || 0);
    
    // PERBAIKAN: Validasi stok
    if (newQty <= 0) { 
        removeFromCart(index); 
        return;
    }
    
    // Izinkan qty melebihi stok tanpa membatasi ke maxStock
    cart[index].qty = newQty;
    
    renderCart();
}

function removeFromCart(index) { 
    if (index < 0 || index >= cart.length) return;
    cart.splice(index, 1); 
    renderCart(); 
}

async function loadDrafts() {
    if (!draftsList) {
        console.warn('draftsList element not found');
        return;
    }
    try {
        const res = await fetch('/api/drafts', { cache: 'no-store' });
        if (!res.ok) {
            console.warn('Failed to fetch drafts, showing empty list');
            drafts = [];
            renderDrafts();
            return;
        }
        const data = await res.json();
        
        // PERBAIKAN: Validasi data drafts
        if (!Array.isArray(data)) {
            console.warn('Drafts data is not an array, using empty array');
            drafts = [];
        } else {
            drafts = data;
        }
        
        console.log('Drafts loaded:', drafts.length);
        renderDrafts();
    } catch (error) {
        console.error("Failed to load drafts:", error);
        drafts = [];
        renderDrafts();
    }
}

function renderDrafts() {
    if (!draftsList) return;
    
    if (drafts.length === 0) { 
        draftsList.innerHTML = `<p class="text-muted">Tidak ada draf tersimpan.</p>`; 
        return; 
    }
    
    let draftsInner = drafts.map(d => {
        const total = d.items.reduce((sum, item) => sum + ((item.price || 0) * (item.qty || 0)), 0);
        return (
            '<div class="list-group-item">' +
                '<div class="d-flex w-100 justify-content-between">' +
                    '<h6 class="mb-1">' + d.items.length + ' Item</h6>' +
                    '<small>' + new Date(d.timestamp).toLocaleString() + '</small>' +
                '</div>' +
                '<p class="mb-1">Total: ' + formatCurrency(total) + '</p>' +
                '<div class="btn-group btn-group-sm" role="group">' +
                    '<button class="btn btn-outline-primary" onclick="loadDraftToCart(\'' + d.id + '\')">Muat</button>' +
                    '<button class="btn btn-outline-danger" onclick="deleteDraft(\'' + d.id + '\')">Hapus</button>' +
                '</div>' +
            '</div>'
        );
    }).join('');
    draftsList.innerHTML = '<div class="list-group">' + draftsInner + '</div>';
}

async function saveDraft() {
    if (cart.length === 0) { 
        alert('Keranjang kosong! Tidak ada yang bisa disimpan.'); 
        return; 
    }
    
    try {
        const res = await fetch('/api/drafts', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ items: cart }) 
        });
        const result = await res.json();

        if (!res.ok) throw new Error(result.message || 'Failed to save draft');

        alert(result.message);
        cart = [];
        renderCart();
        await loadDrafts();
    } catch (error) {
        console.error("Failed to save draft:", error);
        alert(`Gagal menyimpan draf: ${error.message}`);
    }
}

async function loadDraftToCart(draftId) {
    if (!confirm('Memuat draf ini akan mengganti keranjang saat ini. Apakah Anda yakin?')) { return; }
    try {
        const res = await fetch(`/api/drafts/${draftId}/load`, { method: 'PUT' });
        const result = await res.json();

        if (!res.ok) throw new Error(result.message || 'Failed to load draft');

        cart = result.items;
        renderCart();
        
        // Hapus draf dari server agar tidak duplikat ketika disimpan lagi
        try {
            await fetch(`/api/drafts/${draftId}`, { method: 'DELETE' });
        } catch (e) {}
        // Hapus dari array lokal untuk update UI yang cepat, lalu refresh dari server
        drafts = drafts.filter(d => d.id !== draftId);
        renderDrafts();
        try { await loadDrafts(); } catch (e) {}

    } catch (error) {
        console.error("Failed to load draft:", error);
        alert(`Gagal memuat draf: ${error.message}`);
    }
}

async function deleteDraft(draftId) {
    if (!confirm('Apakah Anda yakin ingin menghapus draf ini?')) { return; }
    try {
        const res = await fetch(`/api/drafts/${draftId}`, { method: 'DELETE' });
        const result = await res.json();

        if (!res.ok) throw new Error(result.message || 'Failed to delete draft');

        // Hapus dari array lokal dan render ulang
        drafts = drafts.filter(d => d.id !== draftId);
        renderDrafts();
    } catch (error) {
        console.error("Failed to delete draft:", error);
        alert(`Gagal menghapus draf: ${error.message}`);
    }
}

// --- Functions for Recent Transactions ---
async function loadRecentTransactions() {
    if (!recentTransactionsList) return;
    try {
        const res = await fetch('/api/recent-transactions', { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to fetch recent transactions');
        const recentTransactionsData = await res.json();
        const sorted = Array.isArray(recentTransactionsData)
            ? [...recentTransactionsData].sort((a,b)=> (b.timestamp||0) - (a.timestamp||0))
            : [];
        // Compute best sellers by frequency
        try {
            const freq = new Map();
            (sorted || []).forEach(t => {
                (t.items || []).forEach(it => {
                    const pid = it.productId ?? it.id;
                    if (pid == null) return;
                    freq.set(pid, (freq.get(pid) || 0) + (it.qty || 1));
                });
            });
            const ranked = Array.from(freq.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 24);
            bestSellerIds = new Set(ranked.map(r=>r[0]));
        } catch (e) { bestSellerIds = new Set(); }
        renderRecentTransactions(sorted);
    } catch (error) {
        console.error("Failed to load recent transactions:", error);
        recentTransactionsList.innerHTML = `<p class="text-danger">Gagal memuat transaksi.</p>`;
    }
}

function renderRecentTransactions(transactions) {
    recentTransactions = transactions;
    if (!recentTransactionsList) return;
    
    if (transactions.length === 0) { 
        recentTransactionsList.innerHTML = `<p class="text-muted">Tidak ada transaksi terbaru.</p>`; 
        return; 
    }
    
    const txRows = transactions.map(t => {
        const totalAmount = t.totalAmount || 0;
        const oversellBadge = t.oversell ? ' <span class="badge bg-danger">OVERSELL</span>' : '';
        return (
            '<tr>' +
                '<td>' + t.id + oversellBadge + '</td>' +
                '<td>' + new Date(t.timestamp).toLocaleTimeString() + '</td>' +
                '<td>' + formatCurrency(totalAmount) + '</td>' +
                '<td><button class="btn btn-sm btn-info" onclick="showTransactionDetails(\'' + t.id + '\')">Lihat</button></td>' +
            '</tr>'
        );
    }).join('');
    recentTransactionsList.innerHTML = '<div class="table-responsive">' +
        '<table class="table table-sm table-striped">' +
            '<thead><tr><th>ID</th><th>Waktu</th><th>Total</th><th>Aksi</th></tr></thead>' +
            '<tbody>' + txRows + '</tbody>' +
        '</table>' +
    '</div>';
}

function showTransactionDetails(transactionId) {
    const transaction = recentTransactions.find(t => t.id === transactionId);
    if (!transaction) { 
        console.error('Kesalahan: Transaction not found!'); 
        return; 
    }
    
    transactionToVoidId = transactionId;
    const itemsHtml = transaction.items.map(item => {
        const itemName = item.name || 'Item Tidak Dikenal';
        const itemPrice = item.price || 0;
        const itemQty = item.qty || 0;
        const itemSubtotal = item.subtotal || (itemPrice * itemQty);
        
        return `<tr>
            <td>${itemName}</td>
            <td>${formatCurrency(itemPrice)}</td>
            <td>${itemQty}</td>
            <td>${formatCurrency(itemSubtotal)}</td>
        </tr>`;
    }).join('');
    
    const transactionDetailsContent = document.getElementById('transactionDetailsContent');
    if (transactionDetailsContent) {
        const totalAmount = transaction.totalAmount || 0;
        transactionDetailsContent.innerHTML = `
        <p><strong>ID Transaksi</strong> ${transaction.id}</p>
        <p><strong>Tanggal & Waktu</strong> ${new Date(transaction.timestamp).toLocaleString()}</p>
        <p><strong>Pelanggan</strong> ${transaction.customerName || 'Pelanggan Umum'}</p>
        ${transaction.oversell ? '<p class="text-danger"><strong>Perhatian:</strong> Transaksi ini melewati stok yang tersedia.</p>' : ''}
        <hr>
        <div class="table-responsive">
            <table class="table">
                <thead><tr><th>Produk</th><th>Harga</th><th>Jml</th><th>Subtotal</th></tr></thead>
                <tbody>${itemsHtml}</tbody>
                <tfoot><tr><th colspan="3">Total</th><th>${formatCurrency(totalAmount)}</th></tr></tfoot>
            </table>
        </div>`;
    }
    if (transactionDetailsModal) transactionDetailsModal.show();
}

function printReceipt(transaction) {
    return new Promise((resolve, reject) => {
    try {
        const paperWidth = parseInt(appSettings?.paperWidth) || 80;
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
        const widthMm = paperWidth + 'mm';
        const showAddr = appSettings?.showReceiptAddress !== false;
        const showPhone = appSettings?.showReceiptPhone !== false;
        const showFooter = appSettings?.showReceiptFooter !== false;

        // Container hidden off-screen for html2pdf rendering
        const container = document.createElement('div');
        // Keep it in the layout but far off-screen (not display:none / visibility:hidden)
        container.style.position = 'absolute';
        container.style.left = '-10000px';
        container.style.top = '-10000px';
        container.style.width = widthMm;
        container.style.background = '#fff';

        const style = document.createElement('style');
        style.textContent = `
            .receipt { width: 100%; margin: 0 auto; font-family: 'Courier New', Courier, monospace; font-size: ${fontSize}; color: #000; background: #ffffff; }
            .receipt h1 { text-align: center; margin: 6px 0 0 0; }
            .details { margin: 20px 0; }
            .details p { margin: 5px 0; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px dashed #000; padding: 8px; text-align: left; }
            th { border-bottom: 2px solid #000; }
            .total { border-top: 2px solid #000; font-weight: bold; }
            .footer { margin-top: 30px; text-align: center; font-size: ${footerFontSize}; }
        `;

        const itemsRows = (transaction.items || []).map(item => {
            const itemName = item.name || 'Item Tidak Dikenal';
            const itemPrice = item.price || 0;
            const itemQty = item.qty || 0;
            const itemSubtotal = item.subtotal || (itemPrice * itemQty);
            return '<tr><td>' + itemName + '</td><td>' + formatCurrency(itemPrice) + '</td><td>' + itemQty + '</td><td>' + formatCurrency(itemSubtotal) + '</td></tr>';
        }).join('');

        const receipt = document.createElement('div');
        receipt.className = 'receipt';
        receipt.innerHTML = (
            '<div style="text-align:center; margin-bottom: 8px;">'
            + (appSettings?.logoBase64 ? ('<img src="' + appSettings.logoBase64 + '" style="max-height:60px; object-fit:contain;" />') : '')
            + '<h1>' + (appSettings?.storeName || 'STRUK PENJUALAN') + '</h1>'
            + '</div>'
            + '<div class="details">'
            + '<p><strong>ID Transaksi:</strong> ' + transaction.id + '</p>'
            + '<p><strong>Tanggal:</strong> ' + new Date(transaction.timestamp).toLocaleDateString() + '</p>'
            + '<p><strong>Pelanggan:</strong> ' + (transaction.customerName || 'Pelanggan Umum') + '</p>'
            + (showAddr && appSettings?.address ? ('<p><strong>Alamat:</strong> ' + appSettings.address + '</p>') : '')
            + (showPhone && appSettings?.phone ? ('<p><strong>Telepon:</strong> ' + appSettings.phone + '</p>') : '')
            + '</div>'
            + '<table><thead><tr><th>Item</th><th>Harga</th><th>Jml</th><th>Total</th></tr></thead><tbody>'
            + itemsRows
            + '</tbody><tfoot>'
            + (typeof transaction.subtotal === 'number' ? ('<tr><td colspan="3">Subtotal</td><td>' + formatCurrency(transaction.subtotal) + '</td></tr>') : '')
            + (typeof transaction.discountAmount === 'number' && transaction.discountAmount > 0 ? ('<tr><td colspan="3">Diskon</td><td>- ' + formatCurrency(transaction.discountAmount) + '</td></tr>') : '')
            + (typeof transaction.taxAmount === 'number' && transaction.taxAmount > 0 ? ('<tr><td colspan="3">Pajak</td><td>' + formatCurrency(transaction.taxAmount) + '</td></tr>') : '')
            + (typeof transaction.serviceAmount === 'number' && transaction.serviceAmount > 0 ? ('<tr><td colspan="3">Layanan</td><td>' + formatCurrency(transaction.serviceAmount) + '</td></tr>') : '')
            + '<tr class="total"><td colspan="3">TOTAL</td><td>' + formatCurrency(transaction.totalAmount || 0) + '</td></tr>'
            + '</tfoot></table>'
            + '<div class="details">'
            + '<p><strong>Metode Pembayaran:</strong> ' + (transaction.paymentMethod ? transaction.paymentMethod.toUpperCase() : 'UNKNOWN') + '</p>'
            + (transaction.paymentMethod === 'cash' ? ('<p><strong>Jumlah Diterima:</strong> ' + formatCurrency(transaction.amountReceived || 0) + '</p><p><strong>Kembalian:</strong> ' + formatCurrency(transaction.change || 0) + '</p>') : '')
            + '</div>'
            + (showFooter ? ('<div class="footer"><p>' + (appSettings?.receiptFooter || 'Terima kasih atas pembelian Anda!') + '</p>' + (((appSettings?.receiptFooter1 && appSettings.receiptFooter1.trim()) ? ('<p>' + appSettings.receiptFooter1 + '</p>') : '')) + '</div>') : '')
        );

        container.appendChild(style);
        container.appendChild(receipt);
        document.body.appendChild(container);

        // Ensure images (like logo) are loaded before rendering to PDF
        const waitImages = (rootEl) => {
            try {
                const imgs = Array.from(rootEl.querySelectorAll('img'));
                if (!imgs.length) return Promise.resolve();
                return Promise.all(imgs.map(img => img.complete ? Promise.resolve() : new Promise(res => {
                    const done = () => { img.onload = null; img.onerror = null; res(); };
                    img.onload = done; img.onerror = done;
                })));
            } catch { return Promise.resolve(); }
        };

        waitImages(receipt).then(async () => {
            try {
                // Use html2canvas (global from html2pdf bundle) and jsPDF
                const jsPDFCtor = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF : (window.jsPDF || null);
                const h2c = window.html2canvas || (window.html2pdf && window.html2pdf.html2canvas) || (window.html2pdf && window.html2pdf().html2canvas);
                if (!jsPDFCtor || !h2c) throw new Error('html2canvas/jsPDF not available');

                const canvas = await h2c(receipt, {
                    scale: 2,
                    useCORS: true,
                    backgroundColor: '#ffffff',
                    width: paperWidth,
                    windowWidth: paperWidth
                });
                // Detect if canvas is blank (mostly white). Sample a grid to avoid heavy getImageData.
                const ctx = canvas.getContext('2d');
                const sample = 20; // 20x20 grid samples
                let white = 0, total = 0;
                for (let y = 0; y < canvas.height; y += Math.max(1, Math.floor(canvas.height / sample))) {
                    for (let x = 0; x < canvas.width; x += Math.max(1, Math.floor(canvas.width / sample))) {
                        const d = ctx.getImageData(x, y, 1, 1).data;
                        // consider near white
                        if (d[0] > 245 && d[1] > 245 && d[2] > 245) white++;
                        total++;
                    }
                }
                const whiteRatio = white / Math.max(1, total);
                if (whiteRatio > 0.98) throw new Error('Canvas appears blank (whiteRatio=' + whiteRatio.toFixed(3) + ')');

                const imgData = canvas.toDataURL('image/jpeg', 0.98);
                const hPx = canvas.height;
                const heightMm = Math.max(40, Math.ceil(hPx / 3.78));
                const doc = new jsPDFCtor({ unit: 'mm', format: [paperWidth, heightMm], orientation: 'portrait' });
                // Fit width exactly
                doc.addImage(imgData, 'JPEG', 0, 0, paperWidth, heightMm);
                doc.save('receipt_' + transaction.id + '.pdf');
                try { document.body.removeChild(container); } catch (e) {}
                resolve();
                return 'done';
            } catch (primaryErr) {
                console.warn('[PDF] primary canvas->jsPDF failed, trying html2pdf path:', primaryErr);
                // Secondary: try html2pdf if available
                if (typeof html2pdf !== 'undefined') {
                    try {
                        const opt = {
                            margin: 0,
                            filename: 'receipt_' + transaction.id + '.pdf',
                            image: { type: 'jpeg', quality: 0.98 },
                            html2canvas: { 
                                scale: 1.5, 
                                useCORS: true, 
                                backgroundColor: '#ffffff',
                                width: paperWidth,
                                windowWidth: paperWidth
                            },
                            jsPDF: { unit: 'mm', format: [paperWidth, heightMm], orientation: 'portrait' }
                        };
                        await html2pdf().set(opt).from(receipt).save();
                    } catch (e2) {
                        console.warn('[PDF] html2pdf path failed:', e2);
                    }
                }
                reject(primaryErr);
            }
        }).then(() => {
            try { document.body.removeChild(container); } catch (e) {}
        }).catch((err) => {
            try { document.body.removeChild(container); } catch (e) {}
            reject(err);
        });
    } catch (e) {
        reject(e);
    }
    });
}

// Fallback: generate PDF using jsPDF text rendering (no html2canvas)
async function generateReceiptPDF_FallbackJSPDF(transaction) {
    try {
        const jsPDFCtor = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF : (window.jsPDF || null);
        if (!jsPDFCtor) throw new Error('jsPDF not available');
        const paperWidth = parseInt(appSettings?.paperWidth) || 80; // mm
        const doc = new jsPDFCtor({ unit: 'mm', format: [paperWidth, 297], orientation: 'portrait' });
        const margin = 4;
        let y = margin;
        const line = (txt, size = 10, bold = false) => {
            doc.setFont('helvetica', bold ? 'bold' : 'normal');
            doc.setFontSize(size);
            doc.text(String(txt || ''), margin, y);
            y += 5;
        };
        // Header
        if (appSettings?.storeName) { line(appSettings.storeName, 12, true); } else { line('STRUK PENJUALAN', 12, true); }
        line('ID: ' + transaction.id, 9);
        line('Tanggal: ' + new Date(transaction.timestamp).toLocaleString(), 9);
        line('Pelanggan: ' + (transaction.customerName || 'Pelanggan Umum'), 9);
        if (appSettings?.showReceiptAddress !== false && appSettings?.address) line('Alamat: ' + appSettings.address, 8);
        if (appSettings?.showReceiptPhone !== false && appSettings?.phone) line('Telepon: ' + appSettings.phone, 8);
        y += 2;
        // Table header
        line('Item                Harga     Jml   Total', 9, true);
        line('-------------------------------------------', 9);
        (transaction.items || []).forEach(it => {
            const name = (it.name || '').toString().slice(0, 16).padEnd(16, ' ');
            const price = (it.price || 0);
            const qty = (it.qty || 0);
            const sub = (it.subtotal != null ? it.subtotal : (price * qty));
            const row = name + ' ' + (formatCurrency(price).replace(/\s/g,'')).padStart(8, ' ') + ' ' + String(qty).padStart(3,' ') + ' ' + (formatCurrency(sub).replace(/\s/g,'')).padStart(8,' ');
            line(row, 8);
        });
        line('-------------------------------------------', 9);
        if (typeof transaction.subtotal === 'number') line('Subtotal: ' + formatCurrency(transaction.subtotal), 9);
        if (typeof transaction.discountAmount === 'number' && transaction.discountAmount > 0) line('Diskon: -' + formatCurrency(transaction.discountAmount), 9);
        if (typeof transaction.taxAmount === 'number' && transaction.taxAmount > 0) line('Pajak: ' + formatCurrency(transaction.taxAmount), 9);
        if (typeof transaction.serviceAmount === 'number' && transaction.serviceAmount > 0) line('Layanan: ' + formatCurrency(transaction.serviceAmount), 9);
        line('TOTAL: ' + formatCurrency(transaction.totalAmount || 0), 11, true);
        y += 2;
        line('Metode: ' + (transaction.paymentMethod ? transaction.paymentMethod.toUpperCase() : 'UNKNOWN'), 9);
        if (transaction.paymentMethod === 'cash') {
            line('Diterima: ' + formatCurrency(transaction.amountReceived || 0), 9);
            line('Kembali: ' + formatCurrency(transaction.change || 0), 9);
        }
        if (appSettings?.showReceiptFooter !== false) {
            y += 2;
            if (appSettings?.receiptFooter) line(appSettings.receiptFooter, 8);
            if (appSettings?.receiptFooter1 && appSettings.receiptFooter1.trim()) line(appSettings.receiptFooter1, 8);
        }
        // Adjust page height to used content
        const usedHeight = Math.max(40, y + margin);
        try { doc.internal.pageSize.setHeight(usedHeight); } catch (e) {}
        doc.save('receipt_' + transaction.id + '.pdf');
    } catch (e) {
        console.error('jsPDF fallback failed:', e);
        throw e;
    }
}

async function sendReceiptToWA(transaction) {
    try {
        await generateReceiptPDF(transaction);
        const pdfUrl = 'receipt_' + transaction.id + '.pdf'; // This will be downloaded
        const message = 'Struk pembelian dari ' + (appSettings?.storeName || 'Toko Kami') + '\nID Transaksi: ' + transaction.id + '\nTotal: ' + formatCurrency(transaction.totalAmount || 0) + '\n\nFile PDF struk telah didownload. Silakan bagikan ke WhatsApp.';
        const waUrl = 'https://wa.me/?text=' + encodeURIComponent(message);
        window.open(waUrl, '_blank');
    } catch (error) {
        console.error('Error generating PDF:', error);
        // Try fallback
        try {
            await generateReceiptPDF_FallbackJSPDF(transaction);
            const message = 'Struk pembelian dari ' + (appSettings?.storeName || 'Toko Kami') + '\nID Transaksi: ' + transaction.id + '\nTotal: ' + formatCurrency(transaction.totalAmount || 0) + '\n\nFile PDF struk telah didownload (fallback). Silakan bagikan ke WhatsApp.';
            const waUrl = 'https://wa.me/?text=' + encodeURIComponent(message);
            window.open(waUrl, '_blank');
        } catch (e2) {
            console.error('Fallback PDF failed:', e2);
            alert('Gagal membuat PDF struk.');
        }
    }
}

function startNewTransaction() {
    const isConfirmed = confirm('Apakah Anda yakin ingin memulai transaksi baru? Keranjang saat ini akan dikosongkan.');
    if (isConfirmed) {
        // Menggunakan location.reload() adalah cara termudah untuk mereset semua state
        try { localStorage.removeItem('pos_cart'); } catch (e) {}
        window.location.reload();
    } else {
        // Tutup modal jika ada
        if (paymentSuccessModal) paymentSuccessModal.hide();
    }
}

// --- POS Settings Functions ---
function loadPosSettingsToModal() {
    if (!appSettings) return;
    
    if (posPaperWidth) posPaperWidth.value = String(appSettings.paperWidth || 80);
    if (posStoreName) posStoreName.value = appSettings.storeName || '';
    if (posShowAddress) posShowAddress.checked = appSettings.showReceiptAddress !== false;
    if (posShowPhone) posShowPhone.checked = appSettings.showReceiptPhone !== false;
    if (posShowFooter) posShowFooter.checked = appSettings.showReceiptFooter !== false;
}

async function savePosSettingsFromModal() {
    const paperWidth = parseInt(posPaperWidth.value) || 80;
    const storeName = posStoreName.value.trim();
    const showAddress = posShowAddress.checked;
    const showPhone = posShowPhone.checked;
    const showFooter = posShowFooter.checked;

    try {
        const payload = {
            paperWidth,
            storeName,
            showReceiptAddress: showAddress,
            showReceiptPhone: showPhone,
            showReceiptFooter: showFooter
        };

        const res = await fetch('/api/settings', { 
            method: 'PUT', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        });

        const result = await res.json();
        if (!res.ok) throw new Error(result.message || 'Failed to save settings');

        // Update local appSettings
        appSettings = { ...appSettings, ...payload };

        // Update UI elements that depend on settings
        const name = appSettings?.storeName || 'POS System';
        try { document.title = name + ' - Kasir'; } catch (e) {}
        const brand = document.getElementById('brandName');
        if (brand) brand.textContent = name;

        posSettingsModal.hide();
        alert('Settings saved successfully!');
    } catch (error) {
        console.error('Failed to save POS settings:', error);
        alert('Failed to save settings: ' + error.message);
    }
}

function openCheckoutModal() {
    if (cart.length === 0) {
        alert('Keranjang belanja kosong!');
        return;
    }

    const totals = computeTotals();
    if (modalTotal) {
        modalTotal.textContent = formatCurrency(totals.grandTotal);
    }
    
    // Reset amount received and change
    if (amountReceivedInput) {
        amountReceivedInput.value = '';
    }
    if (changeAmountSpan) {
        changeAmountSpan.textContent = 'Rp 0';
    }
    
    // Show cash payment section by default
    if (cashPaymentSection) {
        cashPaymentSection.style.display = 'block';
    }
    if (qrisPaymentSection) {
        qrisPaymentSection.style.display = 'none';
    }
    
    // Set cash as default payment method
    const cashRadio = document.getElementById('payCash');
    if (cashRadio) {
        cashRadio.checked = true;
    }
    
    if (checkoutModal) {
        checkoutModal.show();
    }
}

function setupEventListeners() {
    // PERBAIKAN: Debounce search input untuk performa lebih baik
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            searchTerm = e.target.value;
            
            // Clear existing timer
            if (searchDebounceTimer) {
                clearTimeout(searchDebounceTimer);
            }
            
            // Set new timer - render setelah 300ms tidak ada input
            searchDebounceTimer = setTimeout(() => {
                renderProducts();
            }, 300);
        });
    }

    if (clearSearchBtn) {
        clearSearchBtn.addEventListener('click', () => {
            // PERBAIKAN: Clear debounce timer saat clear
            if (searchDebounceTimer) {
                clearTimeout(searchDebounceTimer);
                searchDebounceTimer = null;
            }
            searchInput.value = '';
            searchTerm = '';
            renderProducts();
        });
    }

    if (categoryDropdownMenu) {
        categoryDropdownMenu.addEventListener('click', (e) => {
            e.preventDefault();
            if (e.target.classList.contains('dropdown-item')) {
                const categoryId = e.target.getAttribute('data-category-id');
                currentCategory = categoryId;
                
                if (categoryDropdownToggle) {
                    categoryDropdownToggle.innerHTML = '<i class="bi bi-funnel"></i> ' + e.target.textContent;
                }
                renderProducts();
            }
        });
    }

    if (resetCategoryBtn) {
        resetCategoryBtn.addEventListener('click', () => {
            currentCategory = 'all';
            searchTerm = '';
            if (searchInput) searchInput.value = '';
            if (categoryDropdownToggle) {
                categoryDropdownToggle.innerHTML = '<i class="bi bi-funnel"></i> <span>Category</span>';
            }
            renderProducts();
        });
    }

    if (saveDraftBtn) {
        saveDraftBtn.addEventListener('click', saveDraft);
    }

    // Checkout button
    if (checkoutBtn) {
        checkoutBtn.addEventListener('click', openCheckoutModal);
    }

    // Transfer total amount to amount received
    if (transferTotalBtn) {
        transferTotalBtn.addEventListener('click', () => {
            console.log('Transfer button clicked');
            const totalText = modalTotal ? modalTotal.textContent : '0';
            console.log('Total text:', totalText);
            // Extract numeric value from currency format (e.g., "Rp 1.500" -> 1500)
            const numericValue = totalText.replace(/[^\d]/g, '');
            const totalAmount = parseInt(numericValue) || 0;
            console.log('Total amount:', totalAmount);
            if (amountReceivedInput) {
                amountReceivedInput.value = totalAmount;
                console.log('Amount received input set to:', amountReceivedInput.value);
                // Trigger change event to update change amount
                amountReceivedInput.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                console.log('Amount received input not found');
            }
        });
    } else {
        console.log('Transfer button not found');
    }

    // Fallback: Try to bind transfer button after DOM is ready
    setTimeout(() => {
        const btn = document.getElementById('transferTotalBtn');
        if (btn && !btn._transferBound) {
            btn._transferBound = true;
            btn.addEventListener('click', () => {
                console.log('Fallback: Transfer button clicked');
                const totalText = modalTotal ? modalTotal.textContent : '0';
                console.log('Fallback: Total text:', totalText);
                const numericValue = totalText.replace(/[^\d]/g, '');
                const totalAmount = parseInt(numericValue) || 0;
                console.log('Fallback: Total amount:', totalAmount);
                if (amountReceivedInput) {
                    amountReceivedInput.value = totalAmount;
                    console.log('Fallback: Amount received input set to:', amountReceivedInput.value);
                    amountReceivedInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
            });
            console.log('Fallback: Transfer button event bound');
        }
    }, 1000);

    // Amount received input change event
    if (amountReceivedInput) {
        amountReceivedInput.addEventListener('input', () => {
            const totalText = modalTotal ? modalTotal.textContent : '0';
            const totalNumeric = totalText.replace(/[^\d]/g, '');
            const totalAmount = parseInt(totalNumeric) || 0;
            const receivedAmount = parseInt(amountReceivedInput.value) || 0;
            const change = receivedAmount - totalAmount;
            
            if (changeAmountSpan) {
                changeAmountSpan.textContent = formatCurrency(change);
            }
        });
    }

    // Product filter buttons
    function updateFilterButtons() {
        const btns = [filterAllBtn, filterTopBtn, filterBestBtn, filterDiscountedBtn];
        btns.forEach(b => { if (b) b.classList.remove('active'); });
        if (currentFilter === 'all' && filterAllBtn) filterAllBtn.classList.add('active');
        if (currentFilter === 'top' && filterTopBtn) filterTopBtn.classList.add('active');
        if (currentFilter === 'best' && filterBestBtn) filterBestBtn.classList.add('active');
        if (currentFilter === 'discounted' && filterDiscountedBtn) filterDiscountedBtn.classList.add('active');
    }
    function setFilter(f) { currentFilter = f; console.log('[FILTER] set to', f); renderProducts(); updateFilterButtons(); }
    if (filterAllBtn) filterAllBtn.addEventListener('click', (e) => { e.preventDefault(); setFilter('all'); });
    if (filterTopBtn) filterTopBtn.addEventListener('click', (e) => { e.preventDefault(); setFilter('top'); });
    if (filterBestBtn) filterBestBtn.addEventListener('click', (e) => { e.preventDefault(); setFilter('best'); });
    if (filterDiscountedBtn) filterDiscountedBtn.addEventListener('click', (e) => { e.preventDefault(); setFilter('discounted'); });
    updateFilterButtons();
    if (sidebarToggleBtn) {
        sidebarToggleBtn.addEventListener('click', () => {
            const cartContainer = document.querySelector('.pos-cart-container');
            if (cartContainer) cartContainer.classList.toggle('is-open');
        });
    }
}

// ... (rest of the code remains the same)
