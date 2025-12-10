// Back to Top functionality with smooth easing
document.addEventListener('DOMContentLoaded', function() {
    const backToTopBtn = document.getElementById('backToTopBtn');
    if (!backToTopBtn) return;

    // support both window scrolling and a dedicated scroll container (e.g., #mainContent)
    const mainContent = document.getElementById('mainContent');
    const contentArea = document.getElementById('content-area');
    const scroller = document.scrollingElement || document.documentElement;
    const containers = [];
    // window/document
    containers.push({
        type: 'window',
        get scrollTop() { return scroller.scrollTop || window.pageYOffset || document.documentElement.scrollTop || 0; },
        scrollTo: (y) => { try { scroller.scrollTo ? scroller.scrollTo({ top: y, behavior: 'smooth' }) : window.scrollTo(0, y); } catch { window.scrollTo(0, y); } }
    });
    // optional main content container
    if (mainContent) {
        containers.push({
            type: 'element',
            el: mainContent,
            get scrollTop() { return mainContent.scrollTop || 0; },
            scrollTo: (y) => { try { mainContent.scrollTo ? mainContent.scrollTo({ top: y, behavior: 'smooth' }) : (mainContent.scrollTop = y); } catch { mainContent.scrollTop = y; } }
        });
    }
    // fallback: content-area if it is scrollable
    if (contentArea) {
        containers.push({
            type: 'element', el: contentArea,
            get scrollTop() { return contentArea.scrollTop || 0; },
            scrollTo: (y) => { try { contentArea.scrollTo ? contentArea.scrollTo({ top: y, behavior: 'smooth' }) : (contentArea.scrollTop = y); } catch { contentArea.scrollTop = y; } }
        });
    }

    function anyScrollTop() {
        return containers.some(c => (c.scrollTop || 0) > 300);
    }

    function toggleBackToTopButton() {
        if (anyScrollTop()) backToTopBtn.classList.add('show');
        else backToTopBtn.classList.remove('show');
    }

    // Smooth scroll to top with easing, applied to all containers
    function scrollToTop() {
        const starts = containers.map(c => c.scrollTop || 0);
        const maxDistance = Math.max(...starts);
        const duration = Math.max(300, Math.min(1000, Math.abs(maxDistance) * 2));
        let startTime = null;

        function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

        function animation(currentTime) {
            if (startTime === null) startTime = currentTime;
            const timeElapsed = currentTime - startTime;
            const progress = Math.min(timeElapsed / duration, 1);
            const easeProgress = easeOutCubic(progress);

            containers.forEach((c, idx) => {
                const start = starts[idx] || 0;
                const y = Math.max(0, Math.round(start * (1 - easeProgress)));
                c.scrollTo(y);
            });

            if (progress < 1) requestAnimationFrame(animation);
        }

        requestAnimationFrame(animation);
    }

    // Event listeners for scroll on all containers
    window.addEventListener('scroll', toggleBackToTopButton, { passive: true });
    document.addEventListener('scroll', toggleBackToTopButton, { passive: true });
    if (mainContent) mainContent.addEventListener('scroll', toggleBackToTopButton, { passive: true });
    if (contentArea) contentArea.addEventListener('scroll', toggleBackToTopButton, { passive: true });
    backToTopBtn.addEventListener('click', function(e) { e.preventDefault(); scrollToTop(); });
    toggleBackToTopButton();
});
