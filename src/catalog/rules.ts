/**
 * What RuengFlix may show of a series, as pure functions (ported from VideoLingo's StreamingRules).
 * A series is a PUBLIC collection with streaming on; its episodes are the collection's videos in order,
 * keeping only released ones, numbered 1, 2, 3… (so a video hidden later shifts the numbers after it).
 * Dates here are real instants (see DbTime).
 */
export interface RuleVideo {
  enabled: boolean;
  visibility: string;
  deletedAt: Date | null;
  archivedAt: Date | null;
  publishAt: Date | null;
  updatedAt: Date | null;
}

export interface RuleItem<V extends RuleVideo> {
  position: number;
  video: V;
}

export interface Episode<V extends RuleVideo> {
  number: number;
  video: V;
}

const isPublicLive = (v: RuleVideo) =>
  !v.deletedAt && !v.archivedAt && v.visibility === 'PUBLIC';

/** Released: enabled, PUBLIC, not archived and not in the trash. UNLISTED and PRIVATE never appear. */
export const isReleased = (v: RuleVideo) => v.enabled && isPublicLive(v);

/** Scheduled: not out yet, but VideoLingo will enable it at `publishAt` */
export const isUpcoming = (v: RuleVideo, now: Date) =>
  !v.enabled && isPublicLive(v) && !!v.publishAt && v.publishAt > now;

export function episodes<V extends RuleVideo>(
  items: RuleItem<V>[],
): Episode<V>[] {
  return [...items]
    .sort((a, b) => a.position - b.position)
    .map((i) => i.video)
    .filter(isReleased)
    .map((video, i) => ({ number: i + 1, video }));
}

/** The earliest scheduled episode, for the "next episode at…" countdown */
export function nextEpisodeAt(
  items: RuleItem<RuleVideo>[],
  now: Date,
): Date | null {
  const times = items
    .map((i) => i.video)
    .filter((v) => isUpcoming(v, now))
    .map((v) => v.publishAt!.getTime());
  return times.length ? new Date(Math.min(...times)) : null;
}

/** When the newest episode came out (publishing clears publishAt, so the video's last update stands in) */
export function latestEpisodeAt(eps: Episode<RuleVideo>[]): Date | null {
  const times = eps
    .map((e) => e.video.updatedAt?.getTime())
    .filter((t): t is number => t != null);
  return times.length ? new Date(Math.max(...times)) : null;
}

/** A VIP series' episodes after its free ones need payment: no video or subtitle link for them */
export const isLocked = (
  series: { vip: boolean; freeEpisodes: number },
  episodeNumber: number,
) => series.vip && episodeNumber > series.freeEpisodes;

/** Genres are stored comma-separated */
export const splitGenres = (stored: string | null) =>
  (stored ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
