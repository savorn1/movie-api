/**
 * Cambodian phone numbers as viewers type them ("012 345 678", "+855 12 345 678", "85512345678")
 * → E.164 ("+85512345678"), or null when it isn't one. A Cambodian number is 8 or 9 digits after the
 * country code (without the leading 0), never starting with 0.
 */
export function normalizePhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const compact = input.replace(/[\s\-.()]/g, '');
  if (!/^\+?\d+$/.test(compact)) return null;
  let rest: string;
  if (compact.startsWith('+855')) rest = compact.slice(4);
  else if (compact.startsWith('855') && compact.length >= 11)
    rest = compact.slice(3);
  else if (compact.startsWith('0')) rest = compact.slice(1);
  else if (compact.startsWith('+')) return null;
  else rest = compact;
  if (rest.startsWith('0')) rest = rest.slice(1);
  return /^[1-9]\d{7,8}$/.test(rest) ? `+855${rest}` : null;
}

/** "+85512345678" → "012 345 678" (and "+855961234567" → "096 123 4567"), the way Cambodians write it */
export function displayPhone(e164: string): string {
  const local = `0${e164.replace(/^\+855/, '')}`;
  return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
}
