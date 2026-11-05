import {
  clipWindow,
  coinPromotion,
  fanStatus,
  freePromotion,
  normalizeCode,
  pickAd,
  promoCoins,
  randomCode,
  resumeDue,
  watchedLongEnough,
  type PromotionRow,
} from './rules';

const now = new Date('2026-11-05T12:00:00Z');
const h = (n: number) => new Date(now.getTime() + n * 3600_000);
const promo = (p: Partial<PromotionRow>): PromotionRow => ({
  kind: 'FREE_SERIES',
  title: 't',
  collectionId: 1n,
  bonusPercent: null,
  startsAt: h(-1),
  endsAt: h(1),
  ...p,
});

describe('promotions', () => {
  it('a series is free only inside its window', () => {
    expect(freePromotion([promo({})], 1n, now)).not.toBeNull();
    expect(freePromotion([promo({})], 2n, now)).toBeNull();
    expect(
      freePromotion([promo({ startsAt: h(1), endsAt: h(2) })], 1n, now),
    ).toBeNull();
    expect(freePromotion([promo({ endsAt: now })], 1n, now)).toBeNull();
  });

  it('overlapping coin promotions: the bigger one counts, not the sum', () => {
    const best = coinPromotion(
      [
        promo({ kind: 'COIN_BONUS', collectionId: null, bonusPercent: 20 }),
        promo({ kind: 'COIN_BONUS', collectionId: null, bonusPercent: 30 }),
        promo({
          kind: 'COIN_BONUS',
          collectionId: null,
          bonusPercent: 90,
          startsAt: h(2),
          endsAt: h(3),
        }),
      ],
      now,
    );
    expect(best?.bonusPercent).toBe(30);
    expect(promoCoins(300, 30)).toBe(90);
    expect(promoCoins(100, 0)).toBe(0);
  });
});

describe('ads', () => {
  it('weighted pick', () => {
    const ads = [
      { id: 'a', weight: 1 },
      { id: 'b', weight: 3 },
    ];
    expect(pickAd(ads, () => 0)?.id).toBe('a');
    expect(pickAd(ads, () => 1)?.id).toBe('b');
    expect(pickAd(ads, () => 3)?.id).toBe('b');
    expect(pickAd([], () => 0)).toBeNull();
  });

  it('must be watched for its length by the server clock (1 s slack)', () => {
    const start = new Date(now.getTime() - 14_000);
    expect(watchedLongEnough(start, 15, now)).toBe(true);
    expect(watchedLongEnough(new Date(now.getTime() - 10_000), 15, now)).toBe(
      false,
    );
  });
});

describe('codes', () => {
  it('no look-alike letters, and typing is forgiving', () => {
    const c = randomCode(10);
    expect(c).toMatch(/^[2-9A-HJ-NP-Z]{10}$/);
    expect(normalizeCode(' k7q2-m9xp ')).toBe('K7Q2M9XP');
  });
});

describe('clip window', () => {
  it('the seconds before the moment, kept inside the episode', () => {
    expect(clipWindow(40, 15, 100)).toEqual({ start: 25, seconds: 15 });
    expect(clipWindow(5, 15, 100)).toEqual({ start: 0, seconds: 15 });
    expect(clipWindow(200, 15, 100)).toEqual({ start: 85, seconds: 15 });
    expect(clipWindow(8, 60, 10)).toEqual({ start: 0, seconds: 10 });
    expect(clipWindow(2, 1, 100)).toEqual({ start: 0, seconds: 3 });
    expect(clipWindow(1, 15, 2)).toBeNull();
  });
});

describe('fan status', () => {
  it('levels from episodes, badges from streaks and likes', () => {
    expect(fanStatus({ episodes: 0, likes: 0, bestStreak: 0 })).toEqual({
      level: 1,
      badges: [],
    });
    expect(fanStatus({ episodes: 10, likes: 0, bestStreak: 7 })).toEqual({
      level: 2,
      badges: ['STREAK_7'],
    });
    expect(fanStatus({ episodes: 400, likes: 25, bestStreak: 31 })).toEqual({
      level: 5,
      badges: ['STREAK_30', 'LOVED', 'TOP_FAN'],
    });
  });
});

describe('resume reminders', () => {
  const base = {
    lastFinished: 4,
    lastAt: h(-30),
    released: 10,
    finished: new Set([1, 2, 3, 4]),
    reminded: false,
    now,
  };
  it('24–72 h after stopping, for the next episode', () => {
    expect(resumeDue(base)).toBe(5);
    expect(resumeDue({ ...base, lastAt: h(-2) })).toBeNull();
    expect(resumeDue({ ...base, lastAt: h(-80) })).toBeNull();
  });
  it('not when finished, already sent, or no next episode', () => {
    expect(resumeDue({ ...base, finished: new Set([5]) })).toBeNull();
    expect(resumeDue({ ...base, reminded: true })).toBeNull();
    expect(resumeDue({ ...base, released: 4 })).toBeNull();
  });
});
