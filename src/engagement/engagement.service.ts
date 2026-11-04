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

export interface CommentView {
  id: number;
  body: string;
  createdAt: string;
  author: { displayName: string; photoUrl: string | null };
  /** Written by the viewer asking, who may delete it */
  mine: boolean;
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
    const where = {
      collectionId: BigInt(seriesId),
      episode,
      hiddenAt: null,
    };
    const [rows, total] = await Promise.all([
      this.prisma.comment.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: COMMENT_PAGE,
      }),
      this.prisma.comment.count({ where }),
    ]);
    const authors = new Map(
      (
        await this.prisma.viewer.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.viewerId))] } },
          select: { id: true, displayName: true, photoUrl: true },
        })
      ).map((v) => [v.id, v]),
    );
    return {
      total,
      items: rows.map((r): CommentView => ({
        id: Number(r.id),
        body: r.body,
        createdAt: this.time.toInstant(r.createdAt).toISOString(),
        author: {
          displayName: authors.get(r.viewerId)?.displayName ?? '',
          photoUrl: authors.get(r.viewerId)?.photoUrl ?? null,
        },
        mine: viewerId != null && Number(r.viewerId) === viewerId,
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
      },
    });
    return {
      id: Number(row.id),
      body,
      createdAt: this.time.toInstant(row.createdAt).toISOString(),
      author: { displayName: viewer.displayName, photoUrl: viewer.photoUrl },
      mine: true,
    };
  }

  /** Viewers delete only their own comments */
  async deleteComment(viewerId: number, commentId: number) {
    const gone = await this.prisma.comment.deleteMany({
      where: { id: BigInt(commentId), viewerId: BigInt(viewerId) },
    });
    if (gone.count === 0) throw new NotFoundException('Comment not found');
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
