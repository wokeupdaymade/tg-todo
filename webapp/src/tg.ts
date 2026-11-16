// Telegram Mini App bridge (telegram-web-app.js) with safe fallbacks outside Telegram.
type Haptic = {
  impactOccurred(s: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
  notificationOccurred(t: 'error' | 'success' | 'warning'): void;
  selectionChanged(): void;
};
type WebApp = {
  initData: string;
  initDataUnsafe: { start_param?: string };
  version: string;
  colorScheme: 'light' | 'dark';
  ready(): void;
  expand(): void;
  disableVerticalSwipes?(): void;
  isVersionAtLeast(v: string): boolean;
  setHeaderColor?(c: string): void;
  setBackgroundColor?(c: string): void;
  onEvent(e: string, cb: () => void): void;
  HapticFeedback?: Haptic;
  BackButton?: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
};

declare global { interface Window { Telegram?: { WebApp?: WebApp } } }

export const wa: WebApp | null = window.Telegram?.WebApp && window.Telegram.WebApp.initData ? window.Telegram.WebApp : null;

/** initData for API auth. Outside Telegram a signed value may be passed in the hash (#tma=…) for testing. */
export function initData(): string {
  if (wa) return wa.initData;
  const m = /[#&]tma=([^&]+)/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : '';
}

export function startParam(): string | null {
  if (wa) return wa.initDataUnsafe.start_param ?? null;
  const m = /[#&]start=([^&]+)/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

export function boot() {
  if (!wa) return;
  document.documentElement.dataset.tg = '1'; // theme comes from Telegram, not the fallbacks
  wa.ready();
  wa.expand();
  // Swipe-to-close would fight with list scrolling.
  if (wa.isVersionAtLeast('7.7')) wa.disableVerticalSwipes?.();
  try { wa.setHeaderColor?.('secondary_bg_color'); wa.setBackgroundColor?.('secondary_bg_color'); } catch { /* old clients */ }
}

export const haptic = {
  tap() { try { wa?.HapticFeedback?.impactOccurred('light'); } catch { /* */ } },
  select() { try { wa?.HapticFeedback?.selectionChanged(); } catch { /* */ } },
  success() { try { wa?.HapticFeedback?.notificationOccurred('success'); } catch { /* */ } },
  warn() { try { wa?.HapticFeedback?.notificationOccurred('warning'); } catch { /* */ } },
};

export function onForeground(cb: () => void) {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) cb(); });
  wa?.onEvent('activated', cb);
}
