/**
 * RuengFlix's prices (US dollars), edited in videolingo-web under Streaming › Prices and stored by
 * VideoLingo as the "streaming" settings section (Settings.Streaming, JSON in app_settings). Fields
 * missing or invalid in the stored JSON fall back to the same defaults VideoLingo uses.
 */
export interface Prices {
  seriesUnlock: number;
  /** Months → price of a VIP plan */
  vipPlans: { months: 1 | 3 | 6 | 12; price: number }[];
}

export const DEFAULT_PRICES: Prices = {
  seriesUnlock: 0.49,
  vipPlans: [
    { months: 1, price: 1.99 },
    { months: 3, price: 4.99 },
    { months: 6, price: 8.99 },
    { months: 12, price: 14.99 },
  ],
};

const FIELDS = {
  1: 'vip1Month',
  3: 'vip3Months',
  6: 'vip6Months',
  12: 'vip12Months',
} as const;

const price = (value: unknown, fallback: number) => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1000
    ? Math.round(n * 100) / 100
    : fallback;
};

export function pricesFrom(valueJson: string | null | undefined): Prices {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = valueJson ? JSON.parse(valueJson) : {};
    if (parsed && typeof parsed === 'object') {
      stored = parsed as Record<string, unknown>;
    }
  } catch {
    // A corrupt row must not take the site down: defaults
  }
  return {
    seriesUnlock: price(stored.seriesUnlockPrice, DEFAULT_PRICES.seriesUnlock),
    vipPlans: DEFAULT_PRICES.vipPlans.map((p) => ({
      months: p.months,
      price: price(stored[FIELDS[p.months]], p.price),
    })),
  };
}
