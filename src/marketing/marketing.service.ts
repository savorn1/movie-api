import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DbTime } from '../common/db-time';
import { APP_CONFIG, type AppConfig } from '../config';
import { CatalogService } from '../catalog/catalog.service';
import { MediaUrls } from '../media/media-urls';
import { pricesFrom } from '../site/prices';
import { dayIn } from '../commerce/rules';
import {
  AD_COMPLETE_WITHIN_MS,
  RESUME_UNTIL_MS,
  clipWindow,
  coinPromotion,
  freePromotion,
  pickAd,
  randomCode,
  resumeDue,
  watchedLongEnough,
} from './rules';

/**
 * Rewarded ads (watch a sponsor video, unlock one VIP episode), shareable clips, "you stopped at…"
 * reminders and the promotions banner. Errors carry a `code` for RuengFlix's Khmer messages:
 * ADS_OFF, AD_LIMIT, NOT_VIP_EPISODE, AD_TOO_SOON, AD_EXPIRED, LOCKED, CLIP_TOO_SHORT.
 */
@Injectable()
export class MarketingService {
  private readonly log = new Logger('marketing');

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly media: MediaUrls,
    @Inject(DbTime) private readonly time: DbTime,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------- promotions ----------

  /** Running promotions for the site's banner, ending soonest first */
  async activePromotions() {
    const now = new Date();
    const promos = await this.catalog.promotions();
    const running = promos.filter((p) => p.startsAt <= now && p.endsAt > now);
    const ids = running
      .map((p) => p.collectionId)
      .filter((x): x is bigint => x != null);
    const titles = new Map(
      (
        await this.prisma.collection.findMany({
          where: { id: { in: ids } },
          select: { id: true, title: true },
        })
      ).map((c) => [c.id, c.title]),
    );
    const coins = coinPromotion(promos, now);
    return running
      .filter(
        (p) =>
          (p.kind === 'FREE_SERIES' &&
            p.collectionId != null &&
            freePromotion(promos, p.collectionId, now) === p) ||
          p === coins,
      )
      .sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime())
      .map((p) => ({
        kind: p.kind as 'FREE_SERIES' | 'COIN_BONUS',
        title: p.title,
        seriesId: p.collectionId == null ? null : Number(p.collectionId),
        seriesTitle:
          p.collectionId == null ? null : (titles.get(p.collectionId) ?? null),
        bonusPercent: p.bonusPercent,
        endsAt: p.endsAt.toISOString(),
      }));
  }

  // ---------- rewarded ads ----------

  /** Start an ad for a locked VIP episode: which ad to play and for how long */
  async startAd(viewerId: number, seriesId: number, episode: number) {
    const perDay = await this.adUnlocksPerDay();
    const ads = await this.prisma.ad.findMany({ where: { active: true } });
    if (!perDay || !ads.length) {
      throw new HttpException(
        { code: 'ADS_OFF', message: 'No ads right now' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const detail = await this.catalog.get(seriesId, viewerId);
    const ep = detail.episodes.find((e) => e.number === episode);
    if (!ep) throw new NotFoundException('Series or episode not found');
    if (!ep.premium || !ep.locked) {
      throw new BadRequestException({
        code: 'NOT_VIP_EPISODE',
        message: 'That episode is already open',
      });
    }
    const day = this.dayDate();
    const [done, started] = await Promise.all([
      this.prisma.adView.count({
        where: { viewerId: BigInt(viewerId), day, completedAt: { not: null } },
      }),
      this.prisma.adView.count({ where: { viewerId: BigInt(viewerId), day } }),
    ]);
    // Abandoned ads don't count, but endless restarts are capped too
    if (done >= perDay || started >= perDay * 5) {
      throw new HttpException(
        { code: 'AD_LIMIT', message: 'No more ad unlocks today' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const ad = pickAd(ads)!;
    const now = new Date();
    const view = await this.prisma.adView.create({
      data: {
        adId: ad.id,
        viewerId: BigInt(viewerId),
        collectionId: BigInt(seriesId),
        episode,
        day,
        startedAt: this.time.toWall(now),
      },
    });
    return {
      viewId: Number(view.id),
      ad: {
        title: ad.title,
        videoUrl: await this.media.forBrowser(ad.videoUrl),
        clickUrl: ad.clickUrl,
        seconds: ad.seconds,
      },
      left: perDay - done,
    };
  }

  /**
   * The viewer watched the ad: unlock the episode, once, if they really watched long enough (server
   * clock) and still have an ad unlock left today. A per-viewer lock makes concurrent completions take
   * turns, so the daily limit can't be beaten with parallel requests.
   */
  async completeAd(viewerId: number, viewId: number) {
    const now = new Date();
    const perDay = await this.adUnlocksPerDay();
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`select pg_advisory_xact_lock(${BigInt(viewerId)})`;
      const view = await tx.adView.findFirst({
        where: { id: BigInt(viewId), viewerId: BigInt(viewerId) },
      });
      if (!view) throw new NotFoundException('Ad not found');
      if (view.completedAt) {
        return { seriesId: Number(view.collectionId), episode: view.episode };
      }
      const ad = view.adId
        ? await tx.ad.findUnique({ where: { id: view.adId } })
        : null;
      const startedAt = this.time.toInstant(view.startedAt);
      if (!watchedLongEnough(startedAt, ad?.seconds ?? 15, now)) {
        throw new BadRequestException({
          code: 'AD_TOO_SOON',
          message: 'Watch the whole ad first',
        });
      }
      if (now.getTime() - startedAt.getTime() > AD_COMPLETE_WITHIN_MS) {
        throw new BadRequestException({
          code: 'AD_EXPIRED',
          message: 'That ad timed out: start again',
        });
      }
      const done = await tx.adView.count({
        where: {
          viewerId: BigInt(viewerId),
          day: view.day,
          completedAt: { not: null },
        },
      });
      if (done >= perDay) {
        throw new HttpException(
          { code: 'AD_LIMIT', message: 'No more ad unlocks today' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      await tx.adView.update({
        where: { id: view.id },
        data: { completedAt: this.time.toWall(now) },
      });
      await tx.entitlement.upsert({
        where: {
          viewerId_collectionId_episode: {
            viewerId: BigInt(viewerId),
            collectionId: view.collectionId,
            episode: view.episode,
          },
        },
        create: {
          viewerId: BigInt(viewerId),
          collectionId: view.collectionId,
          episode: view.episode,
          source: 'AD',
          createdAt: this.time.toWall(now),
        },
        update: {},
      });
      return { seriesId: Number(view.collectionId), episode: view.episode };
    });
    const left = Math.max(
      0,
      perDay -
        (await this.prisma.adView.count({
          where: {
            viewerId: BigInt(viewerId),
            day: this.dayDate(),
            completedAt: { not: null },
          },
        })),
    );
    return { ...result, left };
  }

  private async adUnlocksPerDay() {
    const row = await this.prisma.appSetting.findUnique({
      where: { section: 'streaming' },
      select: { valueJson: true },
    });
    return pricesFrom(row?.valueJson).adUnlocksPerDay;
  }

  // ---------- clips ----------

  /**
   * Queue a clip of the `seconds` before `at` (VideoLingo cuts it), or reuse the one already made of
   * that moment. Anyone may clip an episode they can watch, so a paid episode needs its viewer.
   */
  async createClip(
    viewerId: number | undefined,
    seriesId: number,
    episode: number,
    at: number,
    seconds: number,
  ) {
    const detail = await this.catalog.get(seriesId, viewerId);
    const ep = detail.episodes.find((e) => e.number === episode);
    if (!ep) throw new NotFoundException('Series or episode not found');
    if (ep.locked) {
      throw new ForbiddenException({
        code: 'LOCKED',
        message: 'Unlock the episode to clip it',
      });
    }
    const w = clipWindow(at, seconds, ep.durationSeconds);
    if (!w) {
      throw new BadRequestException({
        code: 'CLIP_TOO_SHORT',
        message: 'This episode is too short to clip',
      });
    }
    const videoId = BigInt(ep.videoId);
    const existing = await this.prisma.clip.findFirst({
      where: {
        videoId,
        startSeconds: w.start,
        seconds: w.seconds,
        status: { not: 'FAILED' },
      },
    });
    if (existing) return this.clipView(existing);
    try {
      const row = await this.prisma.clip.create({
        data: {
          code: randomCode(8),
          collectionId: BigInt(seriesId),
          episode,
          videoId,
          startSeconds: w.start,
          seconds: w.seconds,
          viewerId: viewerId ? BigInt(viewerId) : null,
          status: 'PENDING',
          createdAt: this.time.toWall(new Date()),
        },
      });
      return this.clipView(row);
    } catch (err) {
      // The same moment asked for at the same time: one row wins, both get it
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const again = await this.prisma.clip.findFirst({
          where: {
            videoId,
            startSeconds: w.start,
            seconds: w.seconds,
            status: { not: 'FAILED' },
          },
        });
        if (again) return this.clipView(again);
      }
      throw err;
    }
  }

  async clip(code: string) {
    const row = await this.prisma.clip.findUnique({ where: { code } });
    if (!row) throw new NotFoundException('Clip not found');
    return this.clipView(row);
  }

  async viewClip(code: string) {
    await this.prisma.clip.updateMany({
      where: { code, status: 'READY' },
      data: { views: { increment: 1 } },
    });
  }

  private async clipView(row: Prisma.ClipGetPayload<object>) {
    const series = await this.prisma.collection.findUnique({
      where: { id: row.collectionId },
      select: { title: true, coverUrl: true },
    });
    return {
      code: row.code,
      status: (row.status === 'WORKING' ? 'PENDING' : row.status) as
        'PENDING' | 'READY' | 'FAILED',
      url: row.status === 'READY' ? await this.media.forBrowser(row.url) : null,
      posterUrl:
        row.status === 'READY'
          ? await this.media.forBrowser(row.posterUrl)
          : null,
      seriesId: Number(row.collectionId),
      seriesTitle: series?.title ?? '',
      seriesPoster: await this.media.forBrowser(series?.coverUrl ?? null),
      episode: row.episode,
      startSeconds: row.startSeconds,
      seconds: row.seconds,
      views: row.views,
    };
  }

  // ---------- "you stopped at…" ----------

  /**
   * Viewers to remind about the next episode of a series they stopped 24–72 hours ago (see
   * resumeDue), with how to reach them. RuengFlix sends the messages and marks each one sent.
   */
  async dueResumeReminders(limit = 200) {
    const now = new Date();
    const since = this.time.toWall(new Date(now.getTime() - RESUME_UNTIL_MS));
    const recent = await this.prisma.$queryRaw<
      { viewer_id: bigint; collection_id: bigint; last_at: Date }[]
    >`
      select viewer_id, collection_id, max(created_at) as last_at
      from streaming_viewer_watches
      group by viewer_id, collection_id
      having max(created_at) >= ${since}
      limit 2000`;
    const out: {
      viewerId: number;
      displayName: string;
      telegramId: number | null;
      seriesId: number;
      title: string;
      episode: number;
      push: { id: number; endpoint: string; p256dh: string; auth: string }[];
    }[] = [];
    const released = new Map<bigint, { count: number; title: string } | null>();
    for (const r of recent) {
      if (out.length >= limit) break;
      if (!released.has(r.collection_id)) {
        const s = await this.catalog
          .get(Number(r.collection_id))
          .then((d) => ({ count: d.episodes.length, title: d.series.title }))
          .catch(() => null);
        released.set(r.collection_id, s);
      }
      const series = released.get(r.collection_id);
      if (!series) continue;
      const finished = new Set(
        (
          await this.prisma.viewerWatch.findMany({
            where: { viewerId: r.viewer_id, collectionId: r.collection_id },
            select: { episode: true },
          })
        ).map((w) => w.episode),
      );
      const lastFinished = Math.max(...finished);
      const next = lastFinished + 1;
      const reminded =
        (await this.prisma.resumeReminder.count({
          where: {
            viewerId: r.viewer_id,
            collectionId: r.collection_id,
            episode: next,
          },
        })) > 0;
      const due = resumeDue({
        lastFinished,
        lastAt: this.time.toInstant(r.last_at),
        released: series.count,
        finished,
        reminded,
        now,
      });
      if (due == null) continue;
      const [viewer, subs] = await Promise.all([
        this.prisma.viewer.findUnique({
          where: { id: r.viewer_id },
          select: { telegramId: true, disabled: true, displayName: true },
        }),
        this.prisma.pushSubscription.findMany({
          where: { viewerId: r.viewer_id },
        }),
      ]);
      if (!viewer || viewer.disabled) continue;
      // Nobody to tell: no Telegram and no browser with notifications on
      if (viewer.telegramId == null && !subs.length) continue;
      out.push({
        viewerId: Number(r.viewer_id),
        displayName: viewer.displayName,
        telegramId:
          viewer.telegramId == null ? null : Number(viewer.telegramId),
        seriesId: Number(r.collection_id),
        title: series.title,
        episode: due,
        push: subs.map((p) => ({
          id: Number(p.id),
          endpoint: p.endpoint,
          p256dh: p.p256dh,
          auth: p.auth,
        })),
      });
    }
    return out;
  }

  /** Record a reminder as sent; false when another server already sent it (don't send twice) */
  async markReminded(viewerId: number, seriesId: number, episode: number) {
    const added = await this.prisma.$executeRaw`
      insert into streaming_resume_reminders (viewer_id, collection_id, episode, sent_at)
      values (${BigInt(viewerId)}, ${BigInt(seriesId)}, ${episode}, ${this.time.toWall(new Date())})
      on conflict do nothing`;
    return { sent: added > 0 };
  }

  private dayDate() {
    return new Date(`${dayIn(this.config.dbTimeZone, new Date())}T00:00:00Z`);
  }
}
