(() => {
  const key = 'linchuan-theme-mode';
  const light = '#F6F5F0';
  const dark = '#14181E';
  let mode = 'system';
  try {
    const saved = window.localStorage.getItem(key);
    if (saved === 'light' || saved === 'dark' || saved === 'system')
      mode = saved;
  } catch {
    // Storage may be disabled; system mode is the safe default.
  }
  const resolved =
    mode === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : mode;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = resolved === 'dark' ? dark : light;
})();
