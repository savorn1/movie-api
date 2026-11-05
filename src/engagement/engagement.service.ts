import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DbTime } from '../common/db-time';
import { APP_CONFIG, type AppConfig } from '../config';
import { CatalogService } from '../catalog/catalog.service';
import { dayIn } from '../commerce/rules';
import type { CommentDto, PushSubscriptionDto } from './engagement.dto';
import { fanStatus, type FanBadge } from '../marketing/rules';

export interface CommentView {
  id: number;
  body: string;
  createdAt: string;
  author: {
    displayName: string;
    photoUrl: string | null;
    /** Fan level 1–6 and badges (see fanStatus); level 0 for RuengFlix's own replies */
    level: number;
    badges: FanBadge[];
  };
  /** Seconds into the episode it was written at, while watching */
  atSeconds: number | null;
  /** Written by the viewer asking, who may delete it */
  mine: boolean;
  likes: number;
  /** The viewer asking has liked it */
  liked: boolean;
  /** Pinned by an admin: shown first */
  pinned: boolean;
  /** Written by RuengFlix in the admin portal */
  official: boolean;
  /** Official replies under it (oldest first); always empty on replies */
  replies: CommentView[];
}

/** Reports that hide a comment until an admin looks at it */
export const AUTO_HIDE_REPORTS = 5;
const COMMENT_PAGE = 50;

/**
 * Comments under episodes, browser push subscriptions, the days viewers were active, and "because
 * you watched" suggestions (series watched by the same viewers, from synced libraries).
 */
@Injectable()
export class EngagementService {
  private readonly log = new Logger('engagement');

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    @Inject(DbTime) private readonly time: DbTime,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------- comments ----------

