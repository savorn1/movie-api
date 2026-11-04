import {
  episodes,
  isLocked,
  isUpcoming,
  latestEpisodeAt,
  nextEpisodeAt,
  splitGenres,
  type RuleVideo,
} from './rules';

const now = new Date('2026-11-03T10:00:00Z');
const video = (over: Partial<RuleVideo> & { id: number }) => ({
  enabled: true,
  visibility: 'PUBLIC',
  deletedAt: null,
  archivedAt: null,
  publishAt: null,
  updatedAt: null,
  ...over,
});

describe('streaming rules', () => {
  it('numbers released videos in collection order, skipping the rest', () => {
    const items = [
      { position: 3, video: video({ id: 3 }) },
      { position: 1, video: video({ id: 1 }) },
      { position: 2, video: video({ id: 2, visibility: 'PRIVATE' }) },
      { position: 4, video: video({ id: 4, deletedAt: now }) },
      { position: 5, video: video({ id: 5, archivedAt: now }) },
      { position: 6, video: video({ id: 6, enabled: false }) },
      { position: 7, video: video({ id: 7, visibility: 'UNLISTED' }) },
    ];
    expect(episodes(items).map((e) => [e.number, e.video.id])).toEqual([
      [1, 1],
      [2, 3],
    ]);
  });

  it('finds the next scheduled episode, ignoring past and hidden ones', () => {
    const soon = new Date('2026-11-03T12:00:00Z');
    const later = new Date('2026-11-04T12:00:00Z');
    const items = [
      {
        position: 1,
        video: video({ id: 1, enabled: false, publishAt: later }),
      },
      { position: 2, video: video({ id: 2, enabled: false, publishAt: soon }) },
      {
        position: 3,
        video: video({
          id: 3,
          enabled: false,
          publishAt: new Date('2026-11-01T00:00:00Z'),
        }),
      },
      {
        position: 4,
        video: video({
          id: 4,
          enabled: false,
          publishAt: new Date('2026-11-03T11:00:00Z'),
          visibility: 'PRIVATE',
        }),
      },
    ];
    expect(nextEpisodeAt(items, now)).toEqual(soon);
    expect(isUpcoming(items[0].video, now)).toBe(true);
    expect(nextEpisodeAt([], now)).toBeNull();
  });

  it('latest episode is the newest update', () => {
    const a = new Date('2026-11-01T00:00:00Z');
    const b = new Date('2026-11-02T00:00:00Z');
    const eps = episodes([
      { position: 1, video: video({ id: 1, updatedAt: b }) },
      { position: 2, video: video({ id: 2, updatedAt: a }) },
    ]);
    expect(latestEpisodeAt(eps)).toEqual(b);
    expect(latestEpisodeAt([])).toBeNull();
  });

  it('locks VIP episodes after the free ones', () => {
    expect(isLocked({ vip: true, freeEpisodes: 3 }, 3)).toBe(false);
    expect(isLocked({ vip: true, freeEpisodes: 3 }, 4)).toBe(true);
    expect(isLocked({ vip: false, freeEpisodes: 0 }, 50)).toBe(false);
  });

  it('splits stored genres', () => {
    expect(splitGenres(' love , city,, ')).toEqual(['love', 'city']);
    expect(splitGenres(null)).toEqual([]);
  });
});
