import {
  BadRequestException,
  ConflictException,
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
import { CommerceService } from '../commerce/commerce.service';
import { dayIn } from '../commerce/rules';
import {
  INVITE_COINS,
  INVITE_WATCHES,
  INVITE_WINDOW_MS,
  MISSIONS,
  REACTIONS,
  cleanInviteCode,
  missionByKey,
  newInviteCode,
  reactionBucket,
  searchTerm,
  type ReactionKind,
} from './rules';

export interface MissionView {
  key: string;
  goal: number;
  progress: number;
  coins: number;
  claimed: boolean;
}

/**
 * Bringing viewers back and bringing friends: daily missions, invite-a-friend, emoji reactions on an
 * episode's timeline, trending searches, and the "VIP ends soon" reminders RuengFlix sends.
 */
@Injectable()
export class GrowthService {
  private readonly log = new Logger('growth');

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly commerce: CommerceService,
    @Inject(DbTime) private readonly time: DbTime,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------- missions ----------

  async missions(viewerId: number): Promise<MissionView[]> {
    await this.requireViewer(viewerId);
    const today = this.today();
    // Stored times are wall-clock digits read as UTC (see DbTime), so local midnight is just this
    const day = new Date(`${today}T00:00:00Z`);
    const to = new Date(day.getTime() + 86_400_000);
    const [watched, commented, claims] = await Promise.all([
      this.prisma.viewerWatch.count({
        where: { viewerId: BigInt(viewerId), day },
      }),
      this.prisma.comment.count({
        where: {
          viewerId: BigInt(viewerId),
          parentId: null,
          createdAt: { gte: day, lt: to },
        },
      }),
      this.prisma.missionClaim.findMany({
        where: { viewerId: BigInt(viewerId), day },
      }),
    ]);
    const progress: Record<string, number> = {
      WATCH_3: watched,
      COMMENT_1: commented,
    };
    return MISSIONS.map((m) => ({
      key: m.key,
      goal: m.goal,
      progress: Math.min(m.goal, progress[m.key] ?? 0),
      coins: m.coins,
      claimed: claims.some((c) => c.mission === m.key),
    }));
  }

  /**
   * A signed-in viewer finished an episode (RuengFlix reports it at 90%). Counted once per episode per
   * day, for missions and for the invite reward.
   */
  async recordWatch(viewerId: number, seriesId: number, episode: number) {
    await this.requireViewer(viewerId);
    if (episode > (await this.catalog.episodeCount(seriesId))) {
      throw new NotFoundException('Series or episode not found');
    }
    await this.prisma.$executeRaw`
      insert into streaming_viewer_watches (viewer_id, day, collection_id, episode, created_at)
      values (${BigInt(viewerId)}, ${new Date(`${this.today()}T00:00:00Z`)}::date, ${BigInt(seriesId)},
              ${episode}, ${this.time.toWall(new Date())})
      on conflict do nothing`;
    const invite = await this.rewardInvite(viewerId);
    return { missions: await this.missions(viewerId), inviteRewarded: invite };
  }

  /** Collect a finished mission's coins, once a day */
  async claimMission(viewerId: number, key: string) {
    const mission = missionByKey(key);
    if (!mission) throw new NotFoundException('No such mission');
    const state = (await this.missions(viewerId)).find((m) => m.key === key)!;
    if (state.claimed) {
      throw new ConflictException({
        code: 'ALREADY_CLAIMED',
        message: 'Already collected today',
      });
    }
    if (state.progress < state.goal) {
      throw new BadRequestException({
        code: 'NOT_DONE',
        message: 'Mission not finished yet',
      });
    }
    const today = this.today();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.missionClaim.create({
          data: {
            viewerId: BigInt(viewerId),
            day: new Date(`${today}T00:00:00Z`),
            mission: key,
            coins: mission.coins,
            createdAt: this.time.toWall(new Date()),
          },
        });
        await this.commerce.credit(
          tx,
          viewerId,
          mission.coins,
          'MISSION',
          `${key}:${today}`,
        );
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'ALREADY_CLAIMED',
          message: 'Already collected today',
        });
      }
      throw err;
    }
    return {
      coins: mission.coins,
      missions: await this.missions(viewerId),
      wallet: await this.commerce.wallet(viewerId),
    };
  }

  // ---------- invite a friend ----------

  /** The viewer's invite code (made on first ask) and how their invites are going */
  async invite(viewerId: number) {
    const viewer = await this.prisma.viewer.findUnique({
      where: { id: BigInt(viewerId) },
    });
    if (!viewer) throw new NotFoundException('Viewer not found');
    let code = viewer.inviteCode;
    for (let attempt = 0; !code && attempt < 5; attempt++) {
      const candidate = newInviteCode();
      try {
        await this.prisma.viewer.update({
          where: { id: viewer.id },
          data: { inviteCode: candidate },
        });
        code = candidate;
      } catch (err) {
        if (!(
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ))
          throw err;
      }
    }
    const [joined, rewarded] = await Promise.all([
      this.prisma.referral.count({ where: { inviterId: viewer.id } }),
      this.prisma.referral.count({
        where: { inviterId: viewer.id, rewardedAt: { not: null } },
      }),
    ]);
    return {
      code,
      joined,
      rewarded,
      coinsEach: INVITE_COINS,
      watchesNeeded: INVITE_WATCHES,
    };
  }

  /**
   * A new account came through a friend's invite link. Counts only for accounts made in the last day
   * that weren't invited before, and never for one's own code. Unknown codes are ignored quietly.
   */
  async acceptInvite(viewerId: number, rawCode: string) {
    const code = cleanInviteCode(rawCode);
    const viewer = await this.prisma.viewer.findUnique({
      where: { id: BigInt(viewerId) },
    });
    if (!viewer) throw new NotFoundException('Viewer not found');
    if (!code) return { accepted: false, reason: 'BAD_CODE' };
    const inviter = await this.prisma.viewer.findUnique({
      where: { inviteCode: code },
    });
    if (!inviter || inviter.disabled)
      return { accepted: false, reason: 'BAD_CODE' };
    if (inviter.id === viewer.id)
      return { accepted: false, reason: 'OWN_CODE' };
    if (
      Date.now() - this.time.toInstant(viewer.createdAt).getTime() >
      INVITE_WINDOW_MS
    ) {
      return { accepted: false, reason: 'NOT_NEW' };
    }
    const added = await this.prisma.$executeRaw`
      insert into streaming_referrals (invitee_id, inviter_id, created_at)
      values (${viewer.id}, ${inviter.id}, ${this.time.toWall(new Date())})
      on conflict do nothing`;
    return {
      accepted: added > 0,
      reason: added > 0 ? null : 'ALREADY_INVITED',
    };
  }

  /** Once an invited friend has finished enough episodes, both get coins (exactly once) */
  private async rewardInvite(inviteeId: number): Promise<boolean> {
    const referral = await this.prisma.referral.findUnique({
      where: { inviteeId: BigInt(inviteeId) },
    });
    if (!referral || referral.rewardedAt) return false;
    const watched = await this.prisma.$queryRaw<{ n: bigint }[]>`
      select count(distinct (collection_id, episode)) as n from streaming_viewer_watches
      where viewer_id = ${BigInt(inviteeId)}`;
    if (Number(watched[0]?.n ?? 0) < INVITE_WATCHES) return false;
    return this.prisma.$transaction(async (tx) => {
      const moved = await tx.referral.updateMany({
        where: { inviteeId: BigInt(inviteeId), rewardedAt: null },
        data: { rewardedAt: this.time.toWall(new Date()) },
      });
      if (moved.count !== 1) return false;
      await this.commerce.credit(
        tx,
        inviteeId,
        INVITE_COINS,
        'INVITE',
        `invited-by:${referral.inviterId}`,
      );
      await this.commerce.credit(
        tx,
        Number(referral.inviterId),
        INVITE_COINS,
        'INVITE',
        `invited:${inviteeId}`,
      );
      this.log.log(`Invite rewarded: ${referral.inviterId} → ${inviteeId}`);
      return true;
    });
  }

  // ---------- reactions ----------

  async reactions(seriesId: number, episode: number) {
    const rows = await this.prisma.episodeReaction.findMany({
      where: { collectionId: BigInt(seriesId), episode },
      orderBy: [{ bucket: 'asc' }],
    });
    return rows.map((r) => ({
      bucket: r.bucket,
      kind: r.kind,
      count: r.count,
    }));
  }

  async react(seriesId: number, episode: number, second: number, kind: string) {
    if (!(REACTIONS as readonly string[]).includes(kind)) {
      throw new BadRequestException({
        code: 'BAD_REACTION',
        message: 'Unknown reaction',
      });
    }
    if (episode > (await this.catalog.episodeCount(seriesId))) {
      throw new NotFoundException('Series or episode not found');
    }
    const bucket = reactionBucket(second);
    await this.prisma.$executeRaw`
      insert into streaming_episode_reactions (collection_id, episode, bucket, kind, count)
      values (${BigInt(seriesId)}, ${episode}, ${bucket}, ${kind as ReactionKind}, 1)
      on conflict (collection_id, episode, bucket, kind) do update
        set count = streaming_episode_reactions.count + 1`;
    return { bucket };
  }

  // ---------- search ----------

  async logSearch(raw: string) {
    const term = searchTerm(raw);
    if (!term) return { counted: false };
    await this.prisma.$executeRaw`
      insert into streaming_search_terms (term, day, count)
      values (${term}, ${new Date(`${this.today()}T00:00:00Z`)}::date, 1)
      on conflict (term, day) do update set count = streaming_search_terms.count + 1`;
    return { counted: true };
  }

  /** The most searched terms of the last 7 days (searched at least twice) */
  async trending(limit = 8) {
    const since = new Date(`${this.today()}T00:00:00Z`);
    since.setUTCDate(since.getUTCDate() - 6);
    const rows = await this.prisma.$queryRaw<{ term: string; n: bigint }[]>`
      select term, sum(count) as n from streaming_search_terms
      where day >= ${since}::date group by term having sum(count) >= 2
      order by n desc, term asc limit ${Math.min(20, Math.max(1, limit))}`;
    return rows.map((r) => ({ term: r.term, count: Number(r.n) }));
  }

  // ---------- VIP reminders ----------

  /**
   * Viewers whose VIP ends within 3 days, claimed for reminding in one statement (so two RuengFlix
   * servers never remind the same viewer twice), with where to reach them: Telegram and browsers.
   */
  async claimVipReminders() {
    const now = new Date();
    const claimed = await this.prisma.$queryRaw<
      { viewer_id: bigint; vip_until: Date }[]
    >`
      update streaming_wallets set vip_reminded_for = vip_until
      where vip_until > ${this.time.toWall(now)}
        and vip_until <= ${this.time.toWall(new Date(now.getTime() + 3 * 86_400_000))}
        and vip_reminded_for is distinct from vip_until
      returning viewer_id, vip_until`;
    if (!claimed.length) return [];
    const ids = claimed.map((c) => c.viewer_id);
    const [viewers, subs] = await Promise.all([
      this.prisma.viewer.findMany({
        where: { id: { in: ids }, disabled: false },
        select: { id: true, displayName: true, telegramId: true },
      }),
      this.prisma.pushSubscription.findMany({
        where: { viewerId: { in: ids } },
      }),
    ]);
    return viewers.map((v) => ({
      viewerId: Number(v.id),
      displayName: v.displayName,
      vipUntil: this.time
        .toInstant(claimed.find((c) => c.viewer_id === v.id)!.vip_until)
        .toISOString(),
      telegramId: v.telegramId == null ? null : Number(v.telegramId),
      push: subs
        .filter((s) => s.viewerId === v.id)
        .map((s) => ({
          id: Number(s.id),
          endpoint: s.endpoint,
          p256dh: s.p256dh,
          auth: s.auth,
        })),
    }));
  }

  // ---------- helpers ----------

  private today() {
    return dayIn(this.config.dbTimeZone, new Date());
  }

  private async requireViewer(id: number) {
    const v = await this.prisma.viewer.findUnique({
      where: { id: BigInt(id) },
      select: { id: true },
    });
    if (!v) throw new NotFoundException('Viewer not found');
  }
}
