import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MediaUrls } from '../media/media-urls';
import { DbTime } from '../common/db-time';
import {
  episodes,
  isLocked,
  isReleased,
  isUpcoming,
  latestEpisodeAt,
  nextEpisodeAt,
  splitGenres,
  type Episode,
  type RuleItem,
  type RuleVideo,
} from './rules';
import { toVtt } from './vtt';
import { pricesFrom } from '../site/prices';
import { freePromotion, type PromotionRow } from '../marketing/rules';

export interface Series {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  posterUrl: string | null;
  bannerUrl: string | null;
  verticalUrl: string | null;
  category: string | null;
  status: string;
  vip: boolean;
  freeEpisodes: number;
  recapSeconds: number;
  searchKeywords: string | null;
  region: string | null;
  releaseYear: number | null;
  genres: string[];
  episodes: number;
  latestEpisodeAt: string | null;
  nextEpisodeAt: string | null;
  /** Place in the hero slider (1 first), set in videolingo-web; null = not a hero pick */
  featuredRank: number | null;
  /** A promotion makes this VIP series free for everyone until then (and its banner title) */
  freeUntil: string | null;
  promoTitle: string | null;
}

export interface EpisodeView {
  number: number;
  videoId: number;
  title: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  /** This viewer can't watch it (a VIP episode they haven't paid for) */
  locked: boolean;
  /** A VIP episode (after the free ones), whether or not this viewer has paid for it */
  premium: boolean;
  /** Null when locked */
  videoUrl: string | null;
  /** Path on movie-api; null when locked or without published subtitles */
  subtitlesUrl: string | null;
  /**
   * The first VIP episode only, while locked: a link to watch its opening before paying, and how many
   * seconds of it. The player stops there; the link itself isn't cut, so a preview is a teaser, not a
   * lock (Settings › previewSeconds = 0 turns them off).
   */
  preview: { url: string; seconds: number } | null;
  /** Khmer voice-over track (made or uploaded in VideoLingo); null when locked or there is none */
  dubUrl: string | null;
}

export interface SeriesDetail {
  series: Series;
  episodes: EpisodeView[];
}

/** The site's language: its subtitle track is preferred when an episode has several */
export const SITE_LANGUAGE = 'km';

/** A series is a PUBLIC collection with streaming turned on in videolingo-web */
const LISTED = { streaming: true, visibility: 'PUBLIC' } as const;

const VIDEO = {
  id: true,
  title: true,
  videoUrl: true,
  thumbnailUrl: true,
  durationSeconds: true,
  enabled: true,
  visibility: true,
  deletedAt: true,
  archivedAt: true,
  publishAt: true,
  updatedAt: true,
} as const;

const WITH_ITEMS = {
  items: { select: { position: true, video: { select: VIDEO } } },
} as const;

interface DbVideo extends RuleVideo {
  id: bigint;
  title: string;
  videoUrl: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
}

interface DbCollection {
  id: bigint;
  slug: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  seriesCategory: string | null;
  seriesStatus: string;
  vip: boolean;
  freeEpisodes: number;
  recapSeconds: number;
  searchKeywords: string | null;
  region: string | null;
  releaseYear: number | null;
  genres: string | null;
  bannerUrl: string | null;
  verticalUrl: string | null;
  featuredRank: number | null;
  items: RuleItem<DbVideo>[];
}

