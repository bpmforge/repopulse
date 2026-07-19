import { useUiStore } from '../store/uiStore.js';

// Dark/light toggle (UX §3.1 rail bottom, FR-WEB-1). The theme lives in the UI
// store (persisted); __root applies it to <html data-theme>, which flips every
// token + the ECharts theme bridge together.
export function ThemeToggle({ className = '' }: { className?: string }) {
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={`inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm text-fg-muted hover:text-fg ${className}`}
      data-testid="theme-toggle"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☾' : '☀'}</span>
    </button>
  );
}
