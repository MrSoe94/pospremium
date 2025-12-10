// Sidebar toggle, overlay, and responsive handlers extracted from admin.js

const SIDEBAR_BREAKPOINT = 992;

function isDesktopWidth() {
    return window.innerWidth >= SIDEBAR_BREAKPOINT;
}

function getSavedSidebarHidden() {
    try {
        return localStorage.getItem('sidebarHidden') === '1';
    } catch {
        return false;
    }
}

function saveSidebarHidden(hidden) {
    try {
        localStorage.setItem('sidebarHidden', hidden ? '1' : '0');
    } catch {}
}

function applyDesktopSidebarState(hidden) {
    document.body.classList.remove('sidebar-visible');
    document.body.classList.toggle('sidebar-hidden', !!hidden);
}

function toggleDesktopSidebar() {
    const currentlyHidden = document.body.classList.contains('sidebar-hidden');
    const nextHidden = !currentlyHidden;
    applyDesktopSidebarState(nextHidden);
    saveSidebarHidden(nextHidden);
}

function openMobileSidebar() {
    document.body.classList.remove('sidebar-hidden');
    document.body.classList.add('sidebar-visible');
}

function closeMobileSidebar() {
    document.body.classList.remove('sidebar-visible');
}

document.addEventListener('DOMContentLoaded', () => {
    // Sidebar toggle: bind once and restore previous state
    try {
        const btn = document.getElementById('sidebarToggle');
        if (btn && !btn.dataset.boundSidebar) {
            btn.dataset.boundSidebar = '1';
            btn.addEventListener('click', (ev) => {
                try { ev.preventDefault(); ev.stopPropagation(); } catch {}
                if (isDesktopWidth()) {
                    toggleDesktopSidebar();
                } else {
                    if (document.body.classList.contains('sidebar-visible')) {
                        closeMobileSidebar();
                    } else {
                        openMobileSidebar();
                    }
                }
            });
        }

        if (isDesktopWidth()) {
            applyDesktopSidebarState(getSavedSidebarHidden());
        } else {
            // Mobile initial state: no desktop hidden flag, overlay closed
            document.body.classList.remove('sidebar-hidden');
            closeMobileSidebar();
        }
    } catch {}
});

// Global handlers for mobile sidebar overlay close and responsive reconciliation
document.addEventListener('click', (e) => {
    try {
        if (!document.body.classList.contains('sidebar-visible')) return;
        const sidebar = document.getElementById('sidebar');
        const toggleBtn = document.getElementById('sidebarToggle');
        // If clicking outside sidebar and not the toggle button, close overlay
        if (sidebar && !sidebar.contains(e.target) && (!toggleBtn || !toggleBtn.contains(e.target))) {
            closeMobileSidebar();
        }
    } catch {}
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('sidebar-visible')) {
        closeMobileSidebar();
    }
});

window.addEventListener('resize', () => {
    try {
        if (isDesktopWidth()) {
            // Leaving mobile: close overlay and restore saved desktop state
            applyDesktopSidebarState(getSavedSidebarHidden());
        } else {
            // Entering mobile: clear desktop hidden state and ensure overlay is closed
            document.body.classList.remove('sidebar-hidden');
            closeMobileSidebar();
        }
    } catch {}
});
