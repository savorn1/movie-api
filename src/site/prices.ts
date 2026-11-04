/**
 * RuengFlix's prices (US dollars), edited in videolingo-web under Streaming › Prices and stored by
 * VideoLingo as the "streaming" settings section (Settings.Streaming, JSON in app_settings). Fields
 * missing or invalid in the stored JSON fall back to the same defaults VideoLingo uses.
 */
export interface Prices {
  seriesUnlock: number;
  /** Months → price of a VIP plan */
  vipPlans: { months: 1 | 3 | 6 | 12; price: number }[];
  /** Coin packs viewers can buy with KHQR */
  coinPacks: { coins: 100 | 300 | 1000; price: number }[];
  /** Coins to unlock one VIP episode */
  episodeCoins: number;
  /** Coins for the daily check-in (day 7 of a streak pays double) */
  checkInCoins: number;
}

export const DEFAULT_PRICES: Prices = {
  seriesUnlock: 0.49,
  vipPlans: [
    { months: 1, price: 1.99 },
    { months: 3, price: 4.99 },
    { months: 6, price: 8.99 },
    { months: 12, price: 14.99 },
  ],
  coinPacks: [
    { coins: 100, price: 0.99 },
    { coins: 300, price: 2.49 },
    { coins: 1000, price: 6.99 },
  ],
  episodeCoins: 20,
  checkInCoins: 5,
};

const PACK_FIELDS = {
  100: 'coinPack100',
  300: 'coinPack300',
  1000: 'coinPack1000',
} as const;

const whole = (value: unknown, fallback: number, max: number) => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max
    ? n
    : fallback;
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
    coinPacks: DEFAULT_PRICES.coinPacks.map((p) => ({
      coins: p.coins,
      // A pack must cost something: a stored 0 would hand out free coins
      price:
        price(stored[PACK_FIELDS[p.coins]], p.price) ||
        DEFAULT_PRICES.coinPacks.find((d) => d.coins === p.coins)!.price,
    })),
    episodeCoins: whole(
      stored.episodeUnlockCoins,
      DEFAULT_PRICES.episodeCoins,
      10_000,
    ),
    checkInCoins: whole(
      stored.dailyCheckInCoins,
      DEFAULT_PRICES.checkInCoins,
      1_000,
    ),
  };
}
