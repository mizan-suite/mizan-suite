// theme.js - included on every page. Applies the accent theme and dark mode
// from the saved settings. The <head> inline script already applied the cached
// settings (localStorage) before first paint, so the page is correct
// immediately; this syncs the cache with the server value in case it changed
// on another device (e.g. the shop owner switched the theme in Settings).
fetch('/api/settings').then(r => r.json()).then(s => {
  const theme = s.theme || 'blue';
  const dark = s.dark_mode === 'true';
  try {
    localStorage.setItem('mizan_theme', theme);
    localStorage.setItem('mizan_dark', dark ? 'true' : 'false');
  } catch (e) {}
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.classList.toggle('dark-mode', dark);
});
