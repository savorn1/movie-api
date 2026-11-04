import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DbTime } from '../common/db-time';
import { APP_CONFIG, type AppConfig } from '../config';
import { CatalogService } from '../catalog/catalog.service';
import { pricesFrom, type Prices } from '../site/prices';
import { Khqr } from './khqr';
import {
  billNumber,
  checkInReward,
  dayIn,
  nextStreak,
  previousDay,
  quote,
  vipExtended,
  type OrderKind,
} from './rules';

export interface WalletView {
  coins: number;
  vipUntil: string | null;
  vipActive: boolean;
  checkIn: {
    doneToday: boolean;
    /** Days in a row so far (including today once checked in) */
    streak: number;
    /** Coins the next check-in pays */
    nextReward: number;
  };
  episodeCoins: number;
  /** KHQR payments are set up (KHQR_ACCOUNT_ID) */
  paymentsOn: boolean;
}

export interface OrderView {
  id: number;
  kind: OrderKind;
  amountUsd: number;
  coins: number | null;
  seriesId: number | null;
  seriesTitle: string | null;
  months: number | null;
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  billNumber: string;
  /** The KHQR to show while it can still be paid; null afterwards */
  khqr: string | null;
  expiresAt: string;
  createdAt: string;
  paidAt: string | null;
  /** Bakong confirms payments by itself; otherwise an admin checks and confirms */
  autoConfirm: boolean;
}

type Tx = Prisma.TransactionClient;
type DbOrder = Prisma.OrderGetPayload<object>;

/** How much proof a "mark paid" needs: Bakong's own confirmation, or an admin's name */
export type PaidBy = { by: 'bakong'; hash: string } | { by: string };

/**
 * RuengFlix payments and coins: KHQR orders for coin packs, a series or VIP time; the daily check-in;
 * and unlocking single episodes with coins. A paid order is fulfilled exactly once, inside the same
 * transaction that marks it paid. Errors carry a `code` for RuengFlix's Khmer messages:
 * PAYMENTS_OFF, NO_PRODUCT, ALREADY_OWNED, NOT_VIP_EPISODE, NOT_ENOUGH_COINS, ALREADY_CHECKED_IN.
 */