/**
 * The read-only catalog RuengFlix shows: series, their released episodes, and signed links for the
 * unlocked ones. A VIP series' paid episodes get no video or subtitle link at all.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaUrls,
    @Inject(DbTime) private readonly time: DbTime,
  ) {}

  /** Every series with at least one released episode, newest episode first */
  async list(): Promise<Series[]> {
    const collections = await this.prisma.collection.findMany({
      where: LISTED,
      include: WITH_ITEMS,
    });
    const now = new Date();
    const promos = await this.promotions();
    const all = await Promise.all(
      collections.map((c) => this.summarize(this.withInstants(c), now, promos)),
    );
    return all
      .filter((s) => s.episodes > 0)
      .sort((a, b) =>
        (b.latestEpisodeAt ?? '').localeCompare(a.latestEpisodeAt ?? ''),
      );
  }

  /**
   * One series and its episodes; 404 unless it is listed and has a released episode. With `viewerId`,
   * VIP episodes that viewer has paid for (VIP time, the series, or the episode) come with links.
   */
  async get(id: number, viewerId?: number): Promise<SeriesDetail> {
    const c = await this.listed(id);
    const series = await this.summarize(c, new Date(), await this.promotions());
    if (series.episodes === 0) throw notFound();
    const access = await this.access(viewerId, c.id);
    const eps = episodes(c.items);
    const open = eps.filter((e) => !closed(c, e.number, access));
    const [tracks, previewSeconds, dubs] = await Promise.all([
      this.tracksFor(open.map((e) => e.video.id)),
      this.previewSeconds(),
      this.dubsFor(open.map((e) => e.video.id)),
    ]);
    return {
      series,
      episodes: await Promise.all(
        eps.map((e) =>
          this.toView(
            c,
            e,
            tracks.has(e.video.id),
            access,
            previewSeconds,
            dubs.get(e.video.id) ?? null,
          ),
        ),
      ),
    };
  }

  /** What a viewer has paid for in one series; null for nobody */
  async access(
    viewerId: number | undefined,
    seriesId: bigint,
  ): Promise<Access | null> {
    // A "series free" promotion opens it for everyone, signed in or not
    const free = !!freePromotion(await this.promotions(), seriesId, new Date());
    if (!viewerId) {
      return free
        ? { vip: false, series: false, free, episodes: new Set() }
        : null;
    }
    const [wallet, rows] = await Promise.all([
      this.prisma.wallet.findUnique({
        where: { viewerId: BigInt(viewerId) },
        select: { vipUntil: true },
      }),
      this.prisma.entitlement.findMany({
        where: { viewerId: BigInt(viewerId), collectionId: seriesId },
        select: { episode: true },
      }),
    ]);
    const vipUntil = this.time.toInstant(wallet?.vipUntil ?? null);
    return {
      vip: !!vipUntil && vipUntil > new Date(),
      series: rows.some((r) => r.episode === 0),
      free,
      episodes: new Set(rows.map((r) => r.episode).filter((n) => n > 0)),
    };
  }

  private promoCache: { at: number; rows: PromotionRow[] } | null = null;

  /**
   * Promotions that haven't ended (kept for 15 s: every catalog and episode request needs them).
   * Database wall-clock times come back as real instants.
   */
  async promotions(): Promise<PromotionRow[]> {
    if (this.promoCache && Date.now() - this.promoCache.at < 15_000) {
      return this.promoCache.rows;
    }
    const rows = await this.prisma.promotion.findMany({
      where: { endsAt: { gt: this.time.toWall(new Date()) } },
    });
    const out = rows.map((r) => ({
      kind: r.kind,
      title: r.title,
      collectionId: r.collectionId,
      bonusPercent: r.bonusPercent,
      startsAt: this.time.toInstant(r.startsAt),
      endsAt: this.time.toInstant(r.endsAt),
    }));
    this.promoCache = { at: Date.now(), rows: out };
    return out;
  }

  /** Drops the promotion cache (tests, and right after an admin change through movie-api) */
  forgetPromotions() {
    this.promoCache = null;
  }

  /**
   * Episodes scheduled to come out in the next `days` days, soonest first, for the release schedule.
   * An episode's number is where it will land once the scheduled ones before it are out.
   */
  async schedule(days: number) {
    const collections = await this.prisma.collection.findMany({
      where: LISTED,
      include: WITH_ITEMS,
    });
    const now = new Date();
    const until = now.getTime() + days * 86_400_000;
    const out: {
      seriesId: number;
      title: string;
      posterUrl: string | null;
      verticalUrl: string | null;
      episode: number;
      publishAt: string;
    }[] = [];
    for (const raw of collections) {
      const c = this.withInstants(raw);
      const items = [...c.items].sort((a, b) => a.position - b.position);
      let number = 0;
      for (const item of items) {
        const v = item.video;
        if (isReleased(v)) number++;
        else if (isUpcoming(v, now)) {
          number++;
          if (v.publishAt!.getTime() <= until) {
            out.push({
              seriesId: Number(c.id),
              title: c.title,
              posterUrl: await this.media.forBrowser(c.coverUrl),
              verticalUrl: await this.media.forBrowser(c.verticalUrl),
              episode: number,
              publishAt: v.publishAt!.toISOString(),
            });
          }
        }
      }
    }
    return out.sort((a, b) => a.publishAt.localeCompare(b.publishAt));
  }

  /** How many released episodes a listed series has; 404 unless it has one */
  async episodeCount(id: number): Promise<number> {
    const count = episodes((await this.listed(id)).items).length;
    if (count === 0) throw notFound();
    return count;
  }

  /** WebVTT for a released episode this viewer may watch; 404 for anything else, so paid episodes stay closed */
  async subtitlesVtt(videoId: number, viewerId?: number): Promise<string> {
    const id = BigInt(videoId);
    const series = await this.prisma.collection.findMany({
      where: { ...LISTED, items: { some: { videoId: id } } },
      include: WITH_ITEMS,
    });
    let open = false;
    for (const c of series.map((s) => this.withInstants(s))) {
      const access = await this.access(viewerId, c.id);
      open ||= episodes(c.items).some(
        (e) =>
          e.video.id === id &&
          isReleased(e.video) &&
          !closed(c, e.number, access),
      );
    }
    if (!open) throw notFound();
    const trackId = (await this.tracksFor([id])).get(id);
    if (trackId == null) throw notFound();
    const cues = await this.prisma.subtitleCue.findMany({
      where: { subtitleId: trackId },
      orderBy: { position: 'asc' },
      select: { startMs: true, endMs: true, text: true },
    });
    return toVtt(
      cues.map((c) => ({
        startMs: Number(c.startMs),
        endMs: Number(c.endMs),
        text: c.text,
      })),
    );
  }

  // ---------- helpers ----------

  private async listed(id: number): Promise<DbCollection> {
    const c = await this.prisma.collection.findFirst({
      where: { id: BigInt(id), ...LISTED },
      include: WITH_ITEMS,
    });
    if (!c) throw notFound();
    return this.withInstants(c);
  }

  /** Database wall-clock times → real instants, so the rules compare them with `now` correctly */
  private withInstants<C extends DbCollection>(c: C): C {
    return {
      ...c,
      items: c.items.map((i) => ({
        ...i,
        video: {
          ...i.video,
          deletedAt: this.time.toInstant(i.video.deletedAt),
          archivedAt: this.time.toInstant(i.video.archivedAt),
          publishAt: this.time.toInstant(i.video.publishAt),
          updatedAt: this.time.toInstant(i.video.updatedAt),
        },
      })),
    };
  }

  private async summarize(
    c: DbCollection,
    now: Date,
    promos: PromotionRow[],
  ): Promise<Series> {
    const eps = episodes(c.items);
    const promo = c.vip ? freePromotion(promos, c.id, now) : null;
    const [posterUrl, bannerUrl, verticalUrl] = await Promise.all([
      this.media.forBrowser(c.coverUrl),
      this.media.forBrowser(c.bannerUrl),
      this.media.forBrowser(c.verticalUrl),
    ]);
    return {
      id: Number(c.id),
      slug: c.slug,
      title: c.title,
      description: c.description,
      posterUrl,
      bannerUrl,
      verticalUrl,
      category: c.seriesCategory,
      status: c.seriesStatus,
      vip: c.vip,
      freeEpisodes: c.freeEpisodes,
      recapSeconds: c.recapSeconds,
      searchKeywords: c.searchKeywords,
      region: c.region,
      releaseYear: c.releaseYear,
      genres: splitGenres(c.genres),
      episodes: eps.length,
      latestEpisodeAt: latestEpisodeAt(eps)?.toISOString() ?? null,
      nextEpisodeAt: nextEpisodeAt(c.items, now)?.toISOString() ?? null,
      featuredRank: c.featuredRank,
      freeUntil: promo?.endsAt.toISOString() ?? null,
      promoTitle: promo?.title ?? null,
    };
  }

  private async toView(
    c: DbCollection,
    e: Episode<DbVideo>,
    hasSubtitles: boolean,
    access: Access | null,
    previewSeconds: number,
    dubUrl: string | null,
  ): Promise<EpisodeView> {
    const v = e.video;
    const locked = closed(c, e.number, access);
    const teaser =
      locked && previewSeconds > 0 && e.number === c.freeEpisodes + 1;
    return {
      number: e.number,
      videoId: Number(v.id),
      title: v.title,
      durationSeconds: v.durationSeconds,
      thumbnailUrl: await this.media.forBrowser(v.thumbnailUrl),
      locked,
      premium: isLocked(c, e.number),
      videoUrl: locked ? null : await this.media.forBrowser(v.videoUrl),
      subtitlesUrl:
        !locked && hasSubtitles ? `/episodes/${v.id}/subtitles.vtt` : null,
      preview: teaser
        ? {
            url: (await this.media.forBrowser(v.videoUrl))!,
            seconds: previewSeconds,
          }
        : null,
      dubUrl: locked || !dubUrl ? null : await this.media.forBrowser(dubUrl),
    };
  }

  /** Each video's Khmer voice-over track, when it has one */
  private async dubsFor(videoIds: bigint[]): Promise<Map<bigint, string>> {
    if (!videoIds.length) return new Map();
    const rows = await this.prisma.videoDub.findMany({
      where: { videoId: { in: videoIds }, language: SITE_LANGUAGE },
      select: { videoId: true, audioUrl: true },
    });
    return new Map(rows.map((r) => [r.videoId, r.audioUrl]));
  }

  /** Settings › previewSeconds (see EpisodeView.preview) */
  private async previewSeconds(): Promise<number> {
    const row = await this.prisma.appSetting.findUnique({
      where: { section: 'streaming' },
      select: { valueJson: true },
    });
    return pricesFrom(row?.valueJson).previewSeconds;
  }

  /**
   * The subtitle track each video shows: its published track in the site's language (the default one
   * first), else its default published track. Videos without one are left out.
   */
  private async tracksFor(videoIds: bigint[]): Promise<Map<bigint, bigint>> {
    if (!videoIds.length) return new Map();
    const published = await this.prisma.subtitle.findMany({
      where: { videoId: { in: videoIds }, published: true },
      select: { id: true, videoId: true, language: true, isDefault: true },
      orderBy: { id: 'asc' },
    });
    const out = new Map<bigint, bigint>();
    for (const videoId of videoIds) {
      const mine = published.filter((t) => t.videoId === videoId);
      const site = mine.filter(
        (t) => t.language.toLowerCase() === SITE_LANGUAGE,
      );
      const pick =
        site.find((t) => t.isDefault) ??
        site[0] ??
        mine.find((t) => t.isDefault);
      if (pick) out.set(videoId, pick.id);
    }
    return out;
  }
}

/** What a viewer has paid for in a series (see CatalogService.access) */
export interface Access {
  /** VIP time is running: every series is open */
  vip: boolean;
  /** Bought the whole series */
  series: boolean;
  /** A promotion makes the series free for everyone right now */
  free: boolean;
  /** Episodes unlocked one by one with coins */
  episodes: Set<number>;
}

/** A VIP episode this viewer hasn't paid for */
export const closed = (
  c: { vip: boolean; freeEpisodes: number },
  n: number,
  access: Access | null,
) =>
  isLocked(c, n) &&
  !(
    access &&
    (access.vip || access.series || access.free || access.episodes.has(n))
  );

const notFound = () => new NotFoundException('Series or episode not found');
