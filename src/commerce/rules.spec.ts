import { DEFAULT_PRICES } from '../site/prices';
import {
  billNumber,
  checkInReward,
  dayIn,
  nextStreak,
  previousDay,
  quote,
  topUpBonus,
  vipExtended,
} from './rules';

describe('quote', () => {
  it('prices coin packs, VIP plans and series', () => {
    expect(quote(DEFAULT_PRICES, { kind: 'COINS', coins: 300 })).toEqual({
      kind: 'COINS',
      amountUsd: 2.49,
      coins: 300,
    });
    expect(quote(DEFAULT_PRICES, { kind: 'VIP', months: 3 })?.amountUsd).toBe(
      4.99,
    );
    expect(
      quote(DEFAULT_PRICES, { kind: 'SERIES', seriesId: 4 })?.collectionId,
    ).toBe(4);
  });

  it('refuses products that do not exist', () => {
    expect(quote(DEFAULT_PRICES, { kind: 'COINS', coins: 7 })).toBeNull();
    expect(quote(DEFAULT_PRICES, { kind: 'VIP', months: 2 })).toBeNull();
    expect(quote(DEFAULT_PRICES, { kind: 'SERIES' })).toBeNull();
  });
});

describe('days and streaks', () => {
  it('uses the local calendar day', () => {
    // 20:00 UTC is 03:00 the next day in Phnom Penh
    expect(dayIn('Asia/Phnom_Penh', new Date('2026-11-03T20:00:00Z'))).toBe(
      '2026-11-04',
    );
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
  });

  it('continues or restarts the streak', () => {
    expect(nextStreak(null, '2026-11-04')).toBe(1);
    expect(nextStreak({ day: '2026-11-03', streak: 6 }, '2026-11-04')).toBe(7);
    expect(nextStreak({ day: '2026-11-01', streak: 6 }, '2026-11-04')).toBe(1);
  });

  it('pays double every 7th day', () => {
    expect(checkInReward(5, 6)).toBe(5);
    expect(checkInReward(5, 7)).toBe(10);
    expect(checkInReward(5, 14)).toBe(10);
  });
});

describe('vipExtended', () => {
  const now = new Date('2026-11-04T00:00:00Z');
  it('starts from now when VIP has run out', () => {
    expect(vipExtended(null, now, 1).toISOString()).toBe(
      '2026-12-04T00:00:00.000Z',
    );
    expect(
      vipExtended(new Date('2026-01-01T00:00:00Z'), now, 3).toISOString(),
    ).toBe('2027-02-04T00:00:00.000Z');
  });

  it('adds to VIP that is still running', () => {
    expect(
      vipExtended(new Date('2026-11-20T00:00:00Z'), now, 1).toISOString(),
    ).toBe('2026-12-20T00:00:00.000Z');
  });

  it('stops at the end of a shorter month', () => {
    expect(
      vipExtended(null, new Date('2027-01-31T00:00:00Z'), 1).toISOString(),
    ).toBe('2027-02-28T00:00:00.000Z');
  });
});

describe('billNumber', () => {
  it('is short and readable', () => {
    const b = billNumber(1793777371899, () => 0.5);
    expect(b).toMatch(/^RF-[0-9A-Z]+-[0-9A-Z]{4}$/);
    expect(b.length).toBeLessThanOrEqual(25);
  });
});

describe('topUpBonus', () => {
  it('adds a share of the pack, rounded down, or nothing when off', () => {
    expect(topUpBonus(100, 50)).toBe(50);
    expect(topUpBonus(300, 33)).toBe(99);
    expect(topUpBonus(1000, 0)).toBe(0);
  });
});
