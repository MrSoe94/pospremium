// Manual refresh helper
async function refreshCartFromServer() {
  try {
    const r = await fetch("/api/cart", { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json().catch(() => ({ items: [], updatedAt: 0 }));
    const serverTs = Number(data.updatedAt || 0);
    cart = Array.isArray(data.items) ? data.items : [];
    lastLocalCartAt = serverTs;
    lastServerCartAt = serverTs;
    try {
      localStorage.setItem("pos_cart", JSON.stringify(cart));
      localStorage.setItem("pos_cart_updatedAt", String(serverTs));
    } catch {}

    function applySyncMode(mode) {
      try {
        if (mode === "realtime") {
          startCartSSE();
          startCartAutoRefresh(1000);
        } else {
          // manual
          stopCartSSE();
          stopCartAutoRefresh();
        }
      } catch {}
    }
    suppressCartSave = true;
    try {
      renderCart();
    } finally {
      suppressCartSave = false;
    }
  } catch {}
}

// Last synced indicator (disabled)
function updateLastSyncedInfo() {
  return;
}

// --- USB Scanner Handling ---
let usbScannerEnabled = false;
let usbScanBuffer = "";
let usbScanTimer = null;
function setUsbScannerEnabled(on) {
  usbScannerEnabled = !!on;
  try {
    localStorage.setItem("pos_usb_scanner", usbScannerEnabled ? "1" : "0");
  } catch {}
  if (scannerToggle) scannerToggle.checked = usbScannerEnabled;
  if (scannerStatus)
    scannerStatus.textContent = usbScannerEnabled
      ? "USB Scanner: Aktif"
      : "USB Scanner: Nonaktif";
}

// SSE real-time updates (disabled/no-op)
let cartEventSource = null;
function startCartSSE() {
  return;
}
function stopCartSSE() {
  return;
}

function forceCloseCameraUI() {
  try {
    autoRescanEnabled = false;
  } catch {}
  try {
    // Hide modal if present
    const modalEl = document.getElementById("cameraScannerModal");
    if (modalEl && window.bootstrap && typeof bootstrap.Modal !== "undefined") {
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      try {
        modal.hide();
      } catch {}
    }
  } catch {}
  try {
    // Remove overlay if present
    const ov = document.getElementById("cameraScannerOverlay");
    if (ov && ov.parentNode) ov.remove();
  } catch {}
  try {
    // Remove lingering bootstrap backdrops (safety)
    document.querySelectorAll(".modal-backdrop").forEach((el) => {
      try {
        el.remove();
      } catch {}
    });
  } catch {}
  try {
    // Ensure video element detached
    const v = document.getElementById("cameraScannerVideo");
    if (v) {
      try {
        v.srcObject = null;
      } catch {}
    }
  } catch {}
  try {
    stopCameraScanner();
  } catch {}
}

// Open camera in overlay (extracted helper)
async function openOverlayCamera() {
  try {
    let overlay = document.getElementById("cameraScannerOverlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "cameraScannerOverlay";
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

    const videoEl =
      overlay.querySelector("#cameraScannerVideo") ||
      document.getElementById("cameraScannerVideo");
    if (!videoEl) {
      alert("Video element tidak ditemukan");
      return;
    }

    const closeBtn =
      overlay.querySelector("#closeCameraScannerBtn") ||
      document.getElementById("closeCameraScannerBtn");
    if (closeBtn) {
      closeBtn.onclick = () => {
        autoRescanEnabled = false; // user manual close disables auto-rescan
        stopCameraScanner();
        const ov = document.getElementById("cameraScannerOverlay");
        if (ov && ov.parentNode) ov.remove();
      };
    }

    // Ensure video element has required attributes for mobile
    videoEl.setAttribute("playsinline", "");
    videoEl.setAttribute("webkit-playsinline", "");
    videoEl.setAttribute("width", "100%");
    videoEl.setAttribute("height", "auto");
    videoEl.muted = true;
    videoEl.playsInline = true;

    // Try to get camera
    let constraints = {
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    };
    try {
      camStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      try {
        constraints = {
          video: {
            facingMode: { ideal: "user" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        };
        camStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e2) {
        try {
          camStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        } catch (e3) {
          alert("Gagal mengakses kamera.");
          const ov = document.getElementById("cameraScannerOverlay");
          if (ov && ov.parentNode) ov.remove();
          return;
        }
      }
    }

    videoEl.srcObject = camStream;
    try {
      videoEl.load();
    } catch {}
    try {
      if (videoEl.readyState < 2) {
        await new Promise((resolve) => {
          const onCanPlay = () => {
            videoEl.removeEventListener("canplay", onCanPlay);
            resolve();
          };
          videoEl.addEventListener("canplay", onCanPlay);
          setTimeout(() => {
            videoEl.removeEventListener("canplay", onCanPlay);
            resolve();
          }, 1500);
        });
      }
      if (videoEl.paused) await videoEl.play();
    } catch (playError) {
      console.warn("Autoplay blocked", playError);
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
            if (text === lastCamScan.text && now - lastCamScan.time < 1500)
              return;
            lastCamScan = { text, time: now };
            handleScannedCode(text);
          }
        });
      } else if (
        await startNativeDetector(videoEl, (text) => {
          const t = String(text);
          const now = Date.now();
          if (t === lastCamScan.text && now - lastCamScan.time < 1500) return;
          lastCamScan = { text: t, time: now };
          handleScannedCode(t);
        })
      ) {
        // started native detector
      } else {
        alert(
          "Scanner tidak tersedia (ZXing gagal dimuat dan BarcodeDetector tidak didukung)."
        );
        stopCameraScanner();
        const ov = document.getElementById("cameraScannerOverlay");
        if (ov && ov.parentNode) ov.remove();
        return;
      }
      cameraTarget = "overlay";
    } catch (e) {
      alert("Inisialisasi pemindai gagal: " + (e.message || e));
      await stopCameraScanner();
      const ov = document.getElementById("cameraScannerOverlay");
      if (ov && ov.parentNode) ov.remove();
    }
  } catch (e) {
    alert("Gagal membuka kamera: " + (e.message || e));
  }
}

// Build POS-side view of customer debts (partial & unpaid) above Recent Transactions
function updatePosCustomerDebts(transactions) {
  if (!posCustomerDebtsSummary) return;

  if (!Array.isArray(transactions) || transactions.length === 0) {
    posCustomerDebtsSummary.innerHTML =
      '<p class="text-muted mb-0">Tidak ada hutang customer aktif.</p>';
    return;
  }

  const debts = [];

  for (const t of transactions) {
    const totalAmount = Number(t.totalAmount || 0) || 0;
    if (!totalAmount) continue;

    const hasExplicitDebt = t.paidAmount != null || t.remainingAmount != null;
    const isImplicitPartialCash = !hasExplicitDebt &&
      t.paymentMethod === 'cash' &&
      t.customerId && t.customerId !== 'default' &&
      Number(t.change || 0) < 0;

    if (!hasExplicitDebt && !isImplicitPartialCash) continue;

    let paidAmount = Number(t.paidAmount || 0) || 0;
    let remainingAmount = Number(t.remainingAmount || 0) || 0;

    if (isImplicitPartialCash) {
      const amountReceived = Number(t.amountReceived || 0) || 0;
      paidAmount = amountReceived;
      remainingAmount = Math.max(0, totalAmount - paidAmount);
    } else if (!isImplicitPartialCash && remainingAmount === 0 && totalAmount && paidAmount && paidAmount < totalAmount) {
      remainingAmount = totalAmount - paidAmount;
    }

    // Hanya tampilkan jika masih ada sisa hutang atau pembayaran sebagian
    if (remainingAmount <= 0 && !isImplicitPartialCash) continue;

    const status = remainingAmount === 0
      ? 'Lunas'
      : (paidAmount > 0 ? 'Hutang (Bayar Sebagian)' : 'Belum Bayar');

    debts.push({
      id: t.id,
      customerName: t.customerName || 'Unknown',
      date: t.timestamp ? new Date(t.timestamp).toLocaleDateString('id-ID') : '-',
      totalAmount,
      paidAmount,
      remainingAmount,
      status,
    });
  }

  if (!debts.length) {
    posCustomerDebtsSummary.innerHTML =
      '<p class="text-muted mb-0">Tidak ada hutang customer aktif.</p>';
    return;
  }

  // Simpan ke variabel global agar bisa dipakai modal pembayaran
  posCustomerDebts = debts;

  const rows = debts.slice(0, 10).map((d) => `
    <tr>
      <td>${d.customerName}</td>
      <td>${d.id}</td>
      <td class="text-end">${formatCurrency(d.totalAmount)}</td>
      <td class="text-end">${formatCurrency(d.paidAmount)}</td>
      <td class="text-end">${formatCurrency(d.remainingAmount)}</td>
      <td><span class="badge ${d.status === 'Lunas' ? 'bg-success' : (d.status.includes('Sebagian') ? 'bg-warning text-dark' : 'bg-danger')}">${d.status}</span></td>
      <td class="text-end">
        <button class="btn btn-sm btn-success me-1" onclick="openPosCustomerPayment('${d.id}')">Bayar</button>
        <button class="btn btn-sm btn-outline-info" onclick="showPosCustomerDebtDetails('${d.id}')">Detail</button>
      </td>
    </tr>
  `).join('');

  posCustomerDebtsSummary.innerHTML = `
    <div class="table-responsive">
      <table class="table table-sm mb-2">
        <thead>
          <tr>
            <th>Customer</th>
            <th>ID</th>
            <th class="text-end">Tagihan</th>
            <th class="text-end">Dibayar</th>
            <th class="text-end">Sisa</th>
            <th>Status</th>
            <th class="text-end">Aksi</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      <small class="text-muted">Menampilkan hingga 10 hutang terbaru.</small>
    </div>
  `;
}

// Tampilkan modal pembayaran piutang langsung di halaman POS
function openPosCustomerPayment(debtId) {
  const debt = posCustomerDebts.find((d) => d.id === debtId);
  if (!debt) {
    alert('Data hutang tidak ditemukan.');
    return;
  }

  const modalHtml = `
    <div class="modal fade" id="posCustomerPaymentModal" tabindex="-1">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Pembayaran Piutang Customer</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <div class="mb-3">
              <label class="form-label">ID Transaksi</label>
              <input type="text" class="form-control" value="${debt.id}" readonly>
            </div>
            <div class="mb-3">
              <label class="form-label">Customer</label>
              <input type="text" class="form-control" value="${debt.customerName}" readonly>
            </div>
            <div class="mb-3">
              <label class="form-label">Jumlah Pembayaran</label>
              <input type="number" class="form-control" id="posCustomerPaymentAmount" value="${debt.remainingAmount}" min="1" max="${debt.remainingAmount}">
            </div>
            <div class="mb-3">
              <label class="form-label">Tanggal Pembayaran</label>
              <input type="date" class="form-control" id="posCustomerPaymentDate" value="${new Date().toISOString().split('T')[0]}">
            </div>
            <div class="mb-3">
              <label class="form-label">Catatan</label>
              <textarea class="form-control" id="posCustomerPaymentNote" placeholder="Catatan pembayaran..."></textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Batal</button>
            <button type="button" class="btn btn-success" onclick="savePosCustomerPayment('${debt.id}')">Bayar</button>
          </div>
        </div>
      </div>
    </div>`;

  const existing = document.getElementById('posCustomerPaymentModal');
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  document.body.insertAdjacentHTML('beforeend', modalHtml);
  const modalEl = document.getElementById('posCustomerPaymentModal');
  if (!modalEl || !window.bootstrap || !bootstrap.Modal) return;
  const modal = new bootstrap.Modal(modalEl);
  modal.show();
}

async function savePosCustomerPayment(debtId) {
  try {
    const amountInput = document.getElementById('posCustomerPaymentAmount');
    const dateInput = document.getElementById('posCustomerPaymentDate');
    const noteInput = document.getElementById('posCustomerPaymentNote');

    const paymentAmount = Number(amountInput && amountInput.value) || 0;
    const paymentDate = dateInput && dateInput.value ? dateInput.value : new Date().toISOString().split('T')[0];
    const paymentNote = noteInput ? noteInput.value : '';

    if (paymentAmount <= 0) {
      alert('Jumlah pembayaran harus lebih dari 0');
      return;
    }

    const debt = posCustomerDebts.find((d) => d.id === debtId);
    if (!debt) {
      alert('Data hutang tidak ditemukan');
      return;
    }

    const newPaidAmount = (Number(debt.paidAmount) || 0) + paymentAmount;
    const newRemainingAmount = Math.max(0, (Number(debt.remainingAmount) || 0) - paymentAmount);

    const res = await fetch(`/api/transactions/${debtId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paidAmount: newPaidAmount,
        remainingAmount: newRemainingAmount,
        paymentDate,
        note: paymentNote,
      }),
    });

    if (!res.ok) {
      const result = await res.json().catch(() => ({}));
      throw new Error(result.message || 'Gagal memproses pembayaran');
    }

    const modalEl = document.getElementById('posCustomerPaymentModal');
    if (modalEl && window.bootstrap && bootstrap.Modal) {
      const modal = bootstrap.Modal.getInstance(modalEl);
      if (modal) modal.hide();
    }

    await loadRecentTransactions();
    alert('Pembayaran hutang berhasil diproses');
  } catch (e) {
    console.error('Failed to save POS customer payment:', e);
    alert('Gagal memproses pembayaran: ' + (e.message || e));
  }
}
function handleUsbKeydown(e) {
  if (!usbScannerEnabled) return;
  const tag = ((e.target && e.target.tagName) || "").toLowerCase();
  // Abaikan saat mengetik di input/textarea/select
  if (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    e.isComposing
  )
    return;
  const key = e.key;
  if (key === "Enter") {
    const code = usbScanBuffer.trim();
    usbScanBuffer = "";
    if (code) {
      try {
        handleScannedCode(code);
      } catch (err) {
        console.warn("USB scan handle error", err);
      }
    }
    if (usbScanTimer) {
      clearTimeout(usbScanTimer);
      usbScanTimer = null;
    }
    e.preventDefault();
    return;
  }
  if (key && key.length === 1) {
    usbScanBuffer += key;
    if (usbScanTimer) clearTimeout(usbScanTimer);
    // Reset buffer jika tidak ada input lanjutan dalam 200ms
    usbScanTimer = setTimeout(() => {
      usbScanBuffer = "";
    }, 200);
  }
}
document.addEventListener("keydown", handleUsbKeydown);

// pos.js
if (window.__POS_JS_LOADED__) {
  console.warn("pos.js already loaded, skipping second execution");
  throw new Error("pos.js already loaded");
}

// Expose functions globally for inline handlers in pos.html
try {
  window.loadRecentTransactions = loadRecentTransactions;
} catch {}
try {
  window.showTransactionDetails = showTransactionDetails;
} catch {}
try {
  window.showPosCustomerDebtDetails = showPosCustomerDebtDetails;
} catch {}
try {
  window.loadDrafts = loadDrafts;
} catch {}
window.__POS_JS_LOADED__ = true;

function getZXingReaderCtor() {
  if (window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader)
    return window.ZXingBrowser.BrowserMultiFormatReader;
  if (window.ZXing && window.ZXing.BrowserMultiFormatReader)
    return window.ZXing.BrowserMultiFormatReader;
  return null;
}

// Stop camera scanner and cleanup
async function stopCameraScanner() {
  try {
    nativeDetectorActive = false;
    if (camReader) {
      try {
        if (typeof camReader.stopAsyncStreams === "function") {
          camReader.stopAsyncStreams();
        } else if (typeof camReader.reset === "function") {
          camReader.reset();
        }
      } catch (e) {
        console.warn("Error stopping camera reader:", e);
      }
      camReader = null;
    }
    if (camStream) {
      camStream.getTracks().forEach((track) => {
        track.stop();
      });
      camStream = null;
    }
    const videoEl = document.getElementById("cameraScannerVideo");
    if (videoEl) {
      videoEl.srcObject = null;
    }
    // Always remove overlay element if exists
    try {
      const ov = document.getElementById("cameraScannerOverlay");
      if (ov && ov.parentNode) ov.remove();
    } catch {}
    cameraTarget = null;
  } catch (e) {
    console.warn("Error in stopCameraScanner:", e);
  }
}

// Check if device is mobile
function isMobileDevice() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
}

// Try to open native camera/scanner app using file input
function openNativeScannerApp() {
  return new Promise((resolve) => {
    // Create a hidden file input that triggers camera
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.capture = "environment"; // Use back camera
    input.style.display = "none";

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
                    if (typeof reader.decodeFromImageElement === "function") {
                      result = await reader.decodeFromImageElement(img);
                    } else if (typeof reader.decodeFromImage === "function") {
                      result = await reader.decodeFromImage(img);
                    } else if (typeof reader.decode === "function") {
                      result = await reader.decode(img);
                    }

                    if (result) {
                      const text = result.getText
                        ? result.getText()
                        : result.text || String(result);
                      if (text) {
                        handleScannedCode(String(text));
                        resolve(true);
                        return;
                      }
                    }
                  } catch (decodeError) {
                    console.warn("Failed to decode from image:", decodeError);
                  }
                }

                // Try native BarcodeDetector if available
                if ("BarcodeDetector" in window) {
                  try {
                    const formats = [
                      "qr_code",
                      "ean_13",
                      "ean_8",
                      "code_128",
                      "code_39",
                      "upc_a",
                      "upc_e",
                    ];
                    const detector = new window.BarcodeDetector({ formats });
                    const codes = await detector.detect(img);
                    if (codes && codes.length > 0 && codes[0].rawValue) {
                      handleScannedCode(String(codes[0].rawValue));
                      resolve(true);
                      return;
                    }
                  } catch (detectorError) {
                    console.warn("BarcodeDetector failed:", detectorError);
                  }
                }

                alert(
                  "Tidak dapat membaca barcode/QR code dari gambar. Pastikan gambar jelas dan barcode/QR code terlihat dengan baik."
                );
                resolve(false);
              } catch (error) {
                console.error("Error processing image:", error);
                alert("Terjadi kesalahan saat memproses gambar.");
                resolve(false);
              }
            };
            img.src = imageData;
          } catch (error) {
            console.error("Error reading file:", error);
            resolve(false);
          }
        };
        reader.readAsDataURL(file);
      } catch (error) {
        console.error("Error handling file:", error);
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
  const modalEl = document.getElementById("cameraScannerModal");
  if (modalEl && window.bootstrap && typeof bootstrap.Modal !== "undefined") {
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
  activeTooltips.forEach((tooltip) => {
    try {
      if (tooltip && typeof tooltip.dispose === "function") {
        tooltip.dispose();
      }
    } catch (e) {
      // Ignore errors during cleanup
    }
  });
  activeTooltips = [];

  // Cleanup event listeners
  cartEventListeners.forEach((cleanup) => {
    try {
      cleanup();
    } catch (e) {
      // Ignore errors during cleanup
    }
  });
  cartEventListeners = [];
}

function updateScannerStatus(extra) {
  if (!scannerStatus) return;
  const base = scannerEnabled ? "Scanner aktif" : "Scanner non-aktif";
  scannerStatus.textContent = extra ? `${base} – ${extra}` : base;
}

function setupScannerEvents() {
  if (!scannerToggle) return;
  scannerToggle.addEventListener("change", () => {
    scannerEnabled = !!scannerToggle.checked;
    try {
      localStorage.setItem("pos_scannerEnabled", scannerEnabled ? "1" : "0");
    } catch {}
    updateScannerStatus("");
  });

  document.addEventListener("keydown", (e) => {
    if (!scannerEnabled) return;
    // Ignore typing in inputs/textareas/selects
    const tag =
      e.target && e.target.tagName ? e.target.tagName.toLowerCase() : "";
    const type =
      e.target && e.target.type ? String(e.target.type).toLowerCase() : "";
    if (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      type === "number" ||
      type === "text"
    )
      return;

    const now = Date.now();
    const delta = now - lastKeyTime;
    lastKeyTime = now;

    // If too slow or invalid key, reset buffer except for digits/letters and some symbols
    if (delta > 100) {
      scanBuffer = "";
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const code = scanBuffer.trim();
      scanBuffer = "";
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
        scanBuffer = "";
        if (code.length >= 6) handleScannedCode(code);
      }, 80);
    }
  });

  // Camera scanner open button
  const openBtn = document.getElementById("openCameraScannerBtn");
  if (openBtn) {
    openBtn.addEventListener("click", async function () {
      try {
        if (camReader) {
          await stopCameraScanner();
        }

        // Always use browser camera (direct access)
        openBrowserCamera();
      } catch (e) {
        console.error("Error opening camera scanner:", e);
        alert("Gagal membuka scanner: " + (e.message || e));
      }
    });
  }

  // Function to open browser camera
  async function openBrowserCamera() {
    try {
      // Check if mediaDevices API is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert(
          "Peramban Anda tidak mendukung akses kamera. Silakan gunakan peramban yang lebih baru atau perbarui peramban Anda."
        );
        return;
      }

      // Secure context check (required by mobile browsers)
      if (
        !window.isSecureContext &&
        location.hostname !== "localhost" &&
        location.hostname !== "127.0.0.1"
      ) {
        alert(
          "Kamera hanya dapat diakses di HTTPS atau localhost. Akses halaman ini via HTTPS (mis. ngrok/Cloudflare Tunnel) atau jalankan di localhost."
        );
        return;
      }

      // Prefer rendering camera in banner area if available
      const banner = document.getElementById("bannerContainer");
      if (banner) {
        // no-op; modal initialization handled below
      }

      // If Bootstrap modal exists, use it
      const modalEl = document.getElementById("cameraScannerModal");
      if (
        modalEl &&
        window.bootstrap &&
        typeof bootstrap.Modal !== "undefined"
      ) {
        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);

        const onShown = async () => {
          try {
            console.log("Modal shown, initializing camera...");
            autoRescanEnabled = true; // reset when modal shown by user or programmatically
            const videoEl = document.getElementById("cameraScannerVideo");
            if (!videoEl) {
              console.error("Video element not found");
              alert("Video element tidak ditemukan");
              return;
            }

            console.log("Video element found, setting up...");

            // Ensure video element has required attributes for mobile
            videoEl.setAttribute("playsinline", "");
            videoEl.setAttribute("webkit-playsinline", "");
            videoEl.setAttribute("width", "100%");
            videoEl.setAttribute("height", "auto");
            videoEl.muted = true; // Required for autoplay
            videoEl.playsInline = true; // For iOS
            videoEl.autoplay = true;

            // Clear any existing stream first
            if (videoEl.srcObject) {
              const oldStream = videoEl.srcObject;
              oldStream.getTracks().forEach((track) => track.stop());
              videoEl.srcObject = null;
            }

            // Try to get back camera first (for mobile devices)
            let constraints = {
              video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 1280 },
                height: { ideal: 720 },
              },
              audio: false,
            };

            console.log("Requesting camera access...");
            try {
              camStream = await navigator.mediaDevices.getUserMedia(
                constraints
              );
              console.log("Camera access granted, stream:", camStream);
            } catch (e) {
              console.warn("Failed with back camera, trying front camera:", e);
              // Try front camera
              try {
                constraints = {
                  video: {
                    facingMode: { ideal: "user" },
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                  },
                  audio: false,
                };
                camStream = await navigator.mediaDevices.getUserMedia(
                  constraints
                );
                console.log("Front camera access granted");
              } catch (e2) {
                // Last fallback: any camera
                try {
                  camStream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: false,
                  });
                  console.log("Any camera access granted");
                } catch (e3) {
                  console.error("getUserMedia failed completely:", e3);
                  let errorMsg = "Gagal mengakses kamera.";
                  if (
                    e3.name === "NotAllowedError" ||
                    e3.name === "PermissionDeniedError"
                  ) {
                    errorMsg +=
                      "\n\nAnda perlu memberikan izin akses kamera. Silakan periksa pengaturan peramban Anda.";
                  } else if (
                    e3.name === "NotFoundError" ||
                    e3.name === "DevicesNotFoundError"
                  ) {
                    errorMsg +=
                      "\n\nTidak ada kamera yang terdeteksi pada perangkat ini.";
                  } else {
                    errorMsg +=
                      "\n\nError: " +
                      (e3.message || e3.name || "Unknown error");
                  }
                  alert(errorMsg);
                  modal.hide();
                  return;
                }
              }
            }

            console.log("Attaching stream to video element...");
            videoEl.srcObject = camStream;
            console.log("Stream attached, waiting for video to load...");

            // Load video metadata
            videoEl.load();

            // Wait for video metadata to load
            await new Promise((resolve) => {
              if (videoEl.readyState >= 2) {
                console.log("Video already ready");
                resolve();
              } else {
                const onLoadedMetadata = () => {
                  console.log("Video metadata loaded");
                  videoEl.removeEventListener(
                    "loadedmetadata",
                    onLoadedMetadata
                  );
                  videoEl.removeEventListener("loadeddata", onLoadedData);
                  videoEl.removeEventListener("error", onError);
                  resolve();
                };
                const onLoadedData = () => {
                  console.log("Video data loaded");
                  videoEl.removeEventListener(
                    "loadedmetadata",
                    onLoadedMetadata
                  );
                  videoEl.removeEventListener("loadeddata", onLoadedData);
                  videoEl.removeEventListener("error", onError);
                  resolve();
                };
                const onError = (e) => {
                  console.error("Video error:", e);
                  videoEl.removeEventListener(
                    "loadedmetadata",
                    onLoadedMetadata
                  );
                  videoEl.removeEventListener("loadeddata", onLoadedData);
                  videoEl.removeEventListener("error", onError);
                  resolve(); // Continue anyway
                };
                videoEl.addEventListener("loadedmetadata", onLoadedMetadata);
                videoEl.addEventListener("loadeddata", onLoadedData);
                videoEl.addEventListener("error", onError);

                // Timeout fallback
                setTimeout(() => {
                  console.log("Video load timeout, continuing anyway");
                  videoEl.removeEventListener(
                    "loadedmetadata",
                    onLoadedMetadata
                  );
                  videoEl.removeEventListener("loadeddata", onLoadedData);
                  videoEl.removeEventListener("error", onError);
                  resolve();
                }, 3000);
              }
            });

            // Ensure video is playing
            console.log("Starting video playback...");
            console.log("Video readyState:", videoEl.readyState);
            console.log("Video paused:", videoEl.paused);

            try {
              // Wait a bit for video to be ready
              if (videoEl.readyState < 3) {
                await new Promise((resolve) => {
                  const onCanPlay = () => {
                    console.log("Video can play");
                    videoEl.removeEventListener("canplay", onCanPlay);
                    videoEl.removeEventListener(
                      "canplaythrough",
                      onCanPlayThrough
                    );
                    resolve();
                  };
                  const onCanPlayThrough = () => {
                    console.log("Video can play through");
                    videoEl.removeEventListener("canplay", onCanPlay);
                    videoEl.removeEventListener(
                      "canplaythrough",
                      onCanPlayThrough
                    );
                    resolve();
                  };
                  videoEl.addEventListener("canplay", onCanPlay);
                  videoEl.addEventListener("canplaythrough", onCanPlayThrough);
                  setTimeout(() => {
                    videoEl.removeEventListener("canplay", onCanPlay);
                    videoEl.removeEventListener(
                      "canplaythrough",
                      onCanPlayThrough
                    );
                    resolve();
                  }, 2000);
                });
              }

              // Try to play
              console.log("Attempting to play video...");
              if (videoEl.paused) {
                await videoEl.play();
                console.log("Video play() called successfully");
              } else {
                console.log("Video already playing");
              }

              // Wait for playing event to confirm video is actually playing
              await new Promise((resolve) => {
                const onPlaying = () => {
                  console.log("Video is now playing!");
                  videoEl.removeEventListener("playing", onPlaying);
                  videoEl.removeEventListener("play", onPlay);
                  resolve();
                };
                const onPlay = () => {
                  console.log("Video play event fired");
                  videoEl.removeEventListener("playing", onPlaying);
                  videoEl.removeEventListener("play", onPlay);
                  resolve();
                };
                if (!videoEl.paused) {
                  // Already playing, check if tracks are active
                  if (
                    camStream &&
                    camStream.getVideoTracks().length > 0 &&
                    camStream.getVideoTracks()[0].readyState === "live"
                  ) {
                    console.log("Stream is live");
                    resolve();
                  } else {
                    videoEl.addEventListener("playing", onPlaying);
                    videoEl.addEventListener("play", onPlay);
                    setTimeout(() => {
                      videoEl.removeEventListener("playing", onPlaying);
                      videoEl.removeEventListener("play", onPlay);
                      resolve();
                    }, 1000);
                  }
                } else {
                  videoEl.addEventListener("playing", onPlaying);
                  videoEl.addEventListener("play", onPlay);
                  setTimeout(() => {
                    videoEl.removeEventListener("playing", onPlaying);
                    videoEl.removeEventListener("play", onPlay);
                    resolve();
                  }, 1000);
                }
              });

              // Force play if still paused after a moment
              setTimeout(() => {
                if (videoEl.paused) {
                  console.log("Video still paused, forcing play...");
                  videoEl
                    .play()
                    .catch((e) => console.warn("Force play failed:", e));
                }
              }, 500);
            } catch (playError) {
              console.warn("Auto-play prevented:", playError);
              // Try to enable controls as fallback
              videoEl.controls = true;
              alert("Video autoplay diblokir. Klik play untuk memulai kamera.");
            }

            // Try to start barcode detection
            const ok = await ensureZXing();
            const ReaderCtor = getZXingReaderCtor();
            if (ok && ReaderCtor) {
              camReader = new ReaderCtor();
              if (typeof camReader.decodeFromVideoDevice === "function") {
                camReader.decodeFromVideoDevice(
                  null,
                  videoEl,
                  (result, err) => {
                    if (err) {
                      return;
                    }
                    if (result && result.getText) {
                      const text = String(result.getText());
                      const now = Date.now();
                      if (
                        text === lastCamScan.text &&
                        now - lastCamScan.time < 1500
                      )
                        return;
                      lastCamScan = { text, time: now };
                      handleScannedCode(text);
                    }
                  }
                );
              } else if (
                typeof camReader.decodeFromVideoElement === "function"
              ) {
                camReader.decodeFromVideoElement(videoEl, (result, err) => {
                  if (err) {
                    return;
                  }
                  if (result && result.getText) {
                    const text = String(result.getText());
                    const now = Date.now();
                    if (
                      text === lastCamScan.text &&
                      now - lastCamScan.time < 1500
                    )
                      return;
                    lastCamScan = { text, time: now };
                    handleScannedCode(text);
                  }
                });
              } else if (
                typeof camReader.decodeFromInputVideoDevice === "function"
              ) {
                try {
                  const result = await camReader.decodeFromInputVideoDevice(
                    undefined,
                    videoEl
                  );
                  const text =
                    result && (result.getText ? result.getText() : result.text);
                  if (text) {
                    const t = String(text);
                    const now = Date.now();
                    if (
                      t === lastCamScan.text &&
                      now - lastCamScan.time < 1500
                    ) {
                      // keep camera open
                    } else {
                      lastCamScan = { text: t, time: now };
                      handleScannedCode(t);
                    }
                  }
                } catch (e) {
                  console.warn("decodeFromInputVideoDevice failed:", e);
                }
              } else if (
                typeof camReader.decodeFromVideoSource === "function"
              ) {
                try {
                  // Use current stream by binding srcObject already set on videoEl
                  // decodeFromVideoSource expects a URL string; fallback to native below if not supported
                } catch {}
              } else {
                console.warn(
                  "ZXing reader has no compatible decode methods; falling back to native detector"
                );
                if (
                  !(await startNativeDetector(videoEl, (text) => {
                    const t = String(text);
                    const now = Date.now();
                    if (t === lastCamScan.text && now - lastCamScan.time < 1500)
                      return;
                    lastCamScan = { text: t, time: now };
                    handleScannedCode(t);
                  }))
                ) {
                  alert(
                    "Scanner tidak tersedia (metode ZXing tidak didukung dan BarcodeDetector tidak tersedia)."
                  );
                }
              }
            } else if (
              await startNativeDetector(videoEl, (text) => {
                const t = String(text);
                const now = Date.now();
                if (t === lastCamScan.text && now - lastCamScan.time < 1500)
                  return;
                lastCamScan = { text: t, time: now };
                handleScannedCode(t);
              })
            ) {
              // started native detector
            } else {
              alert(
                "Scanner tidak tersedia (ZXing gagal dimuat dan BarcodeDetector tidak didukung)."
              );
            }
            cameraTarget = "modal";
          } catch (e) {
            console.error("Error starting camera:", e);
            alert("Gagal membuka kamera: " + (e.message || e));
          }
        };

        // Remove existing listeners to prevent duplicates
        modalEl.removeEventListener("shown.bs.modal", onShown);
        modalEl.addEventListener("shown.bs.modal", onShown, { once: true });

        // Handle hidden: always stop camera; if programmatic, reopen after a short delay
        const onHidden = () => {
          try {
            stopCameraScanner();
          } catch {}
          if (programmaticRescan && autoRescanEnabled) {
            programmaticRescan = false;
            setTimeout(() => {
              try {
                modal.show();
              } catch (e) {}
            }, 80);
          }
        };
        modalEl.removeEventListener("hidden.bs.modal", onHidden);
        modalEl.addEventListener("hidden.bs.modal", onHidden);

        modal.show();
        return;
      }

      // Create overlay if not exists
      let overlay = document.getElementById("cameraScannerOverlay");
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "cameraScannerOverlay";
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

      const videoEl =
        overlay.querySelector("#cameraScannerVideo") ||
        document.getElementById("cameraScannerVideo");
      if (!videoEl) {
        alert("Video element tidak ditemukan");
        return;
      }

      const closeBtn =
        overlay.querySelector("#closeCameraScannerBtn") ||
        document.getElementById("closeCameraScannerBtn");
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
      videoEl.setAttribute("playsinline", "");
      videoEl.setAttribute("webkit-playsinline", "");
      videoEl.setAttribute("width", "100%");
      videoEl.setAttribute("height", "auto");
      videoEl.muted = true; // Required for autoplay
      videoEl.playsInline = true; // For iOS

      // Try to get back camera first (for mobile devices)
      let constraints = {
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      };

      try {
        camStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e) {
        console.warn("Failed with back camera, trying front camera:", e);
        // Try front camera
        try {
          constraints = {
            video: {
              facingMode: { ideal: "user" },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          };
          camStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e2) {
          // Last fallback: any camera
          try {
            camStream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            });
          } catch (e3) {
            console.error("getUserMedia failed completely:", e3);
            let errorMsg = "Gagal mengakses kamera.";
            if (
              e3.name === "NotAllowedError" ||
              e3.name === "PermissionDeniedError"
            ) {
              errorMsg +=
                "\n\nAnda perlu memberikan izin akses kamera. Silakan periksa pengaturan peramban Anda.";
            } else if (
              e3.name === "NotFoundError" ||
              e3.name === "DevicesNotFoundError"
            ) {
              errorMsg +=
                "\n\nTidak ada kamera yang terdeteksi pada perangkat ini.";
            } else {
              errorMsg +=
                "\n\nError: " + (e3.message || e3.name || "Unknown error");
            }
            alert(errorMsg);
            const overlayEl = document.getElementById("cameraScannerOverlay");
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
            videoEl.removeEventListener("loadedmetadata", onLoadedMetadata);
            videoEl.removeEventListener("error", onError);
            resolve();
          };
          const onError = (e) => {
            videoEl.removeEventListener("loadedmetadata", onLoadedMetadata);
            videoEl.removeEventListener("error", onError);
            reject(e);
          };
          videoEl.addEventListener("loadedmetadata", onLoadedMetadata);
          videoEl.addEventListener("error", onError);

          // Timeout fallback
          setTimeout(() => {
            videoEl.removeEventListener("loadedmetadata", onLoadedMetadata);
            videoEl.removeEventListener("error", onError);
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
              videoEl.removeEventListener("canplay", onCanPlay);
              resolve();
            };
            videoEl.addEventListener("canplay", onCanPlay);
          });
        }

        if (videoEl.paused) {
          await videoEl.play();
        }

        // Force play if still paused
        if (videoEl.paused) {
          videoEl.play().catch((e) => console.warn("Play failed:", e));
        }
      } catch (playError) {
        console.warn("Auto-play prevented, trying again:", playError);
        // Try to enable controls as fallback
        videoEl.controls = true;
        alert("Video autoplay diblokir. Klik play untuk memulai kamera.");
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
              if (text === lastCamScan.text && now - lastCamScan.time < 1500)
                return;
              lastCamScan = { text, time: now };
              handleScannedCode(text);
            }
          });
        } else if (
          await startNativeDetector(videoEl, (text) => {
            const t = String(text);
            const now = Date.now();
            if (t === lastCamScan.text && now - lastCamScan.time < 1500) return;
            lastCamScan = { text: t, time: now };
            handleScannedCode(t);
          })
        ) {
          // started native detector
        } else {
          alert(
            "Scanner tidak tersedia (ZXing gagal dimuat dan BarcodeDetector tidak didukung)."
          );
          stopCameraScanner();
          return;
        }
        cameraTarget = "overlay";
      } catch (e) {
        console.error("ZXing init error:", e);
        alert("Inisialisasi pemindai gagal: " + (e.message || e));
        await stopCameraScanner();
        const overlayEl = document.getElementById("cameraScannerOverlay");
        if (overlayEl && overlayEl.parentNode) {
          overlayEl.remove();
        }
      }
    } catch (e) {
      alert("Gagal membuka kamera: " + (e.message || e));
    }
  }
}

function handleScannedCode(raw) {
  try {
    const code = String(raw || "").trim();
    updateScannerStatus(`kode: ${code}`);
    if (!code) return;

    // Global dedup: ignore identical code scanned within 600ms
    try {
      const now = Date.now();
      if (
        lastHandledScan &&
        lastHandledScan.text === code &&
        now - (lastHandledScan.time || 0) < 600
      ) {
        return;
      }
      lastHandledScan = { text: code, time: now };
    } catch {}

    // Build candidate codes from various QR formats
    const candidates = new Set();
    const push = (v) => {
      if (v != null && String(v).trim() !== "")
        candidates.add(String(v).trim());
    };

    // 1) Raw as-is
    push(code);

    // 2) If URL, extract common params and last path segment
    try {
      const u = new URL(code);
      const params = [
        "sku",
        "qr",
        "q",
        "code",
        "barcode",
        "id",
        "product",
        "p",
      ];
      params.forEach((k) => push(u.searchParams.get(k)));
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length > 0) push(parts[parts.length - 1]);
    } catch {}

    // 3) If JSON, try keys sku/qrCode/code/id
    try {
      const obj = JSON.parse(code);
      ["sku", "qrCode", "code", "id", "productId"].forEach((k) =>
        push(obj?.[k])
      );
    } catch {}

    // 4) Normalize: remove spaces and hyphens for barcode-like
    Array.from(candidates).forEach((v) => {
      const compact = v.replace(/[\s-]+/g, "");
      if (compact !== v) push(compact);
    });

    // Try to find product by multiple candidates
    const lowerSet = new Set(
      Array.from(candidates).map((x) => x.toLowerCase())
    );
    const prod =
      (products || []).find((p) =>
        lowerSet.has(String(p.sku || "").toLowerCase())
      ) ||
      (products || []).find((p) => candidates.has(String(p.id))) ||
      (products || []).find((p) =>
        lowerSet.has(String(p.qrCode || "").toLowerCase())
      ) ||
      (products || []).find((p) =>
        lowerSet.has(String(p.barcode || "").toLowerCase())
      );

    if (!prod) {
      updateScannerStatus(`kode tidak dikenal: ${code}`);
      return;
    }
    addToCart(prod.id);
    updateScannerStatus(`ditambahkan: ${prod.name || prod.sku || prod.id}`);

    // Close camera immediately (no auto reopen)
    try {
      forceCloseCameraUI();
    } catch {}
  } catch (err) {
    console.warn("handleScannedCode error", err);
  }
}

// CSRF token handling for POS
var __csrfPosToken = null;
try {
  (async function initPosCsrf() {
    try {
      const r = await fetch("/api/csrf", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (j && j.csrfToken) __csrfPosToken = j.csrfToken;
    } catch {}
  })();
  (function () {
    const of = window.fetch;
    window.fetch = async function (input, init) {
      init = init || {};
      const url =
        typeof input === "string" ? input : (input && input.url) || "";
      const method = String(init.method || "GET").toUpperCase();
      const needs =
        method === "POST" ||
        method === "PUT" ||
        method === "DELETE" ||
        method === "PATCH";
      const isApi =
        typeof url === "string" &&
        url.indexOf("/api/") !== -1 &&
        url.startsWith("/");
      if (needs && isApi && __csrfPosToken) {
        init.headers = Object.assign({}, init.headers, {
          "X-CSRF-Token": __csrfPosToken,
        });
      }
      return of(input, init);
    };
  })();
} catch {}

// --- Theme Application for POS ---
function applyTheme(settings) {
  const theme = settings?.themeColor || '#198754';
  let css = `
    .btn-success, .btn-outline-success:hover { background-color: ${theme} !important; border-color: ${theme} !important; }
    .btn-outline-success { color: ${theme} !important; border-color: ${theme} !important; }
    .navbar.bg-success { background-color: ${theme} !important; }
    .text-success { color: ${theme} !important; }
    .btn-primary, .btn-outline-primary:hover { background-color: ${theme} !important; border-color: ${theme} !important; }
    .btn-outline-primary { color: ${theme} !important; border-color: ${theme} !important; }
    a, .page-link, .page-link:hover { color: ${theme}; }
    .badge.bg-secondary { background-color: ${theme} !important; }
    .form-check-input:checked { background-color: ${theme}; border-color: ${theme}; }
    body.dark { background-color: #121212; color: #eaeaea; }
    body.dark .card { background-color: #1e1e1e; color: #eaeaea; border-color: #333333 !important; }
    body.dark .card-header { background-color: #2a2a2a !important; color: #ffffff !important; border-color: #333333 !important; }
    body.dark .navbar { background-color: #1e1e1e !important; border-color: #333333 !important; }
    body.dark .navbar-brand { color: #ffffff !important; }
    body.dark .navbar-text { color: #eaeaea !important; }
    body.dark .form-control, body.dark .form-select { background-color: #1b1b1b !important; border-color: #333 !important; color: #eaeaea !important; }
    body.dark .form-control::placeholder, body.dark .form-select::placeholder { color: #9e9e9e !important; }
    body.dark .input-group-text { background-color: #2a2a2a !important; border-color: #444 !important; color: #eaeaea !important; }
    body.dark .btn-outline-light { color: #eaeaea !important; border-color: #555 !important; }
    body.dark .btn-outline-light:hover { background-color: #333333 !important; color: #ffffff !important; }
    body.dark .btn-outline-secondary { color: #ddd !important; border-color: #555 !important; }
    body.dark .btn-outline-secondary:hover { background-color: #555 !important; color: #ffffff !important; }
    body.dark .dropdown-menu { background-color: #1e1e1e !important; color: #ffffff !important; border-color: #333 !important; }
    body.dark .dropdown-item { color: #ffffff !important; }
    body.dark .dropdown-item:hover, body.dark .dropdown-item:focus { background-color: #262626 !important; color: #ffffff !important; }
    body.dark .modal-content { background-color: #1e1e1e !important; color: #ffffff !important; border-color: #333 !important; }
    body.dark .modal-header, body.dark .modal-footer { border-color: #333 !important; background-color: #1e1e1e !important; }
    body.dark .modal-title { color: #ffffff !important; }
    body.dark .form-label, body.dark label { color: #ffffff !important; }
    body.dark .form-text { color: #bbbbbb !important; }
    body.dark .text-muted { color: #bbbbbb !important; }
    body.dark .product-card { background-color: #1e1e1e !important; color: #eaeaea !important; border-color: #333333 !important; }
    body.dark .product-card:hover { background-color: #262626 !important; }
    body.dark h1, body.dark h2, body.dark h3, body.dark h4, body.dark h5, body.dark h6 { color: #ffffff !important; }
    body.dark .table { background-color: #121212 !important; color: #ffffff !important; }
    body.dark .table thead { background-color: #1b1b1b !important; color: #ffffff !important; }
    body.dark .table thead th { background-color: #1b1b1b !important; color: #ffffff !important; border-color: #333333 !important; }
    body.dark .table tbody tr { background-color: #181818 !important; color: #ffffff !important; }
    body.dark .table th, body.dark .table td { background-color: #181818 !important; border-color: #333333 !important; color: #ffffff !important; }
    body.dark .table td small, body.dark .table td span, body.dark .table td a { color: #ffffff !important; }
    body.dark .table-striped > tbody > tr:nth-of-type(odd) { background-color: #202020 !important; color: #ffffff !important; }
    body.dark .table-striped > tbody > tr:nth-of-type(even) { background-color: #181818 !important; color: #ffffff !important; }
    body.dark .table-hover > tbody > tr:hover { background-color: #262626 !important; color: #ffffff !important; }
    body.dark footer { background-color: #1e1e1e !important; color: #eaeaea !important; }
    body.dark .bg-light { background-color: #2a2a2a !important; }
    body.dark #customerInfo, body.dark #posSettingsCustomerInfo { background-color: #2a2a2a !important; color: #eaeaea !important; border: 1px solid #444 !important; }
    body.dark #customerInfo strong, body.dark #posSettingsCustomerInfo strong { color: #ffffff !important; }
    body.dark #cartItems { background-color: transparent !important; }
    body.dark #cartItems p, body.dark #cartItems .text-muted { color: #eaeaea !important; }
    body.dark .form-control:focus, body.dark .form-select:focus { background-color: #1b1b1b !important; color: #eaeaea !important; border-color: #198754 !important; }
    body.dark .input-group .form-control, body.dark .input-group .form-select { background-color: #1b1b1b !important; color: #eaeaea !important; }
    body.dark .card-body { background-color: #1e1e1e !important; color: #eaeaea !important; }
    body.dark .small { color: #eaeaea !important; }
    
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
  `;
  let styleEl = document.getElementById('dynamic-theme-css');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'dynamic-theme-css';
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
    localStorage.setItem('pos_darkMode', isDarkMode.toString());
    
    // Update toggle checkbox if it exists
    const darkModeToggle = document.getElementById('darkModeToggle');
    if (darkModeToggle) {
      darkModeToggle.checked = isDarkMode;
    }
    
    // Apply product border setting
    const showBorders = settings?.posShowProductBorders !== false;
    if (showBorders) {
      document.body.classList.remove('hide-product-borders');
    } else {
      document.body.classList.add('hide-product-borders');
    }
  } catch {}
}

// --- Dark Mode Toggle for POS ---
function setupDarkModeToggle() {
    const darkModeToggle = document.getElementById('darkModeToggle');
    
    if (darkModeToggle) {
        // Set initial state based on saved localStorage first, then current theme
        const savedDarkMode = localStorage.getItem('pos_darkMode') === 'true';
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
            localStorage.setItem('pos_darkMode', isDark.toString());
            
            // Save to settings and reapply theme
            try {
                const response = await fetch('/api/settings');
                const settings = await response.json();
                settings.darkMode = isDark;
                await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(settings)
                });
                
                // Reapply theme with new settings
                applyTheme(settings);
            } catch (e) {
                console.warn('Failed to save dark mode setting:', e);
            }
        });
    }
}

// --- Initialization ---
document.addEventListener("DOMContentLoaded", async () => {
  console.log("DOM fully loaded. Initializing app...");
  
  // Setup dark mode toggle
  setupDarkModeToggle();
  
  // Load and apply theme settings
  try {
    const response = await fetch('/api/settings');
    if (response.ok) {
      const settings = await response.json();
      applyTheme(settings);
    }
  } catch (e) {
    console.warn('Failed to load theme settings:', e);
  }

  try {
    try {
      const savedCart = JSON.parse(localStorage.getItem("pos_cart") || "[]");
      if (Array.isArray(savedCart)) cart = savedCart;
      const t = parseInt(localStorage.getItem("pos_cart_updatedAt") || "0");
      if (!Number.isNaN(t)) lastLocalCartAt = t;
    } catch (e) {}
    try {
      renderCart();
    } catch (e) {}
    try {
      await syncServerCartInitial();
    } catch (e) {}
    // Apply Sync Mode (manual or realtime)
    try {
      const sel = document.getElementById("syncModeSelect");
      let mode = localStorage.getItem("pos_syncMode") || "manual";
      if (sel) sel.value = mode === "realtime" ? "realtime" : "manual";
      applySyncMode(mode);
      if (sel) {
        sel.addEventListener("change", (e) => {
          const v = e.target.value === "realtime" ? "realtime" : "manual";
          localStorage.setItem("pos_syncMode", v);
          applySyncMode(v);
        });
      }
    } catch {}
    // Restore discount settings
    try {
      const dt = localStorage.getItem("pos_discountType");
      const dv = localStorage.getItem("pos_discountValue");
      if (dt && (dt === "amount" || dt === "percent")) {
        discountType = dt;
        if (discountTypeSelect) discountTypeSelect.value = dt;
      }
      if (dv != null && dv !== "") {
        const num = parseFloat(dv);
        if (!Number.isNaN(num)) {
          discountValue = Math.max(0, num);
          if (discountValueInput)
            discountValueInput.value = String(discountValue);
        }
      }
    } catch (e) {}
    // Restore payment method
    try {
      const pm = localStorage.getItem("pos_paymentMethod");
      if (pm) {
        const radio = document.querySelector(
          `input[name="paymentMethod"][value="${pm}"]`
        );
        if (radio) {
          radio.checked = true;
          if (pm === "cash") {
            if (cashPaymentSection) cashPaymentSection.style.display = "block";
            if (qrisPaymentSection) qrisPaymentSection.style.display = "none";
          } else {
            if (cashPaymentSection) cashPaymentSection.style.display = "none";
            if (qrisPaymentSection) qrisPaymentSection.style.display = "block";
          }
        }
      }
    } catch (e) {}
    // Initialize modals after DOM is ready, guard if bootstrap is not yet available
    const posSettingsModalEl = document.getElementById("posSettingsModal");
    const checkoutModalEl = document.getElementById("checkoutModal");
    const transactionDetailsModalEl = document.getElementById(
      "transactionDetailsModal"
    );
    const paymentSuccessModalEl = document.getElementById(
      "paymentSuccessModal"
    );

    function initModals() {
      try {
        if (typeof window.bootstrap === "undefined") return false;
        if (posSettingsModalEl)
          posSettingsModal = new bootstrap.Modal(posSettingsModalEl);
        if (checkoutModalEl)
          checkoutModal = new bootstrap.Modal(checkoutModalEl);
        if (transactionDetailsModalEl)
          transactionDetailsModal = new bootstrap.Modal(
            transactionDetailsModalEl
          );
        if (paymentSuccessModalEl)
          paymentSuccessModal = new bootstrap.Modal(paymentSuccessModalEl);
        return true;
      } catch (e) {
        console.error("Bootstrap modal init failed:", e);
        return false;
      }
    }
    if (!initModals()) {
      window.addEventListener("load", () => {
        initModals();
      });
    }

    // PERBAIKAN: Load data dengan error handling yang lebih baik
    console.log("Loading settings...");
    await loadSettingsPOS().catch((err) =>
      console.error("Failed to load settings:", err)
    );

    console.log("Fetching user info...");
    await fetchUserInfo().catch((err) =>
      console.error("Failed to fetch user info:", err)
    );

    console.log("Loading categories...");
    await loadCategories().catch((err) =>
      console.error("Failed to load categories:", err)
    );

    console.log("Loading banner...");
    await loadBanner().catch((err) =>
      console.error("Failed to load banner:", err)
    );

    console.log("Loading products...");
    await loadProducts().catch((err) =>
      console.error("Failed to load products:", err)
    );
    // Re-render cart to update any stock-related warnings after products are loaded
    try {
      renderCart();
    } catch (e) {}

    console.log("Loading QRIS image...");
    await loadQrisImage().catch((err) =>
      console.error("Failed to load QRIS:", err)
    );

    console.log("Loading recent transactions...");
    await loadRecentTransactions().catch((err) =>
      console.error("Failed to load transactions:", err)
    );

    console.log("Loading customers...");
    await loadCustomers().catch((err) =>
      console.error("Failed to load customers:", err)
    );
    // Restore selected customer after customers loaded
    try {
      const sc = localStorage.getItem("pos_customerId");
      if (sc) {
        if (sc === "default") {
          selectedCustomer = { id: "default", name: "Pelanggan Umum" };
        } else {
          const c = customers.find((x) => String(x.id) === String(sc));
          if (c) selectedCustomer = { id: c.id, name: c.name };
        }
        populateCustomerSelect();
      }
    } catch (e) {}

    console.log("Loading drafts...");
    await loadDrafts().catch((err) =>
      console.error("Failed to load drafts:", err)
    );

    // Load current cashier shift (if any)
    try {
      console.log("Loading current shift...");
      await loadCurrentShift();
    } catch (err) {
      console.error("Failed to load current shift:", err);
    }

    console.log("Setting up event listeners...");
    setupEventListeners();
    setupScannerEvents();

    // Init scanner from localStorage
    try {
      const v = localStorage.getItem("pos_scannerEnabled");
      scannerEnabled = v === "1";
      if (scannerToggle) scannerToggle.checked = scannerEnabled;
      updateScannerStatus("");
    } catch {}

    console.log("App initialization complete.");
  } catch (error) {
    console.error("Critical error during initialization:", error);
    alert("Terjadi kesalahan saat memuat aplikasi. Silakan refresh halaman.");
  }
});

// Digital clock on POS navbar
try {
  const posClockEl = document.getElementById("posClock");
  if (posClockEl) {
    const daysId = ["Minggu","Senin","Selasa","Rabu","Kamis","Jumat","Sabtu"];
    function updatePosClock() {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      const ss = String(now.getSeconds()).padStart(2, "0");
      const day = daysId[now.getDay()] || "";
      posClockEl.textContent = day ? `${day}, ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
    }
    updatePosClock();
    setInterval(updatePosClock, 1000);
  }
} catch (e) {}

function formatCurrency(value) {
  const symbol = (appSettings && appSettings.currencySymbol) || "Rp";
  const precision =
    appSettings && typeof appSettings.currencyPrecision === "number"
      ? appSettings.currencyPrecision
      : 0;
  const thou = (appSettings && appSettings.thousandSeparator) || ".";
  const dec = (appSettings && appSettings.decimalSeparator) || ",";
  let n = Number(value || 0);
  const neg = n < 0;
  n = Math.abs(n);
  const fixed = n.toFixed(precision);
  let [intPart, decPart] = fixed.split(".");
  intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thou);
  const body = precision > 0 ? intPart + dec + decPart : intPart;
  return (neg ? "-" : "") + symbol + " " + body.trim();
}

let currentShift = null;

function updateShiftUI(shift) {
  try {
    if (shiftStatusLabel) {
      if (shift && !shift.closedAt) {
        const ts = Number(shift.openedAt || Date.now());
        const d = new Date(ts);
        let label = "Shift: Aktif";
        if (!Number.isNaN(d.getTime())) {
          label = "Shift: Dibuka " + d.toLocaleString("id-ID");
        }
        shiftStatusLabel.textContent = label;
      } else {
        shiftStatusLabel.textContent = "Shift: Belum dibuka";
      }
    }
    if (shiftActionBtn) {
      if (shift && !shift.closedAt) {
        shiftActionBtn.textContent = "Tutup Shift";
        shiftActionBtn.dataset.mode = "close";
        shiftActionBtn.classList.remove("btn-outline-warning");
        shiftActionBtn.classList.add("btn-outline-danger");
      } else {
        shiftActionBtn.textContent = "Buka Shift";
        shiftActionBtn.dataset.mode = "open";
        shiftActionBtn.classList.remove("btn-outline-danger");
        shiftActionBtn.classList.add("btn-outline-warning");
      }
    }
  } catch (e) {
    console.warn("Failed to update shift UI:", e);
  }
}

async function loadCurrentShift() {
  try {
    const res = await fetch("/api/shifts/current", { cache: "no-store" });
    if (!res.ok) throw new Error("Gagal memuat shift");
    const data = await res.json().catch(() => ({}));
    currentShift = data && data.shift ? data.shift : null;
    updateShiftUI(currentShift);
  } catch (e) {
    console.error("Failed to load current shift:", e);
    updateShiftUI(currentShift);
  }
}

async function openShiftFlow() {
  try {
    let val = prompt(
      "Masukkan saldo awal kas (tunai di laci) dalam angka:",
      "0"
    );
    if (val === null) return;
    val = String(val).replace(",", ".");
    const opening = Number(val);
    if (!Number.isFinite(opening) || opening < 0) {
      alert("Nilai saldo awal tidak valid.");
      return;
    }
    if (
      !confirm(
        "Buka shift baru dengan saldo awal kas " +
          formatCurrency(opening) +
          " ?"
      )
    ) {
      return;
    }
    const res = await fetch("/api/shifts/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openingCash: opening }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      throw new Error(data.message || "Gagal membuka shift");
    }
    currentShift = data.shift || null;
    updateShiftUI(currentShift);
    alert("Shift berhasil dibuka.");
  } catch (e) {
    console.error("openShiftFlow error:", e);
    alert("Gagal membuka shift: " + (e.message || e));
  }
}

async function closeShiftFlow() {
  try {
    if (!currentShift || currentShift.closedAt) {
      if (
        !confirm(
          "Tidak ada shift aktif untuk kasir ini. Tetap lanjut mencoba menutup shift?"
        )
      ) {
        return;
      }
    }
    let defaultClosing = "0";
    let summary = null;
    try {
      const res = await fetch("/api/shifts/current-summary", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        summary = data && data.summary ? data.summary : null;
        if (
          summary &&
          typeof summary.expectedCash === "number" &&
          Number.isFinite(summary.expectedCash) &&
          summary.expectedCash >= 0
        ) {
          defaultClosing = String(summary.expectedCash);
        }
      }
    } catch (e) {}
    let promptMessage = "Masukkan saldo akhir kas (tunai di laci) dalam angka:";
    if (summary) {
      const lines = [];
      lines.push("Ringkasan shift saat ini:");
      lines.push("Jumlah transaksi: " + String(summary.transactionsCount || 0));
      lines.push(
        "Total Penjualan: " +
          formatCurrency(summary.totalSales || 0)
      );
      lines.push(
        "Penjualan Tunai: " +
          formatCurrency(summary.cashSales || 0)
      );
      lines.push(
        "Penjualan Non-Tunai: " +
          formatCurrency(summary.nonCashSales || 0)
      );
      lines.push(
        "Saldo Awal: " + formatCurrency(summary.openingCash || 0)
      );
      lines.push(
        "Saldo Harusnya (Saldo Awal + Semua Penjualan): " +
          formatCurrency(summary.expectedCash || 0)
      );
      lines.push("");
      lines.push("Masukkan saldo akhir kas (tunai di laci) dalam angka:");
      promptMessage = lines.join("\n");
    }
    let val = prompt(promptMessage, defaultClosing);
    if (val === null) return;
    val = String(val).replace(",", ".");
    const closing = Number(val);
    if (!Number.isFinite(closing) || closing < 0) {
      alert("Nilai saldo akhir tidak valid.");
      return;
    }
    if (
      !confirm(
        "Tutup shift dengan saldo akhir kas " +
          formatCurrency(closing) +
          " ?"
      )
    ) {
      return;
    }
    const res = await fetch("/api/shifts/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ closingCash: closing }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      throw new Error(data.message || "Gagal menutup shift");
    }
    currentShift = data.shift || null;
    updateShiftUI(currentShift);
    if (currentShift) {
      const msg = [];
      if (currentShift.cashierName || currentShift.cashierUsername) {
        msg.push(
          "Kasir: " +
            (currentShift.cashierName || currentShift.cashierUsername)
        );
      }
      msg.push(
        "Jumlah transaksi: " + String(currentShift.transactionsCount || 0)
      );
      msg.push(
        "Penjualan Tunai: " +
          formatCurrency(currentShift.cashSales || 0)
      );
      msg.push(
        "Penjualan Non-Tunai: " +
          formatCurrency(currentShift.nonCashSales || 0)
      );
      msg.push(
        "Total Penjualan: " +
          formatCurrency(currentShift.totalSales || 0)
      );
      msg.push(
        "Saldo Awal: " + formatCurrency(currentShift.openingCash || 0)
      );
      msg.push(
        "Saldo Harusnya (Saldo Awal + Semua Penjualan): " +
          formatCurrency(currentShift.expectedCash || 0)
      );
      const closingVal =
        typeof currentShift.closingCash === "number"
          ? currentShift.closingCash
          : closing;
      msg.push(
        "Saldo Akhir (input): " + formatCurrency(closingVal || 0)
      );
      const variance =
        typeof currentShift.cashVariance === "number"
          ? currentShift.cashVariance
          : closingVal - (currentShift.expectedCash || 0);
      msg.push("Selisih Kas: " + formatCurrency(variance || 0));
      alert(msg.join("\n"));
      try {
        if (confirm("Cetak laporan shift ini?")) {
          const title =
            (appSettings && appSettings.storeName) || "Laporan Shift Kasir";
          printShiftSummary(msg, title);
        }
      } catch (e) {}
    } else {
      alert("Shift berhasil ditutup.");
    }
  } catch (e) {
    console.error("closeShiftFlow error:", e);
    alert("Gagal menutup shift: " + (e.message || e));
  }
}

function printShiftSummary(lines, title) {
  try {
    if (!Array.isArray(lines) || !lines.length) return;
    const win = window.open("", "_blank", "width=480,height=640");
    if (!win) {
      alert(
        "Popup cetak diblokir browser. Izinkan popup untuk mencetak laporan shift."
      );
      return;
    }
    const doc = win.document;
    const esc = (s) =>
      String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const safeText = esc(lines.join("\n"));
    const safeTitle = esc(title || "Laporan Shift Kasir");
    const safeDate = esc(new Date().toLocaleString("id-ID"));
    doc.open();
    doc.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <style>
    @page { margin: 4mm; }
    body{
      font-family: "Courier New", monospace;
      font-size: 11px;
      margin: 0;
      padding: 4px;
    }
    .receipt{
      width: 58mm;
      max-width: 100%;
    }
    h3{
      text-align:center;
      margin:0 0 4px 0;
      font-size:13px;
    }
    .meta{
      text-align:center;
      font-size:10px;
      margin-bottom:4px;
    }
    hr{
      border:0;
      border-top:1px dashed #000;
      margin:4px 0;
    }
    pre{
      white-space:pre-wrap;
      word-wrap:break-word;
      margin:0;
    }
  </style>
</head>
<body>
  <div class="receipt">
    <h3>${safeTitle}</h3>
    <div class="meta">Laporan Shift Kasir<br/>${safeDate}</div>
    <hr />
    <pre>${safeText}</pre>
  </div>
  <script>
    window.focus();
    setTimeout(function(){ window.print(); }, 200);
  <\/script>
</body>
</html>`);
    doc.close();
  } catch (e) {}
}

function computeTotals() {
  let baseSubtotal = 0;
  let perProductDiscountTotal = 0;
  let perProductTaxTotal = 0;
  const items = cart;
  let afterItemDiscountSubtotal = 0;
  items.forEach((item) => {
    const product = products.find((p) => p.id === item.productId) || {};
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
  if (discountType === "percent" && discVal > 0) {
    cartDiscount = Math.round(afterItemDiscountSubtotal * (discVal / 100));
  } else if (discountType === "amount" && discVal > 0) {
    cartDiscount = Math.round(discVal);
  }
  if (cartDiscount > afterItemDiscountSubtotal)
    cartDiscount = afterItemDiscountSubtotal;

  const netAfterCartDiscount = afterItemDiscountSubtotal - cartDiscount;
  const globalTax = priceIncludesTax
    ? 0
    : Math.round(netAfterCartDiscount * (taxRate / 100));
  const serviceAmount = priceIncludesTax
    ? 0
    : Math.round(netAfterCartDiscount * (serviceRate / 100));
  const taxAmount = perProductTaxTotal + globalTax;
  const grandTotal = netAfterCartDiscount + taxAmount + serviceAmount;

  const subtotal = baseSubtotal;
  const discountAmount = perProductDiscountTotal + cartDiscount;
  return { subtotal, discountAmount, taxAmount, serviceAmount, grandTotal };
}

async function loadSettingsPOS() {
  try {
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (!res.ok) return;
    appSettings = await res.json();
    const name = appSettings?.storeName || "POS System";
    try {
      document.title = name + " - Kasir";
    } catch {}
    const brand = document.getElementById("brandName");
    if (brand) brand.textContent = name;
    const brandLogo = document.getElementById("brandLogo");
    if (brandLogo) {
      if (appSettings?.logoBase64) {
        brandLogo.src = appSettings.logoBase64;
        brandLogo.style.display = "inline-block";
      } else {
        brandLogo.style.display = "none";
        brandLogo.src = "";
      }
    }
    // Apply theme color
    const theme = appSettings?.themeColor || "#198754";
    let styleEl = document.getElementById("themeStylePos");
    const css = `
        .navbar { background-color: ${theme} !important; }
        .btn-primary { background-color: ${theme} !important; border-color: ${theme} !important; }
        .form-check-input:checked { background-color: ${theme}; border-color: ${theme}; }
        .badge.bg-secondary { background-color: ${theme} !important; }
      `;
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "themeStylePos";
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = css;
    // Refresh favicon: use base64 if available, otherwise use default favicon
    const link = document.querySelector('link[rel="icon"]');
    if (link) {
      const v = Date.now();
      if (appSettings?.faviconBase64) {
        // Use base64 favicon from settings
        link.setAttribute("href", appSettings.faviconBase64);
      } else {
        // Use default favicon with cache busting
        link.setAttribute("href", `/favicon.ico?v=${v}`);
      }
    }
  } catch (e) {
    // ignore
  }
}

async function fetchUserInfo() {
  if (userNameSpan) {
    userNameSpan.textContent = "Cashier";
  }
}

async function loadCategories() {
  try {
    const res = await fetch("/api/categories", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load categories");
    categories = await res.json();
    console.log("Categories fetched:", categories.length);
    // populateCategoryDropdown() tidak dipanggil di sini lagi
  } catch (error) {
    console.error("Failed to load categories:", error);
  }
}

function populateCategoryDropdown() {
  if (!categoryDropdownMenu) return;

  const itemsToKeep = categoryDropdownMenu.querySelectorAll(
    "li:first-child, li:nth-child(2)"
  );
  categoryDropdownMenu.innerHTML = "";
  itemsToKeep.forEach((item) => categoryDropdownMenu.appendChild(item));

  const hasStockByCategory = new Map();
  products.forEach((p) => {
    const cid = p.categoryId;
    if (cid == null) return;
    if (!hasStockByCategory.has(cid)) hasStockByCategory.set(cid, false);
    if ((p.stock || 0) > 0) hasStockByCategory.set(cid, true);
  });

  categories.forEach((category) => {
    if (!hasStockByCategory.get(category.id)) return; // only show categories with stock
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.classList.add("dropdown-item");
    a.href = "#";
    a.setAttribute("data-category-id", category.id);
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
        bannerContainer.innerHTML = "";
      }
      return;
    }

    const res = await fetch("/api/banner", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load banner");
    const banner = await res.json();
    const bannerImage =
      banner && banner.imageBase64 ? banner.imageBase64 : PLACEHOLDER_IMAGE;
    if (bannerContainer) {
      const title = banner && banner.title ? banner.title : "";
      const subtitle = banner && banner.subtitle ? banner.subtitle : "";
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
    console.error("Failed to load banner:", error);
  }
}

async function loadQrisImage() {
  try {
    const res = await fetch("/api/qris", { cache: "no-store" });
    const qris = await res.json();
    qrisConfig = qris || {};

    if (qrisConfig && typeof qrisConfig.imageBase64 === "string" && qrisConfig.imageBase64.startsWith("data:image")) {
      qrisImageSrc = qrisConfig.imageBase64;
    } else {
      qrisImageSrc = PLACEHOLDER_IMAGE;
    }

    const qrisCheckoutImage = document.getElementById("qrisCheckoutImage");
    if (qrisCheckoutImage) {
      qrisCheckoutImage.src = qrisImageSrc;
    }

    // Apply payment method logos (QRIS, DANA, OVO) based on QRIS config
    try {
      const configs = [
        { inputId: "payQris", field: "paymentLogoQrisBase64", label: "QRIS" },
        { inputId: "payDana", field: "paymentLogoDanaBase64", label: "DANA" },
        { inputId: "payOvo", field: "paymentLogoOvoBase64", label: "OVO" },
      ];

      configs.forEach((cfg) => {
        const input = document.getElementById(cfg.inputId);
        if (!input) return;
        const wrapper = input.closest(".form-check") || input.parentElement;
        const label = input.nextElementSibling;
        const src = qrisConfig && qrisConfig[cfg.field];
        const hasLogo = typeof src === "string" && src.startsWith("data:image");

        if (!hasLogo) {
          if (wrapper) wrapper.style.display = "none";
          input.checked = false;
          return;
        }

        if (wrapper) wrapper.style.display = "";
        if (label && label.classList && label.classList.contains("form-check-label")) {
          label.innerHTML =
            '<img src="' +
            src +
            '" alt="' +
            cfg.label +
            ' Logo" class="payment-logo me-2" style="max-height:24px; object-fit:contain;"> ' +
            cfg.label;
        }
      });

      // Normalisasi pilihan payment method: hanya izinkan metode yang masih terlihat.
      const radios = Array.from(
        document.querySelectorAll('input[name="paymentMethod"]')
      );
      const visibleRadios = radios.filter((r) => r.offsetParent !== null);
      let current = radios.find((r) => r.checked);
      if (!current || current.offsetParent === null) {
        // Pilih cash jika ada dan terlihat, kalau tidak pilih opsi pertama yang terlihat
        const fallback =
          visibleRadios.find((r) => r.value === "cash") || visibleRadios[0];
        if (fallback) {
          fallback.checked = true;
          try {
            localStorage.setItem("pos_paymentMethod", fallback.value);
          } catch (e2) {}
        }
      }
    } catch (e) {}
  } catch (error) {
    console.error("Failed to load QRIS image:", error);
  }
}

async function loadCustomers() {
  try {
    const res = await fetch("/api/customers", { cache: "no-store" });
    if (!res.ok) {
      console.warn("Failed to load customers, using fallback");
      customers = [{ id: 1, name: "Pelanggan Umum" }];
      populateCustomerSelect();
      return;
    }
    customers = await res.json();
    console.log("Customers loaded:", customers.length);
    populateCustomerSelect();
  } catch (error) {
    console.error("Failed to load customers:", error);
    // Fallback to default customer only
    customers = [{ id: 1, name: "Pelanggan Umum" }];
    populateCustomerSelect();
  }
}

function populateCustomerSelect() {
  if (!customerSelect) return;

  // Clear existing options except default
  const defaultOption = customerSelect.querySelector('option[value="default"]');
  customerSelect.innerHTML = "";
  customerSelect.appendChild(defaultOption);

  // Add customer options
  customers.forEach((customer) => {
    if (customer.id !== 1) {
      // Skip default customer as it's already added
      const option = document.createElement("option");
      option.value = customer.id.toString();
      option.textContent = customer.name;
      customerSelect.appendChild(option);
    }
  });

  // Set selected customer
  if (selectedCustomer && selectedCustomer.id !== "default") {
    customerSelect.value = selectedCustomer.id.toString();
  }
  updateCustomerInfo();
}

function updateCustomerInfo() {
  if (!customerInfo) return;

  if (selectedCustomer.id === "default") {
    customerInfo.innerHTML = `
          <strong>Pelanggan Umum</strong><br>
          <span class="text-muted">Tidak ada informasi tambahan</span>
      `;
  } else {
    const customer = customers.find(
      (c) => c.id.toString() === selectedCustomer.id.toString()
    );
    if (customer) {
      customerInfo.innerHTML = (
        "<strong>" +
        customer.name +
        "</strong><br>" +
        (customer.phone
          ? '<span class="text-muted">📱 ' + customer.phone + "</span><br>"
          : "") +
        (customer.email
          ? '<span class="text-muted">✉️ ' + customer.email + "</span><br>"
          : "") +
        (customer.address
          ? '<span class="text-muted">📍 ' + customer.address + "</span>"
          : "")
      ).trim();
    }
  }
}

// Gunakan productMap yang sudah dideklarasikan sebelumnya
// var productMap = new Map();

async function loadProducts() {
  try {
    console.log("Fetching products from API...");
    const res = await fetchWithCache("/api/products");
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    const data = await res.json();

    // PERBAIKAN: Validasi data produk
    if (!Array.isArray(data)) {
      console.warn("Products data is not an array, using empty array");
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

  console.log(
    "[FILTER] currentFilter=",
    currentFilter,
    "category=",
    currentCategory,
    "search=",
    searchTerm
  );
  let filteredProducts = Array.isArray(products) ? [...products] : [];

  // OPTIMASI: Gunakan loop for tradisional untuk performa lebih baik
  if (currentCategory !== "all") {
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
      const productNameMatch =
        product.name &&
        product.name.toLowerCase().includes(lowerCaseSearchTerm);

      // OPTIMASI: Gunakan Map untuk lookup kategori
      let categoryNameMatch = false;
      if (product.categoryId) {
        const category = categories.find((c) => c.id === product.categoryId);
        categoryNameMatch =
          category &&
          category.name &&
          category.name.toLowerCase().includes(lowerCaseSearchTerm);
      }

      if (productNameMatch || categoryNameMatch) {
        result.push(product);
      }
    }
    filteredProducts = result;
  }

  if (currentFilter === "top") {
    filteredProducts = filteredProducts.filter(
      (p) => p && p.isTopProduct === true
    );
  } else if (currentFilter === "best") {
    filteredProducts = filteredProducts.filter(
      (p) => p && p.isBestSeller === true
    );
  } else if (currentFilter === "discounted") {
    // Use explicit flag; fallback to computed when flag not present
    const byFlag = filteredProducts.filter((p) => p && p.isDiscounted === true);
    if (byFlag.length > 0) {
      filteredProducts = byFlag;
    } else {
      const byPercent = (p) => Number(p.discountPercent || 0) > 0;
      const bySalePrice = (p) => {
        const sp = Number(p.salePrice);
        const pr = Number(p.price);
        return Number.isFinite(sp) && Number.isFinite(pr) && sp >= 0 && sp < pr;
      };
      filteredProducts = filteredProducts.filter(
        (p) => byPercent(p) || bySalePrice(p)
      );
    }
  }
  console.log("[FILTER] result count=", filteredProducts.length);
  // Sort newest -> oldest by updatedAt/createdAt/date/timestamp/id
  try {
    const ts = (v) => {
      const cands = [
        v?.updatedAt,
        v?.createdAt,
        v?.created_at,
        v?.date,
        v?.timestamp,
        v?.id,
      ];
      for (const x of cands) {
        if (x != null) {
          const n = new Date(x).valueOf();
          if (!isNaN(n)) return n;
          if (typeof x === "number") return x;
        }
      }
      return 0;
    };
    filteredProducts.sort((a, b) => ts(b) - ts(a));
  } catch {}

  return filteredProducts;
}

function renderProducts() {
  if (!productList) return;

  // Prevent concurrent renders
  if (isRendering) {
    console.warn("Render already in progress, skipping...");
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
            if (
              activeTooltips[i] &&
              typeof activeTooltips[i].dispose === "function"
            ) {
              activeTooltips[i].dispose();
            }
          } catch (e) {}
        }
        activeTooltips = [];
      }

      // Optimasi: Hanya dispose tooltip yang terlihat
      const visibleTooltips = document.querySelectorAll(
        '[data-bs-toggle="tooltip"]:hover, [data-bs-toggle="tooltip"]:focus'
      );
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
      productList.innerHTML =
        '<div class="col-12"><p class="text-muted">Produk tidak ditemukan.</p></div>';
      isRendering = false;
      return;
    }

    // OPTIMASI: Batasi jumlah produk yang dirender sekaligus untuk menghindari jank
    const maxProductsPerRender = Math.min(filteredProducts.length, 500);
    const productsToRender = filteredProducts.slice(0, maxProductsPerRender);

    productList.innerHTML = productsToRender
      .map((product) => {
        const productId = product.id || 0;
        const productName = product.name || "Produk Tidak Dikenal";
        const productPriceNum = Number(product.price || 0);
        const productStock = product.stock || 0;
        const productImage = product.imageBase64 || PLACEHOLDER_IMAGE;
        const tooltipContent =
          "<strong>" +
          productName +
          '</strong><img src="' +
          productImage +
          '" alt="' +
          productName +
          '">';

        const salePriceNum = Number(product.salePrice);
        const discountPercentNum = Number(product.discountPercent || 0);
        let discountedPrice = null;
        if (
          Number.isFinite(salePriceNum) &&
          Number.isFinite(productPriceNum) &&
          salePriceNum >= 0 &&
          salePriceNum < productPriceNum
        ) {
          discountedPrice = salePriceNum;
        } else if (discountPercentNum > 0 && Number.isFinite(productPriceNum)) {
          discountedPrice = Math.max(
            0,
            Math.round(productPriceNum * (1 - discountPercentNum / 100))
          );
        }

        const priceHtml =
          discountedPrice != null
            ? '<p class="card-text mb-1"><del>' +
              formatCurrency(productPriceNum) +
              '</del> <span class="text-danger fw-semibold ms-1">' +
              formatCurrency(discountedPrice) +
              "</span></p>"
            : '<p class="card-text mb-1">' +
              formatCurrency(productPriceNum) +
              "</p>";

        const isTop = !!product.isTopProduct;
        const isBest = !!product.isBestSeller;
        const isDiscFlag = !!product.isDiscounted;
        const hasVariants =
          Array.isArray(product.unitPrices) && product.unitPrices.length > 0;
        // Determine discount percent for badge label
        let discPct = 0;
        if (discountPercentNum > 0) {
          discPct = Math.round(discountPercentNum);
        } else if (
          discountedPrice != null &&
          Number.isFinite(productPriceNum) &&
          productPriceNum > 0
        ) {
          const pct =
            100 - Math.round((discountedPrice / productPriceNum) * 100);
          discPct = Math.max(0, pct);
        }
        const showDiscBadge = isDiscFlag || discountedPrice != null;
        const discLabel = discPct > 0 ? "Diskon " + discPct + "%" : "Diskon";
        const badges =
          '<div class="badge-stack">' +
          (isTop ? '<span class="badge bg-warning text-dark">TOP</span>' : "") +
          (isBest ? '<span class="badge bg-primary">BEST</span>' : "") +
          (showDiscBadge
            ? '<span class="badge bg-danger">' + discLabel + "</span>"
            : "") +
          (hasVariants ? '<span class="badge bg-info">VARIAN</span>' : "") +
          (productStock <= 0
            ? '<span class="badge bg-secondary">HABIS</span>'
            : "") +
          "</div>";

        return (
          '<div class="col-md-6 col-lg-4"><div class="card product-card h-100 position-relative" onclick="addToCart(' +
          productId +
          ')">' +
          badges +
          '<img src="' +
          productImage +
          '" class="card-img-top" alt="' +
          productName +
          '" data-bs-toggle="tooltip" data-bs-html="true" data-bs-title="' +
          tooltipContent.replace(/"/g, "&quot;") +
          '"><div class="card-body"><h5 class="card-title">' +
          productName +
          "</h5>" +
          priceHtml +
          '<span class="badge bg-secondary">Stock: ' +
          productStock +
          "</span></div></div></div>"
        );
      })
      .join("");

    // PERBAIKAN: Initialize tooltips and track them
    try {
      const newTooltipTriggerList = [].slice.call(
        document.querySelectorAll('[data-bs-toggle="tooltip"]')
      );
      newTooltipTriggerList.forEach(function (tooltipTriggerEl) {
        try {
          const tooltip = new bootstrap.Tooltip(tooltipTriggerEl, {
            trigger: "hover focus",
            placement: "auto",
            delay: { show: 300, hide: 100 },
          });
          activeTooltips.push(tooltip);
        } catch (e) {
          console.warn("Error creating tooltip:", e);
        }
      });
    } catch (e) {
      console.warn("Error initializing tooltips:", e);
    }

    isRendering = false;
  });
}

function addToCart(productId) {
  // PERBAIKAN: Validasi produk dan stok
  const product = products.find((p) => p.id === productId);
  if (!product) {
    console.warn("Product not found:", productId);
    return;
  }

  // Jika produk memiliki varian harga → SELALU tampilkan modal (nonaktifkan auto-add)
  if (Array.isArray(product.unitPrices) && product.unitPrices.length > 0) {
    try {
      console.log("[POS] addToCart: product has variants", {
        id: product.id,
        name: product.name,
        variants: product.unitPrices.length,
      });
      openVariantSelection(product);
      return; // lanjut setelah user konfirmasi
    } catch (e) {
      console.warn("Variant selection failed, fallback to base price", e);
    }
  }

  // PERBAIKAN: Validasi stok sebelum menambah ke keranjang
  const currentStock = Number(product.stock || 0);
  const existingItem = cart.find((item) => item.productId === productId);
  const currentQty = existingItem ? existingItem.qty || 0 : 0;

  if (currentStock <= 0) {
    console.warn(
      "Produk ini habis, tetapi diizinkan untuk ditambahkan ke keranjang."
    );
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
      name: product.name || "Unknown Product",
      price: product.price || 0,
      qty: 1,
    });
  }

  // Putar suara notifikasi jika diaktifkan
  if (
    appSettings &&
    appSettings.enableCartSound &&
    appSettings.cartSoundBase64
  ) {
    try {
      const audio = new Audio(appSettings.cartSoundBase64);
      audio.play();
    } catch (e) {
      console.warn("Gagal memutar suara notifikasi", e);
    }
  }

  renderCart();
}

function openVariantSelection(product) {
  pendingVariantProduct = product;
  selectedVariantIdx = 0;
  if (!variantSelectModal) {
    const el = document.getElementById("variantSelectModal");
    if (el && window.bootstrap)
      variantSelectModal = bootstrap.Modal.getOrCreateInstance(el);
  }
  if (!variantOptionsBox) return;
  try {
    console.log("[POS] openVariantSelection", {
      id: product?.id,
      name: product?.name,
      variants: Array.isArray(product?.unitPrices)
        ? product.unitPrices.length
        : 0,
    });
  } catch {}
  const opts = (product.unitPrices || [])
    .map((v, idx) => {
      const qty = Number(v.qty || 0);
      const unit = String(v.unit || "").trim();
      const price = Number(v.price || 0);
      const note = String(v.note || v.desc || v.keterangan || "").trim();
      const safeNote = note
        ? note
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
        : "";
      const id = "variant_" + product.id + "_" + idx;
      return (
        '<div class="form-check mb-1">' +
        '<input class="form-check-input" type="radio" name="variantOption" id="' +
        id +
        '" value="' +
        idx +
        '" ' +
        (idx === 0 ? "checked" : "") +
        ">" +
        '<label class="form-check-label" for="' +
        id +
        '">' +
        "<strong>" +
        qty +
        " " +
        unit +
        "</strong> — " +
        formatCurrency(price) +
        (safeNote
          ? ' <small class="text-muted">- ' + safeNote + "</small>"
          : "") +
        "</label>" +
        "</div>"
      );
    })
    .join("");
  variantOptionsBox.innerHTML =
    opts || '<p class="text-muted">Tidak ada varian tersedia.</p>';
  // bind change
  variantOptionsBox
    .querySelectorAll('input[name="variantOption"]')
    .forEach((r) => {
      r.addEventListener("change", (e) => {
        selectedVariantIdx = parseInt(e.target.value) || 0;
      });
    });
  if (confirmVariantBtn && !confirmVariantBtn._bound) {
    confirmVariantBtn._bound = true;
    confirmVariantBtn.addEventListener("click", () => {
      try {
        applySelectedVariant();
      } catch (e) {
        console.warn(e);
      }
    });
  }
  if (variantSelectModal) {
    variantSelectModal.show();
  } else {
    const el = document.getElementById("variantSelectModal");
    if (el) {
      el.classList.add("show");
      el.style.display = "block";
      el.removeAttribute("aria-hidden");
      el.setAttribute("aria-modal", "true");
      document.body.classList.add("modal-open");
      let backdrop = document.querySelector(".modal-backdrop");
      if (!backdrop) {
        backdrop = document.createElement("div");
        backdrop.className = "modal-backdrop fade show";
        document.body.appendChild(backdrop);
      }
    }
  }
}

function applySelectedVariant() {
  if (!pendingVariantProduct) return;
  const product = pendingVariantProduct;
  const list = Array.isArray(product.unitPrices) ? product.unitPrices : [];
  const idx = Math.min(
    Math.max(0, selectedVariantIdx || 0),
    Math.max(0, list.length - 1)
  );
  const chosen = list[idx] || {};
  const variantQty = Number(chosen.qty || 1);
  const variantUnit = String(chosen.unit || "");
  const variantPrice = Number(chosen.price || 0);
  const variantNote = String(
    chosen.note || chosen.desc || chosen.keterangan || ""
  );
  try {
    console.log("[POS] applySelectedVariant", {
      productId: product?.id,
      productName: product?.name,
      selectedIndex: idx,
      variantQty,
      variantUnit,
      variantPrice,
    });
  } catch {}

  // Tambahkan sebagai paket: qty item = 1 paket, price = harga paket
  cart.push({
    productId: product.id,
    name: product.name || "Unknown Product",
    price: variantPrice,
    qty: 1,
    variantQty,
    variantUnit,
    variantNote,
  });
  if (variantSelectModal) {
    variantSelectModal.hide();
  } else {
    const el = document.getElementById("variantSelectModal");
    if (el) {
      el.classList.remove("show");
      el.style.display = "none";
      el.setAttribute("aria-hidden", "true");
      el.removeAttribute("aria-modal");
    }
    document.body.classList.remove("modal-open");
    document.querySelectorAll(".modal-backdrop").forEach((b) => {
      try {
        b.remove();
      } catch {}
    });
  }
  pendingVariantProduct = null;
  selectedVariantIdx = -1;
  // Putar suara notifikasi jika diaktifkan (untuk varian)
  if (
    appSettings &&
    appSettings.enableCartSound &&
    appSettings.cartSoundBase64
  ) {
    try {
      const audio = new Audio(appSettings.cartSoundBase64);
      audio.play();
    } catch (e) {
      console.warn('Gagal memutar suara notifikasi', e);
    }
  }
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
    // Reset discount when cart is empty
    discountValue = 0;
    if (discountValueInput) discountValueInput.value = "0";
    try {
      localStorage.setItem("pos_discountValue", "0");
    } catch (e) {}
    
    cartItems.innerHTML = '<p class="text-muted">Keranjang kosong.</p>';
    if (cartSubtotalSpan) cartSubtotalSpan.textContent = formatCurrency(0);
    if (cartDiscountSpan) cartDiscountSpan.textContent = formatCurrency(0);
    if (cartTaxSpan) cartTaxSpan.textContent = formatCurrency(0);
    if (cartServiceSpan) cartServiceSpan.textContent = formatCurrency(0);
    cartTotal.textContent = formatCurrency(0);
    try {
      // OPTIMASI: Gunakan localStorage hanya jika nilai berubah
      const currentCart = localStorage.getItem("pos_cart");
      if (currentCart !== "[]") {
        localStorage.setItem("pos_cart", "[]");
      }
    } catch (e) {}
    // Save empty cart to server (skip if manual refresh rendering)
    try {
      lastLocalCartAt = Date.now();
      try {
        localStorage.setItem("pos_cart_updatedAt", String(lastLocalCartAt));
      } catch (e) {}
      if (!suppressCartSave) scheduleSaveCart();
    } catch (e) {}
    return;
  }

  // OPTIMASI: Gunakan DocumentFragment untuk mengurangi reflow
  const fragment = document.createDocumentFragment();
  const tempContainer = document.createElement("div");

  // OPTIMASI: Buat HTML string sekali saja daripada map+join
  let cartHtml = "";
  for (let i = 0; i < cart.length; i++) {
    const item = cart[i];
    const itemName = item.name || "Item Tidak Dikenal";
    const itemPrice = item.price || 0;
    const itemQty = item.qty || 0;

    // OPTIMASI: Gunakan Map untuk lookup produk daripada find
    const product = productMap.get(item.productId) || {};
    const productStock = product.stock || 0;
    const noteRaw = String(item.variantNote || "").trim();
    const noteEsc = noteRaw
      ? noteRaw
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
      : "";
    const variantMeta =
      item.variantQty && item.variantUnit
        ? '<br><small class="text-muted">Varian: ' +
          item.variantQty +
          " " +
          item.variantUnit +
          (noteEsc ? " - " + noteEsc : "") +
          "</small>"
        : noteEsc
        ? '<br><small class="text-muted">' + noteEsc + "</small>"
        : "";

    cartHtml +=
      '<div class="d-flex justify-content-between align-items-center mb-2"><div><strong>' +
      itemName +
      "</strong>" +
      variantMeta +
      "<br><small>" +
      formatCurrency(itemPrice) +
      " x " +
      itemQty +
      "</small>" +
      (productStock < itemQty
        ? '<br><small class="text-danger">⚠ Stok terbatas</small>'
        : "") +
      '</div><div class="d-flex align-items-center gap-1"><button class="btn btn-sm btn-outline-secondary qty-btn" data-action="decrease" data-index="' +
      i +
      '">-</button><input type="number" class="form-control form-control-sm text-center qty-input" style="width: 60px; flex-shrink: 0;" min="1" value="' +
      itemQty +
      '" data-index="' +
      i +
      '"><button class="btn btn-sm btn-outline-secondary qty-btn" data-action="increase" data-index="' +
      i +
      '">+</button><button class="btn btn-sm btn-outline-primary ms-2 edit-price-btn" data-index="' +
      i +
      '">Edit</button><button class="btn btn-sm btn-danger ms-2 remove-btn" data-index="' +
      i +
      '">&times;</button></div></div>';
  }

  tempContainer.innerHTML = cartHtml;
  while (tempContainer.firstChild) {
    fragment.appendChild(tempContainer.firstChild);
  }

  // Kosongkan dan tambahkan fragment
  cartItems.innerHTML = "";
  cartItems.appendChild(fragment);

  // OPTIMASI: Gunakan event delegation untuk mengurangi jumlah event listener
  const cartClickHandler = (e) => {
    const target = e.target;
    if (target.classList.contains("qty-btn")) {
      const index = parseInt(target.dataset.index);
      if (isNaN(index)) return;
      const action = target.dataset.action;
      updateCartQty(index, action === "increase" ? 1 : -1);
    } else if (target.classList.contains("remove-btn")) {
      const index = parseInt(target.dataset.index);
      if (isNaN(index)) return;
      removeFromCart(index);
    } else if (target.classList.contains("edit-price-btn")) {
      const index = parseInt(target.dataset.index);
      if (isNaN(index)) return;
      openCustomPriceModal(index);
    }
  };
  cartItems.addEventListener("click", cartClickHandler);
  cartEventListeners.push(() =>
    cartItems.removeEventListener("click", cartClickHandler)
  );

  // Attach change listeners untuk input
  const qtyInputs = cartItems.querySelectorAll(".qty-input");
  for (let i = 0; i < qtyInputs.length; i++) {
    const input = qtyInputs[i];
    const handler = (e) => {
      const index = parseInt(e.target.dataset.index);
      if (isNaN(index)) return;
      setCartQty(index, e.target.value);
    };
    input.addEventListener("change", handler);
    cartEventListeners.push(() => input.removeEventListener("change", handler));
  }

  // OPTIMASI: Hitung total hanya sekali
  const totals = computeTotals();
  if (cartSubtotalSpan)
    cartSubtotalSpan.textContent = formatCurrency(totals.subtotal);
  if (cartDiscountSpan)
    cartDiscountSpan.textContent = formatCurrency(totals.discountAmount);
  if (cartTaxSpan) cartTaxSpan.textContent = formatCurrency(totals.taxAmount);
  if (cartServiceSpan)
    cartServiceSpan.textContent = formatCurrency(totals.serviceAmount);
  cartTotal.textContent = formatCurrency(totals.grandTotal);

  // OPTIMASI: Simpan ke localStorage hanya jika perlu
  try {
    const cartJson = JSON.stringify(cart);
    const currentCart = localStorage.getItem("pos_cart");
    if (currentCart !== cartJson) {
      localStorage.setItem("pos_cart", cartJson);
    }
  } catch (e) {}
  // Update local change time and schedule remote save (skip if manual refresh rendering)
  try {
    lastLocalCartAt = Date.now();
    try {
      localStorage.setItem("pos_cart_updatedAt", String(lastLocalCartAt));
    } catch (e) {}
    if (!suppressCartSave) scheduleSaveCart();
  } catch (e) {}
}

function openCustomPriceModal(index) {
  if (index < 0 || index >= cart.length) return;

  const item = cart[index];
  if (!item) return;

  let product = null;
  try {
    product = products.find((p) => p.id === item.productId) || null;
  } catch (e) {}

  const originalPrice =
    product && typeof product.price === "number"
      ? product.price
      : item.price || 0;

  if (customPriceProductNameInput) {
    customPriceProductNameInput.value = item.name || "";
  }
  if (customPriceOriginalInput) {
    customPriceOriginalInput.value = formatCurrency(originalPrice);
  }
  if (customPriceValueInput) {
    const currentPrice = item.price || originalPrice || 0;
    customPriceValueInput.value = String(currentPrice);
  }

  currentCustomPriceIndex = index;

  if (!customPriceModal) {
    try {
      const el = document.getElementById("customPriceModal");
      if (el && window.bootstrap && typeof bootstrap.Modal !== "undefined") {
        customPriceModal = bootstrap.Modal.getOrCreateInstance(el);
      }
    } catch (e) {}
  }

  if (customPriceModal) {
    try {
      customPriceModal.show();
    } catch (e) {}
  }
}

function setCartQty(index, newQty) {
  if (index < 0 || index >= cart.length) return;

  const product = products.find((p) => p.id === cart[index].productId);
  if (!product) {
    console.warn("Product not found for cart item at index:", index);
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

  const product = products.find((p) => p.id === cart[index].productId);
  if (!product) {
    console.warn("Product not found for cart item at index:", index);
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
    console.warn("draftsList element not found");
    return;
  }
  try {
    const res = await fetch("/api/drafts", { cache: "no-store" });
    if (!res.ok) {
      console.warn("Failed to fetch drafts, showing empty list");
      drafts = [];
      renderDrafts();
      return;
    }
    const data = await res.json();

    // PERBAIKAN: Validasi data drafts
    if (!Array.isArray(data)) {
      console.warn("Drafts data is not an array, using empty array");
      drafts = [];
    } else {
      drafts = data;
    }

    console.log("Drafts loaded:", drafts.length);
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

  let draftsInner = drafts
    .map((d) => {
      const total = d.items.reduce(
        (sum, item) => sum + (item.price || 0) * (item.qty || 0),
        0
      );
      return (
        '<div class="list-group-item">' +
        '<div class="d-flex w-100 justify-content-between">' +
        '<h6 class="mb-1">' +
        d.items.length +
        " Item</h6>" +
        "<small>" +
        new Date(d.timestamp).toLocaleString() +
        "</small>" +
        "</div>" +
        '<p class="mb-1">Total: ' +
        formatCurrency(total) +
        "</p>" +
        '<div class="btn-group btn-group-sm" role="group">' +
        '<button class="btn btn-outline-primary" onclick="loadDraftToCart(\'' +
        d.id +
        "')\">Muat</button>" +
        '<button class="btn btn-outline-danger" onclick="deleteDraft(\'' +
        d.id +
        "')\">Hapus</button>" +
        "</div>" +
        "</div>"
      );
    })
    .join("");
  draftsList.innerHTML = '<div class="list-group">' + draftsInner + "</div>";
}

async function saveDraft() {
  if (cart.length === 0) {
    alert("Keranjang kosong! Tidak ada yang bisa disimpan.");
    return;
  }

  try {
    const res = await fetch("/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: cart }),
    });
    const result = await res.json();

    if (!res.ok) throw new Error(result.message || "Failed to save draft");

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
  if (
    !confirm(
      "Memuat draf ini akan mengganti keranjang saat ini. Apakah Anda yakin?"
    )
  ) {
    return;
  }
  try {
    const res = await fetch(`/api/drafts/${draftId}/load`, { method: "PUT" });
    const result = await res.json();

    if (!res.ok) throw new Error(result.message || "Failed to load draft");

    cart = result.items;
    renderCart();

    // Hapus draf dari server agar tidak duplikat ketika disimpan lagi
    try {
      await fetch(`/api/drafts/${draftId}`, { method: "DELETE" });
    } catch {}
    // Hapus dari array lokal untuk update UI yang cepat, lalu refresh dari server
    drafts = drafts.filter((d) => d.id !== draftId);
    renderDrafts();
    try {
      await loadDrafts();
    } catch {}
  } catch (error) {
    console.error("Failed to load draft:", error);
    alert(`Gagal memuat draf: ${error.message}`);
  }
}

async function deleteDraft(draftId) {
  if (!confirm("Apakah Anda yakin ingin menghapus draf ini?")) {
    return;
  }
  try {
    const res = await fetch(`/api/drafts/${draftId}`, { method: "DELETE" });
    const result = await res.json();

    if (!res.ok) throw new Error(result.message || "Failed to delete draft");

    // Hapus dari array lokal dan render ulang
    drafts = drafts.filter((d) => d.id !== draftId);
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
    const res = await fetch("/api/recent-transactions", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to fetch recent transactions");
    const recentTransactionsData = await res.json();
    const sorted = Array.isArray(recentTransactionsData)
      ? [...recentTransactionsData].sort(
          (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
        )
      : [];
    // Compute best sellers by frequency
    try {
      const freq = new Map();
      (sorted || []).forEach((t) => {
        (t.items || []).forEach((it) => {
          const pid = it.productId ?? it.id;
          if (pid == null) return;
          freq.set(pid, (freq.get(pid) || 0) + (it.qty || 1));
        });
      });
      const ranked = Array.from(freq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 24);
      bestSellerIds = new Set(ranked.map((r) => r[0]));
    } catch (e) {
      bestSellerIds = new Set();
    }
    // Update POS debts summary based on recent transactions
    try {
      updatePosCustomerDebts(sorted);
    } catch (e) {
      console.warn("Failed to update POS customer debts summary:", e);
    }
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

  const txRows = transactions
    .map((t) => {
      const totalAmount = t.totalAmount || 0;
      const oversellBadge = t.oversell
        ? ' <span class="badge bg-danger">OVERSELL</span>'
        : "";
      return (
        "<tr>" +
        "<td>" +
        t.id +
        oversellBadge +
        "</td>" +
        "<td>" +
        new Date(t.timestamp).toLocaleTimeString() +
        "</td>" +
        "<td>" +
        formatCurrency(totalAmount) +
        "</td>" +
        '<td><button class="btn btn-sm btn-info" onclick="showTransactionDetails(\'' +
        t.id +
        "')\">Lihat</button></td>" +
        "</tr>"
      );
    })
    .join("");
  recentTransactionsList.innerHTML =
    '<div class="table-responsive">' +
    '<table class="table table-sm table-striped">' +
    "<thead><tr><th>ID</th><th>Waktu</th><th>Total</th><th>Aksi</th></tr></thead>" +
    "<tbody>" +
    txRows +
    "</tbody>" +
    "</table>" +
    "</div>";
}

function showTransactionDetails(transactionId) {
  const transaction = recentTransactions.find((t) => t.id === transactionId);
  if (!transaction) {
    console.error("Kesalahan: Transaction not found!");
    return;
  }

  transactionToVoidId = transactionId;
  const itemsHtml = transaction.items
    .map((item) => {
      const itemName = item.name || "Item Tidak Dikenal";
      const itemPrice = item.price || 0;
      const itemQty = item.qty || 0;
      const itemSubtotal = item.subtotal || itemPrice * itemQty;

      return `<tr>
          <td>${itemName}</td>
          <td>${formatCurrency(itemPrice)}</td>
          <td>${itemQty}</td>
          <td>${formatCurrency(itemSubtotal)}</td>
      </tr>`;
    })
    .join("");

  const transactionDetailsContent = document.getElementById(
    "transactionDetailsContent"
  );
  if (transactionDetailsContent) {
    const totalAmount = transaction.totalAmount || 0;
    transactionDetailsContent.innerHTML = `
      <p><strong>ID Transaksi</strong> ${transaction.id}</p>
      <p><strong>Tanggal & Waktu</strong> ${new Date(
        transaction.timestamp
      ).toLocaleString()}</p>
      <p><strong>Pelanggan</strong> ${transaction.customerName}</p>
      ${
        transaction.oversell
          ? '<p class="text-danger"><strong>Perhatian:</strong> Transaksi ini melewati stok yang tersedia.</p>'
          : ""
      }
      <hr>
      <div class="table-responsive">
          <table class="table">
              <thead><tr><th>Produk</th><th>Harga</th><th>Jml</th><th>Subtotal</th></tr></thead>
              <tbody>${itemsHtml}</tbody>
              <tfoot><tr><th colspan="3">Total</th><th>${formatCurrency(
                totalAmount
              )}</th></tr></tfoot>
          </table>
      </div>
      `;

    // Wire print button in details modal
    try {
      const btn = document.getElementById("printReceiptFromDetailsBtn");
      if (btn)
        btn.onclick = () => {
          try {
            printReceipt(transaction);
          } catch (e) {
            console.error(e);
          }
        };
    } catch {}

    // Show transaction details modal
    try {
      const el = document.getElementById("transactionDetailsModal");
      if (el && window.bootstrap && typeof bootstrap.Modal !== "undefined") {
        transactionDetailsModal = bootstrap.Modal.getOrCreateInstance(el);
        transactionDetailsModal.show();
      }
    } catch {}
    return;
}

// Function to show customer debt details in POS
function showPosCustomerDebtDetails(debtId) {
  const debt = posCustomerDebts.find((d) => d.id === debtId);
  if (!debt) {
    console.error("Kesalahan: Debt not found!");
    return;
  }

  const customerDebtDetailsContent = document.getElementById("customerDebtDetailsContent");
  if (customerDebtDetailsContent) {
    const itemsHtml = debt.items
      .map((item) => {
        const itemName = item.name || "Item Tidak Dikenal";
        const itemPrice = item.price || 0;
        const itemQty = item.qty || 0;
        const itemSubtotal = item.subtotal || itemPrice * itemQty;

        return `<tr>
            <td>${itemName}</td>
            <td>${formatCurrency(itemPrice)}</td>
            <td>${itemQty}</td>
            <td>${formatCurrency(itemSubtotal)}</td>
        </tr>`;
      })
      .join("");

    customerDebtDetailsContent.innerHTML = `
      <p><strong>ID Transaksi</strong> ${debt.id}</p>
      <p><strong>Tanggal & Waktu</strong> ${new Date(
        debt.timestamp
      ).toLocaleString()}</p>
      <p><strong>Pelanggan</strong> ${debt.customerName}</p>
      <p><strong>Metode Pembayaran</strong> ${debt.paymentMethod || 'Tunai'}</p>
      <p><strong>Total Harga</strong> ${formatCurrency(debt.totalAmount)}</p>
      <p><strong>Jumlah Dibayar</strong> ${formatCurrency(debt.paidAmount)}</p>
      <p><strong>Sisa Hutang</strong> ${formatCurrency(debt.remainingAmount)}</p>
      <p><strong>Status</strong> <span class="badge ${debt.status === 'Lunas' ? 'bg-success' : (debt.status.includes('Sebagian') ? 'bg-warning text-dark' : 'bg-danger')}">${debt.status}</span></p>
      ${
        debt.note ? `<p><strong>Catatan</strong> ${debt.note}</p>` : ""
      }
      <hr>
      <div class="table-responsive">
          <table class="table">
              <thead><tr><th>Produk</th><th>Harga</th><th>Jml</th><th>Subtotal</th></tr></thead>
              <tbody>${itemsHtml}</tbody>
              <tfoot><tr><th colspan="3">Total</th><th>${formatCurrency(
                debt.totalAmount
              )}</th></tr></tfoot>
          </table>
      </div>
    `;

    // Wire pay button in details modal
    try {
      const payBtn = document.getElementById("payDebtFromDetailsBtn");
      if (payBtn) {
        payBtn.onclick = () => {
          // Close details modal first
          const detailsModal = bootstrap.Modal.getInstance(document.getElementById("customerDebtDetailsModal"));
          if (detailsModal) detailsModal.hide();
          
          // Open payment modal
          setTimeout(() => {
            openPosCustomerPayment(debtId);
          }, 300);
        };
      }
    } catch {}

    // Wire print button in details modal
    try {
      const printBtn = document.getElementById("printDebtReceiptBtn");
      if (printBtn) {
        printBtn.onclick = () => {
          try {
            // Create a transaction object for printing
            const transactionForPrint = {
              ...debt,
              isDebtPayment: false
            };
            printReceipt(transactionForPrint);
          } catch (e) {
            console.error(e);
          }
        };
      }
    } catch {}

    // Show customer debt details modal
    try {
      const el = document.getElementById("customerDebtDetailsModal");
      if (el && window.bootstrap && typeof bootstrap.Modal !== "undefined") {
        const modal = bootstrap.Modal.getOrCreateInstance(el);
        modal.show();
      }
    } catch {}
  }
}

// Wrapper to trigger PDF generation/print from buttons
async function printReceipt(transaction) {
  try {
    await generateReceiptPDF(transaction);
    const pdfUrl = "receipt_" + transaction.id + ".pdf"; // This will be downloaded
    const message =
      "Struk pembelian dari " +
      (appSettings?.storeName || "Toko Kami") +
      "\nID Transaksi: " +
      transaction.id +
      "\nTotal: " +
      formatCurrency(transaction.totalAmount || 0) +
      "\n\nFile PDF struk telah didownload. Silakan bagikan ke WhatsApp.";
    
    // WhatsApp sharing (optional)
    if (typeof window.shareToWhatsApp === "function") {
      try {
        await window.shareToWhatsApp(message, pdfUrl);
      } catch (e) {
        console.warn("WhatsApp sharing failed:", e);
      }
    }
  } catch (error) {
    console.error("Error generating PDF:", error);
    alert("Gagal membuat PDF struk.");
  }
}

function startNewTransaction() {
  const isConfirmed = confirm(
    "Apakah Anda yakin ingin memulai transaksi baru? Keranjang saat ini akan dikosongkan."
  );
  if (isConfirmed) {
    // Reset discount to 0
    discountValue = 0;
    if (discountValueInput) discountValueInput.value = "0";
    try {
      localStorage.setItem("pos_discountValue", "0");
    } catch (e) {}
    
    // Menggunakan location.reload() adalah cara termudah untuk mereset semua state
    try {
      localStorage.removeItem("pos_cart");
    } catch (e) {}
    try {
      localStorage.setItem("pos_cart_updatedAt", String(Date.now()));
    } catch (e) {}
    try {
      clearServerCart();
    } catch (e) {}
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
  if (posStoreName) posStoreName.value = appSettings.storeName || "";
  if (posShowAddress)
    posShowAddress.checked = appSettings.showReceiptAddress !== false;
  if (posShowPhone)
    posShowPhone.checked = appSettings.showReceiptPhone !== false;
  if (posShowFooter)
    posShowFooter.checked = appSettings.showReceiptFooter !== false;
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
      showReceiptFooter: showFooter,
    };

    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.message || "Failed to save settings");

    // Update local appSettings
    appSettings = { ...appSettings, ...payload };

    // Update UI elements that depend on settings
    const name = appSettings?.storeName || "POS System";
    try {
      document.title = name + " - Kasir";
    } catch {}
    const brand = document.getElementById("brandName");
    if (brand) brand.textContent = name;

    posSettingsModal.hide();
    alert("Settings saved successfully!");
  } catch (error) {
    console.error("Failed to save POS settings:", error);
    alert("Failed to save settings: " + error.message);
  }
}

function setupEventListeners() {
  // Initialize Bootstrap modal instances used across POS
  try {
    const el = document.getElementById("posSettingsModal");
    if (el && window.bootstrap && typeof bootstrap.Modal !== "undefined") {
      posSettingsModal = bootstrap.Modal.getOrCreateInstance(el);
    }
  } catch {}
  try {
    const el = document.getElementById("checkoutModal");
    if (el && window.bootstrap && typeof bootstrap.Modal !== "undefined") {
      checkoutModal = bootstrap.Modal.getOrCreateInstance(el);
    }
  } catch {}
  try {
    const el = document.getElementById("transactionDetailsModal");
    if (el && window.bootstrap && typeof bootstrap.Modal !== "undefined") {
      transactionDetailsModal = bootstrap.Modal.getOrCreateInstance(el);
    }
  } catch {}
  try {
    const el = document.getElementById("paymentSuccessModal");
    if (el && window.bootstrap && typeof bootstrap.Modal !== "undefined") {
      paymentSuccessModal = bootstrap.Modal.getOrCreateInstance(el);
    }
  } catch {}

  // PERBAIKAN: Debounce search input untuk performa lebih baik
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
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
    clearSearchBtn.addEventListener("click", () => {
      // PERBAIKAN: Clear debounce timer saat clear
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
      }
      searchInput.value = "";
      searchTerm = "";
      renderProducts();
    });
  }

  if (categoryDropdownMenu) {
    categoryDropdownMenu.addEventListener("click", (e) => {
      e.preventDefault();
      if (e.target.classList.contains("dropdown-item")) {
        const categoryId = e.target.getAttribute("data-category-id");
        currentCategory = categoryId;

        if (categoryDropdownToggle) {
          categoryDropdownToggle.innerHTML =
            '<i class="bi bi-funnel"></i> ' + e.target.textContent;
        }
        renderProducts();
      }
    });
  }

  if (resetCategoryBtn) {
    resetCategoryBtn.addEventListener("click", () => {
      currentCategory = "all";
      searchTerm = "";
      if (searchInput) searchInput.value = "";
      if (categoryDropdownToggle) {
        categoryDropdownToggle.innerHTML =
          '<i class="bi bi-funnel"></i> <span>Category</span>';
      }
      renderProducts();
    });
  }

  if (saveDraftBtn) {
    saveDraftBtn.addEventListener("click", saveDraft);
  }

  // Product filter buttons
  function updateFilterButtons() {
    const btns = [
      filterAllBtn,
      filterTopBtn,
      filterBestBtn,
      filterDiscountedBtn,
    ];
    btns.forEach((b) => {
      if (b) b.classList.remove("active");
    });
    if (currentFilter === "all" && filterAllBtn)
      filterAllBtn.classList.add("active");
    if (currentFilter === "top" && filterTopBtn)
      filterTopBtn.classList.add("active");
    if (currentFilter === "best" && filterBestBtn)
      filterBestBtn.classList.add("active");
    if (currentFilter === "discounted" && filterDiscountedBtn)
      filterDiscountedBtn.classList.add("active");
  }
  function setFilter(f) {
    currentFilter = f;
    console.log("[FILTER] set to", f);
    renderProducts();
    updateFilterButtons();
  }
  if (filterAllBtn)
    filterAllBtn.addEventListener("click", (e) => {
      e.preventDefault();
      setFilter("all");
    });
  if (filterTopBtn)
    filterTopBtn.addEventListener("click", (e) => {
      e.preventDefault();
      setFilter("top");
    });
  if (filterBestBtn)
    filterBestBtn.addEventListener("click", (e) => {
      e.preventDefault();
      setFilter("best");
    });
  if (filterDiscountedBtn)
    filterDiscountedBtn.addEventListener("click", (e) => {
      e.preventDefault();
      setFilter("discounted");
    });
  updateFilterButtons();

  // Discount controls
  if (discountTypeSelect) {
    // initialize from current select value
    discountType = discountTypeSelect.value === "amount" ? "amount" : "percent";
    discountTypeSelect.addEventListener("change", () => {
      discountType =
        discountTypeSelect.value === "amount" ? "amount" : "percent";
      renderCart();
      try {
        localStorage.setItem("pos_discountType", discountTypeSelect.value);
      } catch (e) {}
    });
  }
  if (discountValueInput) {
    // initialize from current input value
    const v0 = parseFloat(discountValueInput.value || "0");
    discountValue = isNaN(v0) ? 0 : Math.max(0, v0);
    discountValueInput.addEventListener("input", () => {
      const v = parseFloat(discountValueInput.value || "0");
      discountValue = isNaN(v) ? 0 : Math.max(0, v);
      renderCart();
      try {
        localStorage.setItem("pos_discountValue", String(discountValue));
      } catch (e) {}
    });
  }

  // Custom Price: simpan harga custom dari modal
  if (confirmCustomPriceBtn) {
    confirmCustomPriceBtn.addEventListener("click", () => {
      if (currentCustomPriceIndex < 0 || currentCustomPriceIndex >= cart.length)
        return;

      if (!customPriceValueInput) return;

      const raw = customPriceValueInput.value;
      const val = parseFloat(raw || "0");
      if (isNaN(val) || val < 0) {
        alert("Harga tidak valid");
        return;
      }

      const newPrice = Math.round(val);
      const item = cart[currentCustomPriceIndex];
      if (!item) return;

      item.price = newPrice;

      try {
        renderCart();
      } catch (e) {}

      // Tutup modal jika instance tersedia
      try {
        if (!customPriceModal) {
          const el = document.getElementById("customPriceModal");
          if (el && window.bootstrap && typeof bootstrap.Modal !== "undefined") {
            customPriceModal = bootstrap.Modal.getOrCreateInstance(el);
          }
        }
        if (customPriceModal) customPriceModal.hide();
      } catch (e) {}

      currentCustomPriceIndex = -1;
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST" });
      window.location.href = "/login.html";
    });
  }

  if (shiftActionBtn) {
    shiftActionBtn.addEventListener("click", async () => {
      const mode =
        shiftActionBtn.dataset.mode ||
        (currentShift && !currentShift.closedAt ? "close" : "open");
      if (mode === "close") {
        await closeShiftFlow();
      } else {
        await openShiftFlow();
      }
    });
  }

  // POS Settings
  if (posSettingsBtn) {
    posSettingsBtn.addEventListener("click", () => {
      loadPosSettingsToModal();
      posSettingsModal.show();
    });
  }

  // USB Scanner toggle: init from storage and listen for changes
  if (scannerToggle) {
    try {
      const saved = localStorage.getItem("pos_usb_scanner");
      const on = saved === "1";
      setUsbScannerEnabled(on);
    } catch {
      setUsbScannerEnabled(false);
    }
    scannerToggle.addEventListener("change", () => {
      setUsbScannerEnabled(!!scannerToggle.checked);
    });
  } else {
    // Ensure status text is meaningful even if toggle missing
    if (scannerStatus) scannerStatus.textContent = "USB Scanner: Nonaktif";
  }

  // Refresh button on POS page
  const refreshBtn = document.getElementById("refreshPosBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      if (isLoading) return;
      try {
        isLoading = true;
        const original = refreshBtn.innerHTML;
        refreshBtn.disabled = true;
        refreshBtn.innerHTML =
          '<span class="spinner-border spinner-border-sm"></span>';
        await Promise.all([
          loadBanner().catch(() => {}),
          loadCategories()
            .then(() => populateCategoryDropdown())
            .catch(() => {}),
          loadProducts().catch(() => {}),
          loadQrisImage().catch(() => {}),
          loadRecentTransactions().catch(() => {}),
          loadDrafts().catch(() => {}),
        ]);
        // Ensure UI reflects latest data
        try {
          renderProducts();
        } catch {}
        try {
          renderCart();
        } catch {}
        refreshBtn.innerHTML = original;
        refreshBtn.disabled = false;
      } finally {
        isLoading = false;
      }
    });
  }

  // Refresh buttons for Drafts and Recent Transactions
  const refreshDraftsBtn = document.getElementById("refreshDraftsBtn");
  if (refreshDraftsBtn) {
    refreshDraftsBtn.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML =
        '<span class="spinner-border spinner-border-sm"></span> Refresh';
      try {
        await loadDrafts();
      } finally {
        btn.innerHTML = original;
        btn.disabled = false;
      }
    });
  }

  const refreshRecentBtn = document.getElementById("refreshRecentBtn");
  if (refreshRecentBtn) {
    refreshRecentBtn.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML =
        '<span class="spinner-border spinner-border-sm"></span> Refresh';
      try {
        await loadRecentTransactions();
      } finally {
        btn.innerHTML = original;
        btn.disabled = false;
      }
    });
  }

  // Manual Refresh Cart button
  const refreshCartBtn = document.getElementById("refreshCartBtn");
  if (refreshCartBtn) {
    refreshCartBtn.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML =
        '<span class="spinner-border spinner-border-sm"></span> Refresh';
      try {
        await refreshCartFromServer();
      } finally {
        btn.innerHTML = original;
        btn.disabled = false;
      }
    });
  }

  if (savePosSettingsBtn) {
    savePosSettingsBtn.addEventListener("click", savePosSettingsFromModal);
  }

  // Customer Selection
  if (customerSelect) {
    customerSelect.addEventListener("change", (e) => {
      const customerId = e.target.value;
      if (customerId === "default") {
        selectedCustomer = { id: "default", name: "Pelanggan Umum" };
      } else {
        const customer = customers.find((c) => c.id.toString() === customerId);
        if (customer) {
          selectedCustomer = { id: customer.id, name: customer.name };
        }
      }
      updateCustomerInfo();
      try {
        localStorage.setItem("pos_customerId", String(selectedCustomer.id));
      } catch (e) {}
    });
  }

  if (checkoutBtn) {
    checkoutBtn.addEventListener("click", async () => {
      if (cart.length === 0) {
        alert("Keranjang kosong!");
        return;
      }

      // Refresh settings so the latest payment logos are used
      try {
        await loadSettingsPOS();
      } catch (err) {
        console.warn("Failed to refresh settings before checkout:", err);
      }

      const totals = computeTotals();
      modalTotal.textContent = formatCurrency(totals.grandTotal);
      amountReceivedInput.value = "";
      changeAmountSpan.textContent = formatCurrency(0);

      // Ensure payment image/text matches the currently selected method
      try {
        const paymentMethodRadio = document.querySelector(
          'input[name="paymentMethod"]:checked'
        );
        if (paymentMethodRadio) {
          paymentMethodRadio.dispatchEvent(new Event("change"));
        }
      } catch (err) {}

      checkoutModal.show();
    });
  }

  document.querySelectorAll('input[name="paymentMethod"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      const method = e.target.value;
      if (method === "cash") {
        if (cashPaymentSection) cashPaymentSection.style.display = "block";
        if (qrisPaymentSection) qrisPaymentSection.style.display = "none";
      } else {
        if (cashPaymentSection) cashPaymentSection.style.display = "none";
        if (qrisPaymentSection) qrisPaymentSection.style.display = "block";

        // Sesuaikan tampilan sesuai metode non-tunai (QRIS / DANA / OVO)
        try {
          const textEl = qrisPaymentSection
            ? qrisPaymentSection.querySelector("p")
            : null;
          const imgEl = document.getElementById("qrisCheckoutImage");

          if (textEl) {
            if (method === "qris") {
              textEl.textContent = "Please scan the QR code below to complete the payment.";
            } else if (method === "dana") {
              textEl.textContent = "Gunakan DANA untuk menyelesaikan pembayaran, lalu tekan Confirm Payment.";
            } else if (method === "ovo") {
              textEl.textContent = "Gunakan OVO untuk menyelesaikan pembayaran, lalu tekan Confirm Payment.";
            }
          }

          if (imgEl) {
            let src = qrisImageSrc;
            if (
              method === "qris" &&
              qrisConfig &&
              typeof qrisConfig.paymentLogoQrisBase64 === "string" &&
              qrisConfig.paymentLogoQrisBase64.startsWith("data:image")
            ) {
              // Jika admin mengatur logo/QR khusus untuk QRIS, gunakan itu
              src = qrisConfig.paymentLogoQrisBase64;
            } else if (
              method === "dana" &&
              qrisConfig &&
              typeof qrisConfig.paymentLogoDanaBase64 === "string" &&
              qrisConfig.paymentLogoDanaBase64.startsWith("data:image")
            ) {
              src = qrisConfig.paymentLogoDanaBase64;
            } else if (
              method === "ovo" &&
              qrisConfig &&
              typeof qrisConfig.paymentLogoOvoBase64 === "string" &&
              qrisConfig.paymentLogoOvoBase64.startsWith("data:image")
            ) {
              src = qrisConfig.paymentLogoOvoBase64;
            } else {
              // Fallback ke QRIS image dari /api/qris atau placeholder bawaan
              src = qrisImageSrc;
            }
            imgEl.src = src;
          }
        } catch (err) {}
      }

      try {
        localStorage.setItem("pos_paymentMethod", method);
      } catch (err) {}
    });
  });

  if (amountReceivedInput) {
    amountReceivedInput.addEventListener("input", () => {
      const totals = computeTotals();
      const received = parseInt(amountReceivedInput.value) || 0;
      changeAmountSpan.textContent = formatCurrency(
        received - totals.grandTotal
      );
    });
  }

  if (confirmPaymentBtn) {
    confirmPaymentBtn.addEventListener("click", async () => {
      // PERBAIKAN: Prevent duplicate submissions
      if (isLoading) {
        console.warn("Transaction already in progress");
        return;
      }

      try {
        isLoading = true;
        confirmPaymentBtn.disabled = true;
        confirmPaymentBtn.textContent = "Processing...";

        const paymentMethodRadio = document.querySelector(
          'input[name="paymentMethod"]:checked'
        );
        if (!paymentMethodRadio) {
          throw new Error("Please select a payment method");
        }

        const paymentMethod = paymentMethodRadio.value;
        const totals = computeTotals();
        const total = totals.grandTotal;

        // PERBAIKAN: Validasi keranjang tidak kosong
        if (cart.length === 0) {
          throw new Error("Cart is empty");
        }

        // PERBAIKAN: Validasi stok sebelum checkout
        // Diizinkan menyelesaikan pembayaran walau stok habis/kurang. Hanya log peringatan.
        for (const item of cart) {
          const product = products.find((p) => p.id === item.productId);
          if (!product) {
            console.warn("Product not found: " + item.name);
            continue;
          }
          if ((product.stock || 0) < (item.qty || 0)) {
            console.warn(
              "Checkout dengan stok tidak cukup untuk " +
                item.name +
                ". Stok: " +
                product.stock +
                ", Qty: " +
                item.qty
            );
          }
        }

        let amountReceived = total;

        if (paymentMethod === "cash") {
          amountReceived = parseInt(amountReceivedInput.value) || 0;
          
          // Allow partial payments for customer debts
          if (selectedCustomer && selectedCustomer.id !== 1 && amountReceived < total) {
            if (!confirm(`Pembayaran parsial diterima. Sisa hutang sebesar ${formatCurrency(total - amountReceived)} akan dicatat untuk customer ${selectedCustomer.name}. Lanjutkan?`)) {
              throw new Error("Pembayaran dibatalkan");
            }
          } else if (!selectedCustomer || selectedCustomer.id === 1) {
            // For general customers, require full payment
            if (amountReceived < total) {
              throw new Error("Jumlah yang diterima tidak cukup!");
            }
          }
        }

        // Prepare transaction data
        const transactionData = {
          items: cart,
          paymentMethod,
          amountReceived,
          customerId: selectedCustomer.id,
          customerName: selectedCustomer.name,
          discountPercent: discountType === "percent" ? discountValue : 0,
          discountAmount: discountType === "amount" ? discountValue : 0,
        };

        // Only add debt tracking fields for partial payments
        if (paymentMethod === "cash" && amountReceived < total) {
          transactionData.paidAmount = amountReceived;
          transactionData.remainingAmount = Math.max(0, total - amountReceived);
          transactionData.paymentDate = new Date().toISOString().split('T')[0];
        }

        const res = await fetch("/api/transactions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(transactionData),
        });

        const result = await res.json();

        if (!res.ok) {
          throw new Error(result.message || "Transaction failed");
        }

        checkoutModal.hide();

        const successIdEl = document.getElementById("successTransactionId");
        if (successIdEl) {
          successIdEl.textContent = result.id;
        }
        paymentSuccessModal.show();

        if (printReceiptBtn) {
          printReceiptBtn.onclick = () => printReceipt(result);
        }

        // Tempatkan transaksi baru di urutan pertama langsung
        try {
          const merged = [result, ...(recentTransactions || [])];
          const sorted = merged.sort(
            (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
          );
          renderRecentTransactions(sorted);
          try {
            const el = document.getElementById("recentTransactionsList");
            if (el) el.scrollTop = 0;
          } catch {}
        } catch {}

        // Reset cart (local and server)
        cart = [];
        renderCart();
        try {
          localStorage.removeItem("pos_cart");
        } catch (e) {}
        try {
          localStorage.setItem("pos_cart_updatedAt", String(Date.now()));
        } catch (e) {}
        try {
          await clearServerCart();
        } catch (e) {}

        // Reset discount
        discountValue = 0;
        if (discountValueInput) discountValueInput.value = "0";
        try {
          localStorage.setItem("pos_discountValue", "0");
        } catch (e) {}

        // PERBAIKAN: Reload data setelah transaksi sukses
        try {
          await Promise.all([loadProducts(), loadRecentTransactions()]);
        } catch (reloadError) {
          console.warn("Error reloading data after transaction:", reloadError);
          // Don't fail the transaction if reload fails
        }
      } catch (error) {
        console.error("Transaction error:", error);
        alert("Transaksi gagal: " + error.message);
      } finally {
        isLoading = false;
        if (confirmPaymentBtn) {
          confirmPaymentBtn.disabled = false;
          confirmPaymentBtn.textContent = "Confirm Payment";
        }
      }
    });
  }

  const sendToWABtn = document.getElementById("sendToWABtn");
  if (sendToWABtn) {
    sendToWABtn.addEventListener("click", () => {
      const transaction = recentTransactions.find(
        (t) => t.id === transactionToVoidId
      );
      if (transaction) {
        sendReceiptToWA(transaction);
      } else {
        alert("Transaksi tidak ditemukan.");
      }
    });
  }

  if (voidTransactionBtn) {
    voidTransactionBtn.addEventListener("click", async () => {
      if (!transactionToVoidId) return;
      if (
        !confirm(
          "Apakah Anda yakin ingin membatalkan transaksi " +
            transactionToVoidId +
            "? Ini akan menambahkan item kembali ke keranjang Anda."
        )
      ) {
        return;
      }

      try {
        const res = await fetch("/api/transactions/" + transactionToVoidId, {
          method: "DELETE",
        });
        const result = await res.json();

        if (result.success) {
          alert(result.message);
          const voidedTransaction = recentTransactions.find(
            (t) => t.id === transactionToVoidId
          );
          if (voidedTransaction && voidedTransaction.items) {
            cart = voidedTransaction.items;
            renderCart();
          }
          transactionDetailsModal.hide();
          await loadProducts();
          await loadRecentTransactions();
        } else {
          alert("Kesalahan: " + result.message);
        }
      } catch (error) {
        alert("Gagal membatalkan transaksi.");
      }
    });
  }
}

// Expose functions globally for inline handlers in pos.html
try {
  window.loadRecentTransactions = loadRecentTransactions;
} catch {}
try {
  window.showTransactionDetails = showTransactionDetails;
} catch {}
try {
  window.showPosCustomerDebtDetails = showPosCustomerDebtDetails;
} catch {}
try {
  window.loadDrafts = loadDrafts;
} catch {}
window.__POS_JS_LOADED__ = true;
