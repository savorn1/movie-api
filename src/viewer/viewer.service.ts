import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogService } from '../catalog/catalog.service';
import { DbTime } from '../common/db-time';
import type {
  AlertLogDto,
  FollowDto,
  PlayDto,
  ReportDto,
  VoteDto,
} from './viewer.dto';
import { voteDelta } from './vote-delta';

export interface Likes {
  likes: number;
  dislikes: number;
}

export interface EpisodeStats extends Likes {
  episode: number;
  starts: number;
  completes: number;
}

export interface ReportView {
  id: number;
  seriesId: number;
  seriesTitle: string | null;
  episode: number;
  reason: string;
  note: string;
  positionSeconds: number;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

/** Newest reports returned by reports(); older ones stay in the table */
export const REPORT_LIST_LIMIT = 500;

/**
 * What viewers do on RuengFlix: plays, 👍/👎, problem reports and Telegram follows, per series and
 * episode number, in VideoLingo's database (tables from its V17 migration). Writes are only accepted for
 * listed series and released episodes, so the tables can't fill up with made-up ids.
 */
@Injectable()
export class ViewerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    @Inject(DbTime) private readonly time: DbTime,
  ) {}

  // ---------- plays and votes ----------

  async recordPlay({ seriesId, episode, event }: PlayDto) {
    await this.requireEpisode(seriesId, episode);
    const field =
      event === 'START'
        ? 'starts'
        : event === 'WALL'
          ? 'wallViews'
          : 'completes';
    await this.prisma.episodeStats.upsert({
      where: {
        collectionId_episode: { collectionId: BigInt(seriesId), episode },
      },
      create: {
        collectionId: BigInt(seriesId),
        episode,
        starts: 0,
        completes: 0,
        likes: 0,
        dislikes: 0,
        [field]: 1,
      },
      update: { [field]: { increment: 1 } },
    });
  }

  /** Applies a vote and returns the episode's new totals (never below zero) */
  async vote({ seriesId, episode, vote, previous }: VoteDto): Promise<Likes> {
    await this.requireEpisode(seriesId, episode);
    const d = voteDelta(vote, previous ?? 0);
    // One statement, so concurrent votes can't lose each other's update
    const [row] = await this.prisma.$queryRaw<
      { likes: bigint; dislikes: bigint }[]
    >`
      insert into streaming_episode_stats (collection_id, episode, likes, dislikes)
      values (${BigInt(seriesId)}, ${episode}, greatest(0, ${d.likes}), greatest(0, ${d.dislikes}))
      on conflict (collection_id, episode) do update
      set likes = greatest(0, streaming_episode_stats.likes + ${d.likes}),
          dislikes = greatest(0, streaming_episode_stats.dislikes + ${d.dislikes})
      returning likes, dislikes`;
    return { likes: Number(row.likes), dislikes: Number(row.dislikes) };
  }

  /** Counters for each episode of a series that has any, in episode order */
  async episodeStats(seriesId: number): Promise<EpisodeStats[]> {
    const rows = await this.prisma.episodeStats.findMany({
      where: { collectionId: BigInt(seriesId) },
      orderBy: { episode: 'asc' },
    });
    return rows.map((r) => ({
      episode: r.episode,
      starts: Number(r.starts),
      completes: Number(r.completes),
      likes: Number(r.likes),
      dislikes: Number(r.dislikes),
    }));
  }

  /** 👍/👎 summed over all episodes, per series id (series without votes left out) */
  async likesBySeries(): Promise<Record<number, Likes>> {
    const rows = await this.prisma.episodeStats.groupBy({
      by: ['collectionId'],
      _sum: { likes: true, dislikes: true },
    });
    const out: Record<number, Likes> = {};
    for (const r of rows) {
      const likes = Number(r._sum.likes ?? 0);
      const dislikes = Number(r._sum.dislikes ?? 0);
      if (likes + dislikes > 0)
        out[Number(r.collectionId)] = { likes, dislikes };
    }
    return out;
  }

  // ---------- problem reports ----------

  async report(r: ReportDto): Promise<ReportView> {
    await this.requireEpisode(r.seriesId, r.episode);
    const created = await this.prisma.report.create({
      data: {
        collectionId: BigInt(r.seriesId),
        episode: r.episode,
        reason: r.reason,
        note: (r.note ?? '').trim(),
        positionSeconds: r.positionSeconds ?? 0,
        createdAt: this.time.toWall(new Date()),
      },
    });
    return this.findReport(created.id);
  }

  /** Newest first; open ones only unless `includeResolved` */
  async reports(includeResolved: boolean): Promise<ReportView[]> {
    const rows = await this.prisma.report.findMany({
      where: includeResolved ? {} : { resolvedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: REPORT_LIST_LIMIT,
    });
    return this.withTitles(rows);
  }

  async resolve(id: number, resolved: boolean, by: string | undefined) {
    const existing = await this.prisma.report.findUnique({
      where: { id: BigInt(id) },
    });
    if (!existing) throw new NotFoundException('Report not found');
    await this.prisma.report.update({
      where: { id: BigInt(id) },
      // Resolving twice keeps the first time and person
      data: resolved
        ? {
            resolvedAt: existing.resolvedAt ?? this.time.toWall(new Date()),
            resolvedBy: existing.resolvedBy ?? by ?? null,
          }
        : { resolvedAt: null, resolvedBy: null },
    });
    return this.findReport(BigInt(id));
  }

  private async findReport(id: bigint): Promise<ReportView> {
    const row = await this.prisma.report.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Report not found');
    return (await this.withTitles([row]))[0];
  }

  private async withTitles(
    rows: {
      id: bigint;
      collectionId: bigint;
      episode: number;
      reason: string;
      note: string;
      positionSeconds: number;
      createdAt: Date;
      resolvedAt: Date | null;
      resolvedBy: string | null;
    }[],
  ): Promise<ReportView[]> {
    const ids = [...new Set(rows.map((r) => r.collectionId))];
    const titles = new Map(
      (
        await this.prisma.collection.findMany({
          where: { id: { in: ids } },
          select: { id: true, title: true },
        })
      ).map((c) => [c.id, c.title]),
    );
    return rows.map((r) => ({
      id: Number(r.id),
      seriesId: Number(r.collectionId),
      seriesTitle: titles.get(r.collectionId) ?? null,
      episode: r.episode,
      reason: r.reason,
      note: r.note,
      positionSeconds: r.positionSeconds,
      createdAt: this.time.toInstant(r.createdAt).toISOString(),
      resolvedAt: this.time.toInstant(r.resolvedAt)?.toISOString() ?? null,
      resolvedBy: r.resolvedBy,
    }));
  }

  // ---------- Telegram follows ----------

  async follow({ seriesId, chatId }: FollowDto) {
    await this.catalog.episodeCount(seriesId);
    await this.prisma.follow.upsert({
      where: {
        collectionId_chatId: {
          collectionId: BigInt(seriesId),
          chatId: BigInt(chatId),
        },
      },
      create: {
        collectionId: BigInt(seriesId),
        chatId: BigInt(chatId),
        createdAt: this.time.toWall(new Date()),
      },
      update: {},
    });
  }

  /** Stops one series' alerts for a chat; works for series no longer listed too */
  async unfollow(seriesId: number, chatId: number) {
    await this.prisma.follow.deleteMany({
      where: { collectionId: BigInt(seriesId), chatId: BigInt(chatId) },
    });
  }

  /** Stops every alert for a chat (/stop, or it blocked the bot); returns the series it followed */
  async unfollowAll(chatId: number): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<{ collection_id: bigint }[]>`
      delete from streaming_follows where chat_id = ${BigInt(chatId)} returning collection_id`;
    return rows.map((r) => Number(r.collection_id));
  }

  async followers(seriesId: number): Promise<number[]> {
    const rows = await this.prisma.follow.findMany({
      where: { collectionId: BigInt(seriesId) },
      orderBy: { createdAt: 'asc' },
      select: { chatId: true },
    });
    return rows.map((r) => Number(r.chatId));
  }

  async followedBy(chatId: number): Promise<number[]> {
    const rows = await this.prisma.follow.findMany({
      where: { chatId: BigInt(chatId) },
      orderBy: { createdAt: 'asc' },
      select: { collectionId: true },
    });
    return rows.map((r) => Number(r.collectionId));
  }

  // ---------- new-episode alerts ----------

  /**
   * Whether the caller should announce the series' newest episode to its followers: true once per new
   * episode count however many RuengFlix instances ask, because only the first update succeeds. The
   * first look at a series only records its count, so turning streaming on doesn't announce the back
   * catalog.
   */
  async claimAlert(seriesId: number) {
    const episodes = await this.catalog.episodeCount(seriesId);
    const id = BigInt(seriesId);
    const newer =
      (await this.prisma.$executeRaw`
        update streaming_alert_marks set episodes = ${episodes}
        where collection_id = ${id} and episodes < ${episodes}`) > 0;
    if (!newer) {
      await this.prisma.$executeRaw`
        insert into streaming_alert_marks (collection_id, episodes) values (${id}, ${episodes})
        on conflict do nothing`;
    }
    return { alert: newer, episodes };
  }

  /** Records an alert RuengFlix sent, for the admin portal's alert history */
  async logAlert(seriesId: number, a: AlertLogDto) {
    await this.requireEpisode(seriesId, a.episode);
    await this.prisma.alertLog.create({
      data: {
        collectionId: BigInt(seriesId),
        episode: a.episode,
        source: a.source,
        followers: a.followers,
        sent: a.sent,
        removed: a.removed,
        failed: a.failed,
        createdAt: this.time.toWall(new Date()),
      },
    });
  }

  private async requireEpisode(seriesId: number, episode: number) {
    if (episode > (await this.catalog.episodeCount(seriesId))) {
      throw new NotFoundException('Series or episode not found');
    }
  }
}
