import type { Prices } from '../site/prices';

/*
 * Money and coin rules as pure functions, so they're tested on their own. Days are calendar days in
 * the site's time zone ("YYYY-MM-DD"), so a check-in resets at local midnight.
 */

export type OrderKind = 'COINS' | 'SERIES' | 'VIP';

export interface Quote {
  kind: OrderKind;
  amountUsd: number;
  coins?: number;
  months?: number;
  collectionId?: number;
}

/** What an order costs, from the current prices; null when the product doesn't exist */
export function quote(
  prices: Prices,
  req: { kind: OrderKind; coins?: number; months?: number; seriesId?: number },
): Quote | null {
  if (req.kind === 'COINS') {
    const pack = prices.coinPacks.find((p) => p.coins === req.coins);
    return pack
      ? { kind: 'COINS', amountUsd: pack.price, coins: pack.coins }
      : null;
  }
  if (req.kind === 'VIP') {
    const plan = prices.vipPlans.find((p) => p.months === req.months);
    return plan && plan.price > 0
      ? { kind: 'VIP', amountUsd: plan.price, months: plan.months }
      : null;
  }
  return req.seriesId && prices.seriesUnlock > 0
    ? {
        kind: 'SERIES',
        amountUsd: prices.seriesUnlock,
        collectionId: req.seriesId,
      }
    : null;
}

/** "YYYY-MM-DD" for `at` in `zone` */
export function dayIn(zone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function previousDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Days in a row including today, given the streak recorded on the last check-in day */
export function nextStreak(
  last: { day: string; streak: number } | null,
  today: string,
): number {
  return last && last.day === previousDay(today) ? last.streak + 1 : 1;
}

/** Coins for a check-in: every 7th day in a row pays double */
export const checkInReward = (base: number, streak: number) =>
  streak % 7 === 0 ? base * 2 : base;

/** VIP end after buying `months` more: from now, or from the current end if still running */
export function vipExtended(
  until: Date | null,
  now: Date,
  months: number,
): Date {
  const from = new Date(Math.max(until?.getTime() ?? 0, now.getTime()));
  const end = new Date(from);
  end.setUTCMonth(end.getUTCMonth() + months);
  // 31 Jan + 1 month would roll into March: stop at the month's last day instead
  if (end.getUTCDate() !== from.getUTCDate()) end.setUTCDate(0);
  return end;
}

/** A bill number for the KHQR: short, unique enough, readable on a receipt ("RF-L8K2X9-4F7Q") */
export function billNumber(now = Date.now(), random = Math.random): string {
  const r = Math.floor(random() * 36 ** 4)
    .toString(36)
    .toUpperCase()
    .padStart(4, '0');
  return `RF-${now.toString(36).toUpperCase()}-${r}`;
}
