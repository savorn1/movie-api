import {
  cleanInviteCode,
  coinsToTakeBack,
  missionByKey,
  newInviteCode,
  reactionBucket,
  searchTerm,
  vipReminderDue,
  vipShortened,
} from './rules';

describe('growth rules', () => {
  it('finds missions by key', () => {
    expect(missionByKey('WATCH_3')?.goal).toBe(3);
    expect(missionByKey('NOPE')).toBeNull();
  });

  it('makes invite codes that read back as codes', () => {
    for (let i = 0; i < 50; i++) {
      const c = newInviteCode();
      expect(c).toHaveLength(7);
      expect(cleanInviteCode(c.toLowerCase())).toBe(c);
    }
    expect(cleanInviteCode('ab0')).toBeNull();
    expect(cleanInviteCode('HELLO-1')).toBeNull();
    expect(cleanInviteCode(42)).toBeNull();
  });

  it('puts reactions in 5-second buckets', () => {
    expect(reactionBucket(0)).toBe(0);
    expect(reactionBucket(4.9)).toBe(0);
    expect(reactionBucket(12)).toBe(2);
    expect(reactionBucket(-3)).toBe(0);
  });

  it('cleans search terms', () => {
    expect(searchTerm('  Summer   Love ')).toBe('summer love');
    expect(searchTerm('a')).toBeNull();
    expect(searchTerm('x'.repeat(61))).toBeNull();
    expect(searchTerm(null)).toBeNull();
  });

  it('reminds once per VIP end date, within 3 days', () => {
    const now = new Date('2026-11-04T00:00:00Z');
    const soon = new Date('2026-11-06T00:00:00Z');
    expect(vipReminderDue(soon, null, now)).toBe(true);
    expect(vipReminderDue(soon, new Date(soon), now)).toBe(false);
    expect(vipReminderDue(new Date('2026-11-10T00:00:00Z'), null, now)).toBe(
      false,
    );
    expect(vipReminderDue(new Date('2026-11-03T00:00:00Z'), null, now)).toBe(
      false,
    );
    expect(vipReminderDue(null, null, now)).toBe(false);
  });

  it('takes back at most what is left', () => {
    expect(coinsToTakeBack(150, 400)).toBe(150);
    expect(coinsToTakeBack(150, 40)).toBe(40);
    expect(coinsToTakeBack(150, 0)).toBe(0);
  });

  it('shortens VIP, ending it when the refund reaches past today', () => {
    const now = new Date('2026-11-04T00:00:00Z');
    expect(
      vipShortened(new Date('2027-02-04T00:00:00Z'), now, 1)?.toISOString(),
    ).toBe('2027-01-04T00:00:00.000Z');
    expect(vipShortened(new Date('2026-12-01T00:00:00Z'), now, 1)).toBeNull();
    expect(vipShortened(null, now, 1)).toBeNull();
  });
});