@Injectable()
export class CommerceService {
  private readonly log = new Logger('commerce');
  readonly khqr: Khqr;

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    @Inject(DbTime) private readonly time: DbTime,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.khqr = new Khqr(config.payments);
  }

  async prices(): Promise<Prices> {
    const row = await this.prisma.appSetting.findUnique({
      where: { section: 'streaming' },
      select: { valueJson: true },
    });
    return pricesFrom(row?.valueJson);
  }

  // ---------- wallet and check-in ----------

  async wallet(viewerId: number): Promise<WalletView> {
    await this.requireViewer(viewerId);
    const [wallet, prices, last] = await Promise.all([
      this.prisma.wallet.findUnique({ where: { viewerId: BigInt(viewerId) } }),
      this.prices(),
      this.lastCheckIn(viewerId),
    ]);
    const today = this.today();
    const doneToday = last?.day === today;
    const streak = doneToday
      ? last.streak
      : last?.day === previousDay(today)
        ? last.streak
        : 0;
    const vipUntil = this.time.toInstant(wallet?.vipUntil ?? null);
    return {
      coins: wallet?.coins ?? 0,
      vipUntil: vipUntil?.toISOString() ?? null,
      vipActive: !!vipUntil && vipUntil > new Date(),
      checkIn: {
        doneToday,
        streak,
        nextReward: checkInReward(
          prices.checkInCoins,
          doneToday ? streak + 1 : nextStreak(last, today),
        ),
      },
      episodeCoins: prices.episodeCoins,
      paymentsOn: this.khqr.enabled,
    };
  }

  /** Today's check-in: coins, once per local day; every 7th day in a row pays double */
  async checkIn(viewerId: number): Promise<WalletView> {
    await this.requireViewer(viewerId);
    const prices = await this.prices();
    const today = this.today();
    const last = await this.lastCheckIn(viewerId);
    if (last?.day === today) {
      throw new ConflictException({
        code: 'ALREADY_CHECKED_IN',
        message: 'Already checked in today',
      });
    }
    const streak = nextStreak(last, today);
    const coins = checkInReward(prices.checkInCoins, streak);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.checkIn.create({
          data: {
            viewerId: BigInt(viewerId),
            day: new Date(`${today}T00:00:00Z`),
            coins,
            streak,
          },
        });
        await this.addCoins(tx, viewerId, coins, 'CHECK_IN', `day:${today}`);
      });
    } catch (err) {
      // Two taps at once: the first one won
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'ALREADY_CHECKED_IN',
          message: 'Already checked in today',
        });
      }
      throw err;
    }
    return this.wallet(viewerId);
  }

  /** Unlock one VIP episode with coins. Free, or already theirs: nothing is charged. */
  async unlockEpisode(viewerId: number, seriesId: number, episode: number) {
    await this.requireViewer(viewerId);
    const detail = await this.catalog.get(seriesId, viewerId);
    const ep = detail.episodes.find((e) => e.number === episode);
    if (!ep) throw new NotFoundException('Series or episode not found');
    if (!ep.premium) {
      throw new BadRequestException({
        code: 'NOT_VIP_EPISODE',
        message: 'That episode is free',
      });
    }
    if (!ep.locked) return { charged: 0, wallet: await this.wallet(viewerId) };

    const cost = (await this.prices()).episodeCoins;
    try {
      await this.chargeForEpisode(viewerId, seriesId, episode, cost);
    } catch (err) {
      // Another tap unlocked it first; this one's charge was rolled back with its transaction
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return { charged: 0, wallet: await this.wallet(viewerId) };
      }
      throw err;
    }
    return { charged: cost, wallet: await this.wallet(viewerId) };
  }

  private async chargeForEpisode(
    viewerId: number,
    seriesId: number,
    episode: number,
    cost: number,
  ) {
    await this.prisma.$transaction(async (tx) => {
      // Taken only if there are enough, in one statement, so two taps can't overspend
      const taken = await tx.$executeRaw`
        update streaming_wallets set coins = coins - ${cost}, updated_at = ${this.time.toWall(new Date())}
        where viewer_id = ${BigInt(viewerId)} and coins >= ${cost}`;
      if (taken === 0) {
        throw new HttpException(
          { code: 'NOT_ENOUGH_COINS', message: 'Not enough coins' },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
      await tx.coinLedger.create({
        data: {
          viewerId: BigInt(viewerId),
          delta: -cost,
          reason: 'UNLOCK',
          ref: `series:${seriesId}:ep:${episode}`,
          createdAt: this.time.toWall(new Date()),
        },
      });
      await tx.entitlement.create({
        data: {
          viewerId: BigInt(viewerId),
          collectionId: BigInt(seriesId),
          episode,
          source: 'COINS',
          createdAt: this.time.toWall(new Date()),
        },
      });
    });
  }

  async ledger(viewerId: number) {
    await this.requireViewer(viewerId);
    const rows = await this.prisma.coinLedger.findMany({
      where: { viewerId: BigInt(viewerId) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    return rows.map((r) => ({
      id: Number(r.id),
      delta: r.delta,
      reason: r.reason,
      ref: r.ref,
      createdAt: this.time.toInstant(r.createdAt).toISOString(),
    }));
  }

  // ---------- orders ----------

  async createOrder(
    viewerId: number,
    req: {
      kind: OrderKind;
      coins?: number;
      months?: number;
      seriesId?: number;
    },
  ): Promise<OrderView> {
    await this.requireViewer(viewerId);
    if (!this.khqr.enabled) {
      throw new ServiceUnavailableException({
        code: 'PAYMENTS_OFF',
        message: 'Payments are not set up',
      });
    }
    const q = quote(await this.prices(), req);
    if (!q) {
      throw new BadRequestException({
        code: 'NO_PRODUCT',
        message: 'No such product',
      });
    }
    if (q.kind === 'SERIES') {
      const detail = await this.catalog.get(q.collectionId!, viewerId);
      if (!detail.series.vip || !detail.episodes.some((e) => e.premium)) {
        throw new BadRequestException({
          code: 'NO_PRODUCT',
          message: 'That series is free',
        });
      }
      if (!detail.episodes.some((e) => e.locked)) {
        throw new ConflictException({
          code: 'ALREADY_OWNED',
          message: 'Already unlocked',
        });
      }
    }

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + this.config.payments.qrMinutes * 60_000,
    );
    const bill = billNumber();
    const { qr, md5 } = this.khqr.make(q.amountUsd, bill, expiresAt);
    const order = await this.prisma.order.create({
      data: {
        viewerId: BigInt(viewerId),
        kind: q.kind,
        amountUsd: new Prisma.Decimal(q.amountUsd),
        coins: q.coins ?? null,
        months: q.months ?? null,
        collectionId: q.collectionId ? BigInt(q.collectionId) : null,
        status: 'PENDING',
        billNumber: bill,
        khqr: qr,
        khqrMd5: md5,
        expiresAt: this.time.toWall(expiresAt),
        createdAt: this.time.toWall(now),
      },
    });
    return (await this.views([order]))[0];
  }

  async orders(viewerId: number): Promise<OrderView[]> {
    await this.requireViewer(viewerId);
    const rows = await this.prisma.order.findMany({
      where: { viewerId: BigInt(viewerId) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    return this.views(rows);
  }

  /**
   * One of the viewer's orders, brought up to date: a pending one is checked with Bakong (when it can
   * confirm payments) and fulfilled if paid, or marked expired once its KHQR can't be paid any more.
   */
  async order(viewerId: number, orderId: number): Promise<OrderView> {
    let order = await this.prisma.order.findFirst({
      where: { id: BigInt(orderId), viewerId: BigInt(viewerId) },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'PENDING' && this.khqr.autoConfirm) {
      const payment = await this.khqr.paymentFor(order.khqrMd5);
      if (payment && this.khqr.accepts(payment, Number(order.amountUsd))) {
        order = await this.markPaid(orderId, {
          by: 'bakong',
          hash: payment.hash,
        });
      } else if (
        !payment &&
        this.time.toInstant(order.expiresAt) < new Date(Date.now() - 60_000)
      ) {
        // A minute's grace for a payment made in the last seconds
        await this.prisma.order.updateMany({
          where: { id: order.id, status: 'PENDING' },
          data: { status: 'EXPIRED' },
        });
        order = (await this.prisma.order.findUnique({
          where: { id: order.id },
        }))!;
      }
    }
    return (await this.views([order]))[0];
  }

  /**
   * Mark an order paid and deliver it (coins, the series, or VIP time), exactly once: only the call that
   * moves it out of PENDING/EXPIRED fulfils it. Admins confirm by name; Bakong's confirmation carries
   * its transaction hash. Returns the order either way.
   */
  async markPaid(orderId: number, paid: PaidBy): Promise<DbOrder> {
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.order.updateMany({
        where: { id: BigInt(orderId), status: { in: ['PENDING', 'EXPIRED'] } },
        data: {
          status: 'PAID',
          paidAt: this.time.toWall(now),
          paidBy: paid.by.slice(0, 100),
          bakongHash: 'hash' in paid ? paid.hash.slice(0, 100) : null,
        },
      });
      const order = await tx.order.findUnique({
        where: { id: BigInt(orderId) },
      });
      if (!order) throw new NotFoundException('Order not found');
      if (moved.count === 1 && order.viewerId != null) {
        await this.fulfil(tx, order, now);
      }
      return order;
    });
    if (result.status === 'PAID') {
      this.log.log(
        `Order ${orderId} paid (${result.kind} $${result.amountUsd.toString()}) by ${result.paidBy}`,
      );
    }
    return result;
  }

  /** Admin: give up on a pending order (the viewer didn't pay) */
  async cancel(orderId: number, by: string): Promise<DbOrder> {
    await this.prisma.order.updateMany({
      where: { id: BigInt(orderId), status: { in: ['PENDING', 'EXPIRED'] } },
      data: { status: 'CANCELLED', note: `Cancelled by ${by}`.slice(0, 300) },
    });
    const order = await this.prisma.order.findUnique({
      where: { id: BigInt(orderId) },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  // ---------- helpers ----------

  private async fulfil(tx: Tx, order: DbOrder, now: Date) {
    const viewerId = Number(order.viewerId);
    const ref = `order:${order.id}`;
    if (order.kind === 'COINS' && order.coins) {
      await this.addCoins(tx, viewerId, order.coins, 'PURCHASE', ref);
    } else if (order.kind === 'SERIES' && order.collectionId != null) {
      await tx.entitlement.upsert({
        where: {
          viewerId_collectionId_episode: {
            viewerId: order.viewerId!,
            collectionId: order.collectionId,
            episode: 0,
          },
        },
        create: {
          viewerId: order.viewerId!,
          collectionId: order.collectionId,
          episode: 0,
          source: 'PURCHASE',
          orderId: order.id,
          createdAt: this.time.toWall(now),
        },
        update: {},
      });
    } else if (order.kind === 'VIP' && order.months) {
      const wallet = await this.ensureWallet(tx, viewerId);
      const until = vipExtended(
        this.time.toInstant(wallet.vipUntil),
        now,
        order.months,
      );
      await tx.wallet.update({
        where: { viewerId: BigInt(viewerId) },
        data: {
          vipUntil: this.time.toWall(until),
          updatedAt: this.time.toWall(now),
        },
      });
    }
  }

  private async addCoins(
    tx: Tx,
    viewerId: number,
    delta: number,
    reason: string,
    ref: string,
  ) {
    await this.ensureWallet(tx, viewerId);
    await tx.wallet.update({
      where: { viewerId: BigInt(viewerId) },
      data: {
        coins: { increment: delta },
        updatedAt: this.time.toWall(new Date()),
      },
    });
    await tx.coinLedger.create({
      data: {
        viewerId: BigInt(viewerId),
        delta,
        reason,
        ref,
        createdAt: this.time.toWall(new Date()),
      },
    });
  }

  private async ensureWallet(tx: Tx, viewerId: number) {
    return tx.wallet.upsert({
      where: { viewerId: BigInt(viewerId) },
      create: {
        viewerId: BigInt(viewerId),
        coins: 0,
        updatedAt: this.time.toWall(new Date()),
      },
      update: {},
    });
  }

  private async lastCheckIn(viewerId: number) {
    const row = await this.prisma.checkIn.findFirst({
      where: { viewerId: BigInt(viewerId) },
      orderBy: { day: 'desc' },
    });
    return row
      ? { day: row.day.toISOString().slice(0, 10), streak: row.streak }
      : null;
  }

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

  private async views(rows: DbOrder[]): Promise<OrderView[]> {
    const ids = [
      ...new Set(
        rows.map((r) => r.collectionId).filter((x): x is bigint => x != null),
      ),
    ];
    const titles = new Map(
      (
        await this.prisma.collection.findMany({
          where: { id: { in: ids } },
          select: { id: true, title: true },
        })
      ).map((c) => [c.id, c.title]),
    );
    const now = new Date();
    return rows.map((r) => {
      const expiresAt = this.time.toInstant(r.expiresAt);
      return {
        id: Number(r.id),
        kind: r.kind as OrderKind,
        amountUsd: Number(r.amountUsd),
        coins: r.coins,
        seriesId: r.collectionId == null ? null : Number(r.collectionId),
        seriesTitle:
          r.collectionId == null ? null : (titles.get(r.collectionId) ?? null),
        months: r.months,
        status: r.status as OrderView['status'],
        billNumber: r.billNumber,
        khqr: r.status === 'PENDING' && expiresAt > now ? r.khqr : null,
        expiresAt: expiresAt.toISOString(),
        createdAt: this.time.toInstant(r.createdAt).toISOString(),
        paidAt: this.time.toInstant(r.paidAt)?.toISOString() ?? null,
        autoConfirm: this.khqr.autoConfirm,
      };
    });
  }
}
