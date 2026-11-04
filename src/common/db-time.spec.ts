import { DbTime, offsetMs } from './db-time';

describe('DbTime', () => {
  it('reads Phnom Penh wall-clock time as the right instant', () => {
    const t = new DbTime('Asia/Phnom_Penh');
    // 10:00 local (+07:00) is 03:00 UTC
    expect(
      t.toInstant(new Date('2026-11-03T10:00:00.250Z')).toISOString(),
    ).toBe('2026-11-03T03:00:00.250Z');
    expect(t.toWall(new Date('2026-11-03T03:00:00.250Z')).toISOString()).toBe(
      '2026-11-03T10:00:00.250Z',
    );
  });

  it('follows daylight saving time', () => {
    const t = new DbTime('America/New_York');
    expect(t.toInstant(new Date('2026-07-01T12:00:00Z')).toISOString()).toBe(
      '2026-07-01T16:00:00.000Z',
    );
    expect(t.toInstant(new Date('2026-12-01T12:00:00Z')).toISOString()).toBe(
      '2026-12-01T17:00:00.000Z',
    );
  });

  it('round-trips and keeps null', () => {
    const t = new DbTime('Asia/Phnom_Penh');
    const now = new Date('2026-11-03T15:04:05.678Z');
    expect(t.toInstant(t.toWall(now)).toISOString()).toBe(now.toISOString());
    expect(t.toInstant(null)).toBeNull();
  });

  it('UTC has no offset', () => {
    expect(offsetMs('UTC', new Date())).toBe(0);
  });
});
