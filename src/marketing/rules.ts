import { randomInt } from 'node:crypto';

/*
 * Ads, promotions, gifts, clips, fan levels and "you stopped at…" reminders as pure functions, so
 * they're tested on their own. Times are real instants (see DbTime).
 */

export interface PromotionRow {
  kind: string;
  title: string;
  collectionId: bigint | null;
  bonusPercent: number | null;
  startsAt: Date;
  endsAt: Date;
}

const running = (p: PromotionRow, now: Date) =>
  p.startsAt <= now && p.endsAt > now;

/** The running "series free" promotion for a series, if any (the one ending last) */
export function freePromotion(
  promos: PromotionRow[],
  seriesId: bigint,
  now: Date,
): PromotionRow | null {
  return (
    promos
      .filter(
        (p) =>
          p.kind === 'FREE_SERIES' &&
          p.collectionId === seriesId &&
          running(p, now),
      )
      .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0] ?? null
  );
}

/** The best running "extra coins" promotion, if any (overlapping ones don't add up) */
export function coinPromotion(
  promos: PromotionRow[],
  now: Date,
): PromotionRow | null {
  return (
    promos
      .filter(
        (p) =>
          p.kind === 'COIN_BONUS' &&
          (p.bonusPercent ?? 0) > 0 &&
          running(p, now),
      )
      .sort(
        (a, b) =>
          (b.bonusPercent ?? 0) - (a.bonusPercent ?? 0) ||
          b.endsAt.getTime() - a.endsAt.getTime(),
      )[0] ?? null
  );
}

/** Extra coins from a promotion on a pack: `percent` of it, rounded down */
export const promoCoins = (coins: number, percent: number) =>
  percent > 0 ? Math.floor((coins * percent) / 100) : 0;

/** One ad, chosen at random in proportion to its weight; null when there are none */
export function pickAd<A extends { weight: number }>(
  ads: A[],
  random: (max: number) => number = randomInt,
): A | null {
  const total = ads.reduce((n, a) => n + Math.max(1, a.weight), 0);
  if (!total) return null;
  let roll = random(total);
  for (const a of ads) {
    roll -= Math.max(1, a.weight);
    if (roll < 0) return a;
  }
  return ads[ads.length - 1];
}

/**
 * The viewer watched the ad long enough: at least its length since it started, by the server's clock
 * (a second of slack for the network). Skipping ahead in the browser can't shorten this.
 */
export const watchedLongEnough = (
  startedAt: Date,
  seconds: number,
  now: Date,
) => now.getTime() - startedAt.getTime() >= (seconds - 1) * 1000;

/** How long after starting an ad it can still be completed (a paused tab, a slow phone) */
export const AD_COMPLETE_WITHIN_MS = 10 * 60_000;

/** Letters that can't be mistaken for each other when read aloud or typed (no 0/O, 1/I/L) */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** A random code for gifts and clips ("K7Q2-M9XP" style, without the dash) */
export function randomCode(
  length = 10,
  random: (max: number) => number = randomInt,
): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  }
  return out;
}

/** A code as typed by someone: spaces, dashes and case don't matter */
export const normalizeCode = (code: string) =>
  code.toUpperCase().replace(/[\s-]/g, '');

/** The longest shared clip, and the shortest */
export const CLIP_MAX_SECONDS = 15;
export const CLIP_MIN_SECONDS = 3;

/**
 * The clip actually cut for "share this moment": the `seconds` ending at `at`, pulled forward when
 * that would start before 0, and kept inside the episode. Null when the episode is too short.
 */
export function clipWindow(
  at: number,
  seconds: number,
  duration: number | null,
): { start: number; seconds: number } | null {
  const len = Math.min(
    CLIP_MAX_SECONDS,
    Math.max(CLIP_MIN_SECONDS, Math.round(seconds)),
  );
  const end = duration && duration > 0 ? Math.min(duration, at) : at;
  let start = Math.floor(Math.max(0, end - len));
  if (duration && duration > 0) {
    if (duration < CLIP_MIN_SECONDS) return null;
    start = Math.min(start, Math.max(0, Math.floor(duration - len)));
    return { start, seconds: Math.min(len, Math.floor(duration - start)) };
  }
  return { start, seconds: len };
}

/** Episodes finished for each fan level (level 1 is everyone) */
export const FAN_LEVELS = [0, 10, 50, 150, 400, 1000] as const;

export type FanBadge = 'STREAK_7' | 'STREAK_30' | 'LOVED' | 'TOP_FAN';

/**
 * A viewer's fan level (1–6, from episodes finished) and badges: a 7- or 30-day check-in streak at
 * some point, 20+ likes on their comments, and level 5+.
 */
export function fanStatus(stats: {
  episodes: number;
  likes: number;
  bestStreak: number;
}): { level: number; badges: FanBadge[] } {
  let level = 1;
  FAN_LEVELS.forEach((min, i) => {
    if (stats.episodes >= min) level = i + 1;
  });
  const badges: FanBadge[] = [];
  if (stats.bestStreak >= 30) badges.push('STREAK_30');
  else if (stats.bestStreak >= 7) badges.push('STREAK_7');
  if (stats.likes >= 20) badges.push('LOVED');
  if (level >= 5) badges.push('TOP_FAN');
  return { level, badges };
}

/** "You stopped at…" waits this long after the viewer's last finished episode, and gives up after */
export const RESUME_AFTER_MS = 24 * 3600_000;
export const RESUME_UNTIL_MS = 72 * 3600_000;

/**
 * Whether to remind a viewer about a series: their latest finished episode there was 24–72 hours ago,
 * the next one exists, they haven't finished it, and nobody reminded them about it yet.
 */
export function resumeDue(p: {
  lastFinished: number;
  lastAt: Date;
  released: number;
  finished: Set<number>;
  reminded: boolean;
  now: Date;
}): number | null {
  const next = p.lastFinished + 1;
  const ago = p.now.getTime() - p.lastAt.getTime();
  if (ago < RESUME_AFTER_MS || ago > RESUME_UNTIL_MS) return null;
  if (next > p.released || p.finished.has(next) || p.reminded) return null;
  return next;
}