  async comments(seriesId: number, episode: number, viewerId?: number) {
    // Top-level comments only; official replies come under the one they answer
    const where = {
      collectionId: BigInt(seriesId),
      episode,
      hiddenAt: null,
      parentId: null,
    };
    const [rows, total] = await Promise.all([
      this.prisma.comment.findMany({
        where,
        // The pinned one first, then newest
        orderBy: [
          { pinnedAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
        take: COMMENT_PAGE,
      }),
      this.prisma.comment.count({ where }),
    ]);
    const replies = rows.length
      ? await this.prisma.comment.findMany({
          where: { parentId: { in: rows.map((r) => r.id) }, hiddenAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [];
    const viewerIds = [
      ...new Set(
        [...rows, ...replies]
          .map((r) => r.viewerId)
          .filter((v): v is bigint => v != null),
      ),
    ];
    const authors = new Map(
      (
        await this.prisma.viewer.findMany({
          where: { id: { in: viewerIds } },
          select: { id: true, displayName: true, photoUrl: true },
        })
      ).map((v) => [v.id, v]),
    );
    const fans = await this.fanStatuses(viewerIds);
    const liked = new Set(
      viewerId == null || !rows.length
        ? []
        : (
            await this.prisma.commentLike.findMany({
              where: {
                viewerId: BigInt(viewerId),
                commentId: { in: rows.map((r) => r.id) },
              },
              select: { commentId: true },
            })
          ).map((l) => l.commentId),
    );
    const view = (r: (typeof rows)[number]): CommentView => {
      const author = r.viewerId != null ? authors.get(r.viewerId) : undefined;
      return {
        id: Number(r.id),
        body: r.body,
        createdAt: this.time.toInstant(r.createdAt).toISOString(),
        author: {
          displayName: r.authorAdmin
            ? 'RuengFlix'
            : (author?.displayName ?? ''),
          photoUrl: r.authorAdmin ? null : (author?.photoUrl ?? null),
          level:
            r.authorAdmin || r.viewerId == null
              ? 0
              : (fans.get(r.viewerId)?.level ?? 1),
          badges:
            r.authorAdmin || r.viewerId == null
              ? []
              : (fans.get(r.viewerId)?.badges ?? []),
        },
        atSeconds: r.atSeconds,
        official: !!r.authorAdmin,
        mine:
          viewerId != null &&
          r.viewerId != null &&
          Number(r.viewerId) === viewerId,
        likes: r.likeCount,
        liked: liked.has(r.id),
        pinned: r.pinnedAt != null,
        replies: [],
      };
    };
    return {
      total,
      items: rows.map((r) => ({
        ...view(r),
        replies: replies
          .filter((x) => x.parentId === r.id)
          .map((x) => ({ ...view(x), replies: [] })),
      })),
    };
  }

  async addComment(viewerId: number, c: CommentDto): Promise<CommentView> {
    const viewer = await this.prisma.viewer.findUnique({
      where: { id: BigInt(viewerId) },
    });
    if (!viewer) throw new NotFoundException('Viewer not found');
    if (viewer.disabled) throw new ForbiddenException({ code: 'DISABLED' });
    if (c.episode > (await this.catalog.episodeCount(c.seriesId))) {
      throw new NotFoundException('Series or episode not found');
    }
    const body = c.body.trim().replace(/\n{3,}/g, '\n\n');
    if (!body) {
      throw new BadRequestException({
        code: 'EMPTY',
        message: 'Write something',
      });
    }
    const row = await this.prisma.comment.create({
      data: {
        collectionId: BigInt(c.seriesId),
        episode: c.episode,
        viewerId: BigInt(viewerId),
        body,
        createdAt: this.time.toWall(new Date()),
        atSeconds: c.atSeconds ?? null,
      },
    });
    const fan = (await this.fanStatuses([viewer.id])).get(viewer.id);
    return {
      id: Number(row.id),
      body,
      createdAt: this.time.toInstant(row.createdAt).toISOString(),
      atSeconds: row.atSeconds,
      author: {
        displayName: viewer.displayName,
        photoUrl: viewer.photoUrl,
        level: fan?.level ?? 1,
        badges: fan?.badges ?? [],
      },
      mine: true,
      likes: 0,
      liked: false,
      pinned: false,
      official: false,
      replies: [],
    };
  }

  /**
   * Comments written at a moment of the episode, oldest moment first, to float across the video as
   * it plays (hidden ones and replies left out). Short: just what the overlay draws.
   */
  async timedComments(seriesId: number, episode: number) {
    const rows = await this.prisma.comment.findMany({
      where: {
        collectionId: BigInt(seriesId),
        episode,
        hiddenAt: null,
        parentId: null,
        atSeconds: { not: null },
      },
      orderBy: [{ atSeconds: 'asc' }, { id: 'asc' }],
      take: 500,
      select: { id: true, body: true, atSeconds: true, likeCount: true },
    });
    return rows.map((r) => ({
      id: Number(r.id),
      at: r.atSeconds!,
      body: r.body.length > 80 ? `${r.body.slice(0, 79)}…` : r.body,
      likes: r.likeCount,
    }));
  }

  /** A viewer's fan level and badges (shown on their Me page) */
  async fan(viewerId: number) {
    const stats = (await this.fanStatuses([BigInt(viewerId)])).get(
      BigInt(viewerId),
    );
    return (
      stats ?? { level: 1, badges: [], episodes: 0, likes: 0, bestStreak: 0 }
    );
  }

  /** Fan level and badges for several viewers, from episodes finished, likes received and streaks */
  private async fanStatuses(ids: bigint[]) {
    const out = new Map<
      bigint,
      ReturnType<typeof fanStatus> & {
        episodes: number;
        likes: number;
        bestStreak: number;
      }
    >();
    if (!ids.length) return out;
    const [watches, likes, streaks] = await Promise.all([
      this.prisma.viewerWatch.groupBy({
        by: ['viewerId'],
        where: { viewerId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.comment.groupBy({
        by: ['viewerId'],
        where: { viewerId: { in: ids } },
        _sum: { likeCount: true },
      }),
      this.prisma.checkIn.groupBy({
        by: ['viewerId'],
        where: { viewerId: { in: ids } },
        _max: { streak: true },
      }),
    ]);
    for (const id of ids) {
      const stats = {
        episodes: watches.find((w) => w.viewerId === id)?._count._all ?? 0,
        likes: likes.find((l) => l.viewerId === id)?._sum.likeCount ?? 0,
        bestStreak: streaks.find((s) => s.viewerId === id)?._max.streak ?? 0,
      };
      out.set(id, { ...fanStatus(stats), ...stats });
    }
    return out;
  }

  /** Viewers delete only their own comments */
  async deleteComment(viewerId: number, commentId: number) {
    const gone = await this.prisma.comment.deleteMany({
      where: { id: BigInt(commentId), viewerId: BigInt(viewerId) },
    });
    if (gone.count === 0) throw new NotFoundException('Comment not found');
  }

  /** Like or unlike a visible comment (one like per viewer); returns the new count */
  async likeComment(viewerId: number, commentId: number, like: boolean) {
    const comment = await this.prisma.comment.findFirst({
      where: { id: BigInt(commentId), hiddenAt: null },
      select: { id: true },
    });
    if (!comment) throw new NotFoundException('Comment not found');
    const id = comment.id;
    const viewer = BigInt(viewerId);
    await this.prisma.$transaction(async (tx) => {
      // The count moves only when the like row really changed, so repeated taps can't drift it
      const changed = like
        ? await tx.$executeRaw`
            insert into streaming_comment_likes (comment_id, viewer_id, created_at)
            values (${id}, ${viewer}, ${this.time.toWall(new Date())})
            on conflict do nothing`
        : await tx.$executeRaw`
            delete from streaming_comment_likes where comment_id = ${id} and viewer_id = ${viewer}`;
      if (changed > 0) {
        await tx.$executeRaw`
          update streaming_comments set like_count = greatest(0, like_count + ${like ? 1 : -1})
          where id = ${id}`;
      }
    });
    const after = await this.prisma.comment.findUnique({
      where: { id },
      select: { likeCount: true },
    });
    return { likes: after?.likeCount ?? 0, liked: like };
  }

  /** One report per viewer per comment; enough of them hide it until an admin decides */
  async reportComment(viewerId: number, commentId: number) {
    const comment = await this.prisma.comment.findUnique({
      where: { id: BigInt(commentId) },
    });
    if (!comment) throw new NotFoundException('Comment not found');
    const added = await this.prisma.$executeRaw`
      insert into streaming_comment_reports (comment_id, viewer_id, created_at)
      values (${comment.id}, ${BigInt(viewerId)}, ${this.time.toWall(new Date())})
      on conflict do nothing`;
    if (added > 0) {
      await this.prisma.$executeRaw`
        update streaming_comments set report_count = report_count + 1,
          hidden_at = case when report_count + 1 >= ${AUTO_HIDE_REPORTS} and hidden_at is null
                           then ${this.time.toWall(new Date())} else hidden_at end,
          hidden_by = case when report_count + 1 >= ${AUTO_HIDE_REPORTS} and hidden_at is null
                           then 'reports' else hidden_by end
        where id = ${comment.id}`;
    }
  }

  // ---------- browser push ----------

  async subscribe(s: PushSubscriptionDto) {
    const row = await this.prisma.pushSubscription.upsert({
      where: { endpoint: s.endpoint },
      create: {
        endpoint: s.endpoint,
        p256dh: s.p256dh,
        auth: s.auth,
        viewerId: s.viewerId ? BigInt(s.viewerId) : null,
        createdAt: this.time.toWall(new Date()),
      },
      update: {
        p256dh: s.p256dh,
        auth: s.auth,
        ...(s.viewerId ? { viewerId: BigInt(s.viewerId) } : {}),
      },
    });
    const follows = await this.prisma.pushFollow.findMany({
      where: { subscriptionId: row.id },
      select: { collectionId: true },
    });
    return {
      id: Number(row.id),
      following: follows.map((f) => Number(f.collectionId)),
    };
  }

  async unsubscribe(endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint } });
  }

  async setPushFollow(endpoint: string, seriesId: number, follow: boolean) {
    const sub = await this.prisma.pushSubscription.findUnique({
      where: { endpoint },
    });
    if (!sub) throw new NotFoundException('Subscription not found');
    if (follow) {
      await this.catalog.episodeCount(seriesId);
      await this.prisma.pushFollow.upsert({
        where: {
          subscriptionId_collectionId: {
            subscriptionId: sub.id,
            collectionId: BigInt(seriesId),
          },
        },
        create: { subscriptionId: sub.id, collectionId: BigInt(seriesId) },
        update: {},
      });
    } else {
      await this.prisma.pushFollow.deleteMany({
        where: { subscriptionId: sub.id, collectionId: BigInt(seriesId) },
      });
    }
  }

  /** Where to send a series' new-episode push */
  async pushTargets(seriesId: number) {
    const rows = await this.prisma.$queryRaw<
      { id: bigint; endpoint: string; p256dh: string; auth: string }[]
    >`
      select s.id, s.endpoint, s.p256dh, s.auth from streaming_push_subscriptions s
      join streaming_push_follows f on f.subscription_id = s.id
      where f.collection_id = ${BigInt(seriesId)}`;
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  }

  /** A subscription the push service says is gone (404/410) */
  async dropSubscription(id: number) {
    await this.prisma.pushSubscription.deleteMany({
      where: { id: BigInt(id) },
    });
  }

  // ---------- activity and suggestions ----------

  /** Remember that a signed-in viewer used the site today (retention in the admin portal) */
  async active(viewerId: number) {
    const day = dayIn(this.config.dbTimeZone, new Date());
    await this.prisma.$executeRaw`
      insert into streaming_viewer_days (viewer_id, day)
      select ${BigInt(viewerId)}, ${day}::date
      where exists (select 1 from streaming_viewers where id = ${BigInt(viewerId)})
      on conflict do nothing`;
  }

  /**
   * Series most often in the watch history of viewers who also watched `seriesIds`, best first,
   * leaving those out. Only listed series. From synced libraries, so only signed-in viewers count.
   */
  async recommendations(seriesIds: number[], limit: number) {
    if (!seriesIds.length) return [];
    let rows: { sid: bigint; n: bigint }[] = [];
    try {
      rows = await this.prisma.$queryRaw`
        with libs as (
          select l.viewer_id, (h->>'id')::bigint as sid
          from streaming_viewer_libraries l,
               jsonb_array_elements(coalesce(l.data_json::jsonb->'history', '[]'::jsonb)) h
          where jsonb_typeof(l.data_json::jsonb->'history') = 'array' and (h->>'id') ~ '^[0-9]{1,18}$'
        ),
        watchers as (
          select distinct viewer_id from libs where sid = any(${seriesIds.map(BigInt)}::bigint[])
        )
        select sid, count(distinct viewer_id) as n from libs
        where viewer_id in (select viewer_id from watchers) and sid <> all(${seriesIds.map(BigInt)}::bigint[])
        group by sid order by n desc, sid desc limit 100`;
    } catch (err) {
      // One damaged library must not break the home page
      this.log.warn(`recommendations: ${(err as Error).message}`);
      return [];
    }
    const listed = new Set((await this.catalog.list()).map((s) => s.id));
    return rows
      .map((r) => ({ seriesId: Number(r.sid), viewers: Number(r.n) }))
      .filter((r) => listed.has(r.seriesId))
      .slice(0, limit);
  }
}
