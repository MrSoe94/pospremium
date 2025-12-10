document.addEventListener('DOMContentLoaded', async () => {
    try {
        // Use public settings that don't require authentication
        const res = await fetch('/api/public-settings', { cache: 'no-store' });
        if (res.ok) {
            const settings = await res.json();
            const titleEl = document.getElementById('loginTitle');
            const titleTextEl = document.getElementById('loginTitleText');
            const logoEl = document.getElementById('loginLogo');
            const bodyEl = document.getElementById('loginBody');
            const btn = document.getElementById('loginButton');
            const name = settings?.storeName || 'POS System';
            const loginTitle = settings?.loginTitle || 'POS Login';
            try { if (titleEl) titleEl.textContent = `${loginTitle} - ${name}`; } catch {}
            if (titleTextEl) titleTextEl.textContent = loginTitle;
            if (logoEl) {
                if (settings?.loginLogoBase64) {
                    logoEl.src = settings.loginLogoBase64;
                    logoEl.style.display = 'inline-block';
                } else if (settings?.logoBase64 || settings?.storeLogoBase64) {
                    // fallback to store logo if provided by public endpoint format
                    logoEl.src = settings.logoBase64 || settings.storeLogoBase64;
                    logoEl.style.display = 'inline-block';
                }
            }
            if (bodyEl && settings?.loginBackgroundBase64) {
                bodyEl.style.backgroundImage = `url('${settings.loginBackgroundBase64}')`;
                bodyEl.style.backgroundSize = 'cover';
                bodyEl.style.backgroundPosition = 'center';
            }
            const theme = settings?.themeColor || '#198754';
            let styleEl = document.getElementById('themeStyleLogin');
            const css = ` .btn-primary { background-color: ${theme} !important; border-color: ${theme} !important; } `;
            if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'themeStyleLogin'; document.head.appendChild(styleEl); }
            styleEl.textContent = css;

            // Apply dark mode on login if enabled
            try { if (settings?.darkMode) document.body.classList.add('dark'); else document.body.classList.remove('dark'); } catch {}

            // Apply login logo size
            if (logoEl) {
                const size = (settings?.loginLogoSize || 'medium').toLowerCase();
                const map = { small: 48, medium: 64, large: 96 };
                const h = map[size] || 64;
                logoEl.style.maxHeight = h + 'px';
                logoEl.style.width = 'auto';
            }

            // Apply favicon on login page (avoid cached icon when empty)
            const link = document.querySelector('link[rel="icon"]') || (() => {
                const l = document.createElement('link');
                l.setAttribute('rel', 'icon');
                document.head.appendChild(l);
                return l;
            })();
            const v = Date.now();
            if (settings?.faviconBase64) {
                // Use base64 favicon from settings
                link.setAttribute('href', settings.faviconBase64);
            } else {
                // Use default favicon with cache busting
                link.setAttribute('href', `/favicon.ico?v=${v}`);
            }
        }
    } catch {}
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = (document.getElementById('username').value || '').trim();
    const password = document.getElementById('password').value || '';
    const alertContainer = document.getElementById('alertContainer');
    const btn = document.getElementById('loginButton');

    // Client-side validation mirrors backend
    const userOk = /^[A-Za-z0-9._-]{3,32}$/.test(username);
    const tooShort = password.length < 6 || password.length > 128;
    const forbidden = /["'`<>\\{}\[\]$]/.test(password) || /[\x00-\x1F\x7F]/.test(password);
    if (!userOk) {
        alertContainer.innerHTML = '<div class="alert alert-danger">Format username tidak valid. Gunakan huruf/angka/._- (3-32 karakter).</div>';
        return;
    }
    if (tooShort || forbidden) {
        alertContainer.innerHTML = '<div class="alert alert-danger">Format password tidak diijinkan. Gunakan 6-128 karakter tanpa simbol berbahaya.</div>';
        return;
    }

    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Masuk...'; }

    const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });

    const result = await response.json();

    if (result.success) {
        window.location.href = result.role === 'admin' ? '/admin.html' : '/pos.html';
    } else {
        alertContainer.innerHTML = `<div class="alert alert-danger">${result.message}</div>`;
        if (result && result.licenseLocked) {
            if (btn) { btn.disabled = true; btn.textContent = 'Login (terkunci)'; }
            // License sudah habis: reload halaman agar section LICENSE KEY muncul otomatis
            setTimeout(function () {
                try { window.location.reload(); } catch (e) {}
            }, 600);
        } else {
            if (btn) { btn.disabled = false; btn.textContent = 'Login'; }
        }
    }
});