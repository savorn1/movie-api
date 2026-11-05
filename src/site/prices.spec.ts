import { DEFAULT_PRICES, pricesFrom } from './prices';

describe('pricesFrom', () => {
  it('uses the defaults when nothing is stored', () => {
    expect(pricesFrom(null)).toEqual(DEFAULT_PRICES);
  });

  it('reads the stored section', () => {
    const p = pricesFrom(
      JSON.stringify({
        seriesUnlockPrice: 0.99,
        vip1Month: 2.5,
        vip3Months: '6',
        vip6Months: 10,
        vip12Months: 18.456,
      }),
    );
    expect(p.seriesUnlock).toBe(0.99);
    expect(p.vipPlans.map((x) => x.price)).toEqual([2.5, 6, 10, 18.46]);
  });

  it('falls back field by field on bad values or bad JSON', () => {
    expect(
      pricesFrom(JSON.stringify({ seriesUnlockPrice: -1, vip1Month: 'x' }))
        .seriesUnlock,
    ).toBe(0.49);
    expect(pricesFrom('{not json')).toEqual(DEFAULT_PRICES);
  });

  it('reads coin settings, ignoring free packs and bad numbers', () => {
    const p = pricesFrom(
      JSON.stringify({
        coinPack100: 1.25,
        coinPack300: 0,
        episodeUnlockCoins: 30,
        dailyCheckInCoins: 2.5,
      }),
    );
    expect(p.coinPacks.map((x) => x.price)).toEqual([1.25, 2.49, 6.99]);
    expect(p.episodeCoins).toBe(30);
    expect(p.checkInCoins).toBe(5);
  });

  it('reads the bonus and preview settings, where 0 turns them off', () => {
    const off = pricesFrom(
      JSON.stringify({ firstTopUpBonusPercent: 0, previewSeconds: '0' }),
    );
    expect(off.firstTopUpBonusPercent).toBe(0);
    expect(off.previewSeconds).toBe(0);
    const bad = pricesFrom(
      JSON.stringify({ firstTopUpBonusPercent: 500, previewSeconds: 2.5 }),
    );
    expect(bad.firstTopUpBonusPercent).toBe(50);
    expect(bad.previewSeconds).toBe(45);
  });
});
