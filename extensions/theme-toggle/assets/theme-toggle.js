(() => {
  'use strict';

  // ── Theme Toggle extension for Hermes WebUI (v2: sidebar placement) ─────
  // Injects a sun/moon theme toggle button directly under the Settings cog —
  // in the desktop icon rail and in the mobile sidebar nav. Clicking it flips
  // between light and dark mode using the WebUI's built-in _pickTheme()
  // function, so the choice persists in localStorage and stays in sync with
  // Settings → Appearance. The icon is CSS-driven: sun shows in dark mode
  // (click to go light), moon shows in light mode (click to go dark).

  if (window.__hermesThemeToggleLoaded) return;
  window.__hermesThemeToggleLoaded = true;

  // ── SVG icons (20×20 to match rail button icons) ─────────────────────────
  const SUN_SVG = `<svg class="icon-sun" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="5"/>
    <line x1="12" y1="1" x2="12" y2="3"/>
    <line x1="12" y1="21" x2="12" y2="23"/>
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
    <line x1="1" y1="12" x2="3" y2="12"/>
    <line x1="21" y1="12" x2="23" y2="12"/>
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
  </svg>`;

  const MOON_SVG = `<svg class="icon-moon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>`;

  // ── Current effective theme ──────────────────────────────────────────────
  // The WebUI toggles the .dark class on <html>; this reflects the resolved
  // theme, including when the user picked "system".
  function isDarkMode() {
    return document.documentElement.classList.contains('dark');
  }

  // ── Toggle theme ─────────────────────────────────────────────────────────
  function toggleTheme() {
    // Brief global transition for a smooth color swap.
    document.documentElement.classList.add('theme-toggle-transitioning');
    setTimeout(() => {
      document.documentElement.classList.remove('theme-toggle-transitioning');
    }, 350);

    // Prefer the WebUI's built-in _pickTheme: persists the choice and
    // syncs Settings → Appearance.
    if (typeof window._pickTheme === 'function') {
      window._pickTheme(isDarkMode() ? 'light' : 'dark');
      return;
    }

    // No _pickTheme (core older than the theme system): stay inert rather
    // than duplicating core theme behavior — this entry requires the API.
    console.warn('theme-toggle: _pickTheme unavailable; button is inert');
  }

  // ── Button factory ───────────────────────────────────────────────────────
  function buildButton(id) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.innerHTML = SUN_SVG + MOON_SVG;
    btn.addEventListener('click', toggleTheme);
    return btn;
  }

  function syncMeta(btn) {
    const to = isDarkMode() ? 'light' : 'dark';
    btn.title = 'Switch to ' + to + ' mode';
    btn.setAttribute('aria-label', 'Switch to ' + to + ' theme');
  }

  // ── Injection ────────────────────────────────────────────────────────────
  // Desktop: the icon rail (.rail) is a vertical flex column; the Settings
  // button sits last (below the spacer). Insert the toggle right after it —
  // the bottom of the rail, under the settings cog.
  // Mobile: .sidebar > .sidebar-nav mirrors the same set of buttons; insert
  // after the mobile settings button.
  // The buttons carry no data-panel, so the WebUI's tab order / tab
  // visibility logic (which only touches .nav-tab[data-panel]) leaves them
  // alone.
  function inject() {
    const rail = document.querySelector('.rail');
    const railSettings = rail && rail.querySelector('.rail-btn[data-panel="settings"]');
    if (railSettings && !document.getElementById('hermes-rtt-rail')) {
      const btn = buildButton('hermes-rtt-rail');
      btn.className = 'rail-btn has-tooltip hermes-rtt';
      btn.setAttribute('data-tooltip', 'Theme');
      syncMeta(btn);
      railSettings.insertAdjacentElement('afterend', btn);
    }

    const nav = document.querySelector('.sidebar > .sidebar-nav');
    const navSettings = nav && nav.querySelector('.nav-tab[data-panel="settings"]');
    if (navSettings && !document.getElementById('hermes-rtt-mobile')) {
      const btn = buildButton('hermes-rtt-mobile');
      btn.className = 'nav-tab has-tooltip has-tooltip--bottom hermes-rtt';
      btn.setAttribute('data-tooltip', 'Theme');
      btn.setAttribute('data-label', 'Theme');
      syncMeta(btn);
      navSettings.insertAdjacentElement('afterend', btn);
    }
  }

  // ── Keep tooltips/aria in sync when the theme changes from any source ────
  function observeThemeChanges() {
    let lastDark = isDarkMode();
    const observer = new MutationObserver(() => {
      const nowDark = isDarkMode();
      if (nowDark !== lastDark) {
        lastDark = nowDark;
        document.querySelectorAll('.hermes-rtt').forEach(syncMeta);
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });
  }

  // ── Init (retry briefly if the rail/sidebar aren't in the DOM yet) ──────
  function init(attempt) {
    attempt = attempt || 0;
    inject();
    if (!document.getElementById('hermes-rtt-rail') && attempt < 20) {
      setTimeout(() => init(attempt + 1), 150);
      return;
    }
    observeThemeChanges();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(), { once: true });
  } else {
    init();
  }
})();
