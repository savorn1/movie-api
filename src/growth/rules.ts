import { randomInt } from 'node:crypto';

/*
 * Growth rules as pure functions: daily missions, invite-a-friend, timeline reactions, search terms
 * and VIP reminders. The services apply them to the database.
 */

export interface Mission {
  key: 'WATCH_3' | 'COMMENT_1';
  /** How many to do today */
  goal: number;
  coins: number;
}

/** Today's missions: finish 3 episodes (+10 coins), write a comment (+5) */
export const MISSIONS: readonly Mission[] = [
  { key: 'WATCH_3', goal: 3, coins: 10 },
  { key: 'COMMENT_1', goal: 1, coins: 5 },
];

export const missionByKey = (key: string) =>
  MISSIONS.find((m) => m.key === key) ?? null;

/** Coins each side gets once an invited friend has finished INVITE_WATCHES episodes */
export const INVITE_COINS = 50;
export const INVITE_WATCHES = 3;
/** A code only counts on an account made in the last day (so existing viewers can't be "invited") */
export const INVITE_WINDOW_MS = 24 * 3600_000;

// No 0/O or 1/I/L: codes are read out and typed by hand
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function newInviteCode(length = 7): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** A code as typed or pasted: upper case, only code letters; null when it can't be one */
export function cleanInviteCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  return /^[2-9A-HJ-KM-NP-Z]{5,16}$/.test(c) ? c : null;
}

export const REACTIONS = ['laugh', 'cry', 'fire', 'love'] as const;
export type ReactionKind = (typeof REACTIONS)[number];
export const REACTION_BUCKET_SECONDS = 5;

export const reactionBucket = (second: number) =>
  Math.max(0, Math.floor(second / REACTION_BUCKET_SECONDS));

/** A search term to count: trimmed, lower case, single spaces; null when too short or too long */
export function searchTerm(term: unknown): string | null {
  if (typeof term !== 'string') return null;
  const t = term.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  return t.length >= 2 && t.length <= 60 ? t : null;
}

/** VIP ends within `days` and no reminder was sent for this end date yet */
export function vipReminderDue(
  vipUntil: Date | null,
  remindedFor: Date | null,
  now: Date,
  days = 3,
): boolean {
  if (!vipUntil || vipUntil <= now) return false;
  if (vipUntil.getTime() - now.getTime() > days * 86_400_000) return false;
  return remindedFor?.getTime() !== vipUntil.getTime();
}

/** What a refund takes back from the wallet: what was delivered, but never more than is left */
export const coinsToTakeBack = (delivered: number, balance: number) =>
  Math.max(0, Math.min(delivered, balance));

/** VIP end after refunding `months`: moved back, and ended (null) if that's already past */
export function vipShortened(
  until: Date | null,
  now: Date,
  months: number,
): Date | null {
  if (!until) return null;
  const end = new Date(until);
  end.setUTCMonth(end.getUTCMonth() - months);
  return end > now ? end : null;
}
