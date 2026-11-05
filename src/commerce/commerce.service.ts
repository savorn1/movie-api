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
import { coinsToTakeBack, vipShortened } from '../growth/rules';
import { coinPromotion, promoCoins, randomCode } from '../marketing/rules';
import {
  billNumber,
  checkInReward,
  dayIn,
  nextStreak,
  previousDay,
  quote,
  topUpBonus,
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
  /** Extra coins (percent) on this viewer's first coin pack; 0 once they've paid for anything */
  firstTopUpBonusPercent: number;
  /** A running "extra coins" promotion (applies to every pack until it ends) */
  coinPromo: { percent: number; title: string; endsAt: string } | null;
  /** Episodes this viewer may still unlock today by watching an ad (0 when ads are off or none run) */
  adUnlocksLeft: number;
  adUnlocksPerDay: number;
}

export interface OrderView {
  id: number;
  kind: OrderKind;
  amountUsd: number;
  coins: number | null;
  seriesId: number | null;
  seriesTitle: string | null;
  months: number | null;
  /** First top-up bonus added on top of the pack, once paid */
  bonusCoins: number | null;
  /** Extra coins from a running promotion, once paid */
  promoCoins: number | null;
  /** Bought as a gift: its code once paid (null before) */
  gift: boolean;
  giftCode: string | null;
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';
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
    const [wallet, prices, last, paidBefore, promos, adsToday, activeAds] =
      await Promise.all([
        this.prisma.wallet.findUnique({
          where: { viewerId: BigInt(viewerId) },
        }),
        this.prices(),
        this.lastCheckIn(viewerId),
        // Refunded orders count too: a refund must not bring the first-purchase bonus back
        this.prisma.order.count({
          where: {
            viewerId: BigInt(viewerId),
            status: { in: ['PAID', 'REFUNDED'] },
          },
        }),
        this.catalog.promotions(),
        this.prisma.adView.count({
          where: {
            viewerId: BigInt(viewerId),
            day: new Date(`${this.today()}T00:00:00Z`),
            completedAt: { not: null },
          },
        }),
        this.prisma.ad.count({ where: { active: true } }),
      ]);
    const today = this.today();
    const promo = coinPromotion(promos, new Date());
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
      firstTopUpBonusPercent:
        paidBefore === 0 ? prices.firstTopUpBonusPercent : 0,
      coinPromo: promo
        ? {
            percent: promo.bonusPercent ?? 0,
            title: promo.title,
            endsAt: promo.endsAt.toISOString(),
          }
        : null,
      adUnlocksPerDay: activeAds ? prices.adUnlocksPerDay : 0,
      adUnlocksLeft: activeAds
        ? Math.max(0, prices.adUnlocksPerDay - adsToday)
        : 0,
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
      /** For someone else: coins or VIP only */
      gift?: boolean;
      giftMessage?: string;
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
    if (req.gift && q.kind === 'SERIES') {
      throw new BadRequestException({
        code: 'NO_PRODUCT',
        message: 'Coins and VIP can be gifts; a series can not',
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
        gift: !!req.gift,
        note:
          req.gift && req.giftMessage?.trim()
            ? `gift: ${req.giftMessage.trim()}`.slice(0, 300)
            : null,
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
    const prices = await this.prices();
    const promo = coinPromotion(await this.catalog.promotions(), now);
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
        return order.gift
          ? this.makeGift(tx, order, now, promo?.bonusPercent ?? 0)
          : this.fulfil(tx, order, now, prices, promo?.bonusPercent ?? 0);
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

  // ---------- late payment notices ----------

  /**
   * Orders paid since the viewer last looked (they closed the KHQR screen and paid later): first asks
   * Bakong about their recent pending orders, then lists paid ones not yet acknowledged (last 7 days).
   */
  async paidNews(viewerId: number): Promise<OrderView[]> {
    await this.requireViewer(viewerId);
    const now = new Date();
    if (this.khqr.autoConfirm) {
      const pending = await this.prisma.order.findMany({
        where: {
          viewerId: BigInt(viewerId),
          status: 'PENDING',
          createdAt: {
            gte: this.time.toWall(new Date(now.getTime() - 2 * 3600_000)),
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      for (const o of pending) {
        await this.order(viewerId, Number(o.id)).catch(() => null);
      }
    }
    const rows = await this.prisma.order.findMany({
      where: {
        viewerId: BigInt(viewerId),
        status: 'PAID',
        seenAt: null,
        paidAt: {
          gte: this.time.toWall(new Date(now.getTime() - 7 * 86_400_000)),
        },
      },
      orderBy: { paidAt: 'desc' },
      take: 5,
    });
    return this.views(rows);
  }

  /** The viewer saw that this order went through (on the KHQR screen or in the notice) */
  async markSeen(viewerId: number, orderId: number) {
    await this.prisma.order.updateMany({
      where: { id: BigInt(orderId), viewerId: BigInt(viewerId), seenAt: null },
      data: { seenAt: this.time.toWall(new Date()) },
    });
  }

  // ---------- admin support ----------

  /**
   * Refund a paid order: marks it REFUNDED and takes back what it delivered, once. Coins (with any
   * bonus) come back only as far as the wallet still has them; a series unlock is removed; VIP time
   * is shortened. The money itself is returned outside RuengFlix (bank transfer).
   */
  async refund(orderId: number, by: string, reason: string) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const moved = await tx.order.updateMany({
        where: { id: BigInt(orderId), status: 'PAID' },
        data: {
          status: 'REFUNDED',
          refundedAt: this.time.toWall(now),
          refundedBy: by.slice(0, 100),
          refundReason: reason.slice(0, 300),
        },
      });
      const order = await tx.order.findUnique({
        where: { id: BigInt(orderId) },
      });
      if (!order) throw new NotFoundException('Order not found');
      if (moved.count === 0) {
        throw new ConflictException({
          code: 'NOT_PAID',
          message:
            order.status === 'REFUNDED'
              ? 'Already refunded'
              : 'Only paid orders can be refunded',
        });
      }
      let coinsTaken = 0;
      if (order.gift) {
        // A gift nobody has redeemed is cancelled; a redeemed one can't be taken back from the friend
        const voided = await tx.gift.updateMany({
          where: { orderId: order.id, redeemedAt: null, voidedAt: null },
          data: { voidedAt: this.time.toWall(now) },
        });
        if (voided.count === 0) {
          throw new ConflictException({
            code: 'GIFT_REDEEMED',
            message: 'The gift was already redeemed: it can not be refunded',
          });
        }
      } else if (order.viewerId != null) {
        const viewerId = Number(order.viewerId);
        if (order.kind === 'COINS') {
          const wallet = await this.ensureWallet(tx, viewerId);
          await tx.$queryRaw`select 1 from streaming_wallets where viewer_id = ${order.viewerId} for update`;
          const fresh = await tx.wallet.findUnique({
            where: { viewerId: order.viewerId },
          });
          coinsTaken = coinsToTakeBack(
            (order.coins ?? 0) +
              (order.bonusCoins ?? 0) +
              (order.promoCoins ?? 0),
            fresh?.coins ?? wallet.coins,
          );
          if (coinsTaken > 0) {
            await this.addCoins(
              tx,
              viewerId,
              -coinsTaken,
              'REFUND',
              `order:${order.id}`,
            );
          }
        } else if (order.kind === 'SERIES') {
          await tx.entitlement.deleteMany({
            where: { viewerId: order.viewerId, orderId: order.id },
          });
        } else if (order.kind === 'VIP' && order.months) {
          const wallet = await this.ensureWallet(tx, viewerId);
          const until = vipShortened(
            this.time.toInstant(wallet.vipUntil),
            now,
            order.months,
          );
          await tx.wallet.update({
            where: { viewerId: order.viewerId },
            data: {
              vipUntil: until ? this.time.toWall(until) : null,
              updatedAt: this.time.toWall(now),
            },
          });
        }
      }
      this.log.log(`Order ${orderId} refunded by ${by}: ${reason}`);
      return { id: Number(order.id), status: order.status, coinsTaken };
    });
  }

  /**
   * An admin gives coins (or takes them back, with a negative amount, never below 0) for a support
   * case. The ledger keeps who and why.
   */
  async grantCoins(
    viewerId: number,
    coins: number,
    by: string,
    reason: string,
  ) {
    await this.requireViewer(viewerId);
    if (!Number.isInteger(coins) || coins === 0 || Math.abs(coins) > 10_000) {
      throw new BadRequestException({
        code: 'BAD_AMOUNT',
        message: 'From -10,000 to 10,000 coins, not 0',
      });
    }
    const ref = `${by}: ${reason}`.slice(0, 100);
    let applied = coins;
    await this.prisma.$transaction(async (tx) => {
      const wallet = await this.ensureWallet(tx, viewerId);
      if (coins < 0) {
        await tx.$queryRaw`select 1 from streaming_wallets where viewer_id = ${BigInt(viewerId)} for update`;
        const fresh = await tx.wallet.findUnique({
          where: { viewerId: BigInt(viewerId) },
        });
        applied = -coinsToTakeBack(-coins, fresh?.coins ?? wallet.coins);
        if (applied === 0) return;
      }
      await this.addCoins(tx, viewerId, applied, 'ADMIN', ref);
    });
    this.log.log(`Viewer ${viewerId}: ${applied} coins by ${by} (${reason})`);
    return { applied, wallet: await this.wallet(viewerId) };
  }

  /** Coins added inside another transaction (missions, invites); see addCoins */
  credit(tx: Tx, viewerId: number, delta: number, reason: string, ref: string) {
    return this.addCoins(tx, viewerId, delta, reason, ref);
  }

  // ---------- helpers ----------

  /** Deliver a just-paid order; returns it as stored afterwards */
  private async fulfil(
    tx: Tx,
    order: DbOrder,
    now: Date,
    prices: Prices,
    promoPercent: number,
  ): Promise<DbOrder> {
    const viewerId = Number(order.viewerId);
    const ref = `order:${order.id}`;
    if (order.kind === 'COINS' && order.coins) {
      const packCoins = order.coins;
      await this.addCoins(tx, viewerId, packCoins, 'PURCHASE', ref);
      // A running "extra coins" promotion, on top of any first top-up bonus
      const extra = promoCoins(packCoins, promoPercent);
      if (extra > 0) {
        await this.addCoins(tx, viewerId, extra, 'PROMO', ref);
        order = await tx.order.update({
          where: { id: order.id },
          data: { promoCoins: extra },
        });
      }
      // First paid order of this viewer: bonus coins. The wallet row is locked first, so two orders
      // paid at the same moment take turns and only the first one counts as "first".
      await tx.$queryRaw`select 1 from streaming_wallets where viewer_id = ${order.viewerId} for update`;
      const paidBefore = await tx.order.count({
        where: {
          viewerId: order.viewerId,
          status: { in: ['PAID', 'REFUNDED'] },
          id: { not: order.id },
        },
      });
      const bonus =
        paidBefore === 0
          ? topUpBonus(packCoins, prices.firstTopUpBonusPercent)
          : 0;
      if (bonus > 0) {
        await this.addCoins(tx, viewerId, bonus, 'BONUS', ref);
        return tx.order.update({
          where: { id: order.id },
          data: { bonusCoins: bonus },
        });
      }
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
    return order;
  }

  /**
   * A paid gift order: a code for the buyer to send, instead of coins or VIP for them. A coin gift
   * carries the promotion running when it was paid. Codes are retried on the (rare) clash.
   */
  private async makeGift(
    tx: Tx,
    order: DbOrder,
    now: Date,
    promoPercent: number,
  ): Promise<DbOrder> {
    const coins =
      order.kind === 'COINS' && order.coins
        ? order.coins + promoCoins(order.coins, promoPercent)
        : null;
    const message = order.note?.startsWith('gift: ')
      ? order.note.slice(6).slice(0, 140)
      : null;
    for (let attempt = 0; ; attempt++) {
      const code = randomCode(10);
      const clash = await tx.gift.findUnique({ where: { code } });
      if (clash && attempt < 5) continue;
      await tx.gift.create({
        data: {
          code,
          orderId: order.id,
          giverId: order.viewerId,
          kind: order.kind === 'VIP' ? 'VIP' : 'COINS',
          coins,
          months: order.kind === 'VIP' ? order.months : null,
          message,
          createdAt: this.time.toWall(now),
        },
      });
      break;
    }
    return order;
  }

  /**
   * Redeem a gift code: its coins or VIP time go to this viewer, once (the conditional update decides
   * who wins when two people try the same code). The giver can't redeem their own gift.
   */
  async redeemGift(viewerId: number, code: string) {
    await this.requireViewer(viewerId);
    const now = new Date();
    const gift = await this.prisma.gift.findUnique({ where: { code } });
    if (!gift || gift.voidedAt) {
      throw new NotFoundException({ code: 'NO_GIFT', message: 'No such gift' });
    }
    if (gift.giverId != null && Number(gift.giverId) === viewerId) {
      throw new ConflictException({
        code: 'OWN_GIFT',
        message: 'Send this gift to a friend: it is yours',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      const taken = await tx.gift.updateMany({
        where: { id: gift.id, redeemedAt: null, voidedAt: null },
        data: {
          redeemedBy: BigInt(viewerId),
          redeemedAt: this.time.toWall(now),
        },
      });
      if (taken.count === 0) {
        throw new ConflictException({
          code: 'GIFT_TAKEN',
          message: 'This gift was already redeemed',
        });
      }
      const ref = `gift:${gift.code}`;
      if (gift.kind === 'COINS' && gift.coins) {
        await this.addCoins(tx, viewerId, gift.coins, 'GIFT', ref);
      } else if (gift.kind === 'VIP' && gift.months) {
        const wallet = await this.ensureWallet(tx, viewerId);
        const until = vipExtended(
          this.time.toInstant(wallet.vipUntil),
          now,
          gift.months,
        );
        await tx.wallet.update({
          where: { viewerId: BigInt(viewerId) },
          data: {
            vipUntil: this.time.toWall(until),
            updatedAt: this.time.toWall(now),
          },
        });
      }
    });
    this.log.log(`Gift ${gift.code} redeemed by viewer ${viewerId}`);
    return {
      kind: gift.kind,
      coins: gift.coins,
      months: gift.months,
      wallet: await this.wallet(viewerId),
    };
  }

  /** A gift as anyone with the link sees it (who sent it, what's inside, whether it's still there) */
  async giftInfo(code: string) {
    const gift = await this.prisma.gift.findUnique({ where: { code } });
    if (!gift || gift.voidedAt) {
      throw new NotFoundException({ code: 'NO_GIFT', message: 'No such gift' });
    }
    const giver = gift.giverId
      ? await this.prisma.viewer.findUnique({
          where: { id: gift.giverId },
          select: { displayName: true },
        })
      : null;
    return {
      code: gift.code,
      kind: gift.kind as 'COINS' | 'VIP',
      coins: gift.coins,
      months: gift.months,
      message: gift.message,
      from: giver?.displayName ?? null,
      giverId: gift.giverId == null ? null : Number(gift.giverId),
      redeemed: gift.redeemedAt != null,
      createdAt: this.time.toInstant(gift.createdAt).toISOString(),
    };
  }

  /** The gifts a viewer bought, newest first, with whether each was redeemed */
  async myGifts(viewerId: number) {
    await this.requireViewer(viewerId);
    const rows = await this.prisma.gift.findMany({
      where: { giverId: BigInt(viewerId), voidedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    return rows.map((g) => ({
      code: g.code,
      kind: g.kind,
      coins: g.coins,
      months: g.months,
      message: g.message,
      redeemed: g.redeemedAt != null,
      createdAt: this.time.toInstant(g.createdAt).toISOString(),
    }));
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
    const gifts = new Map(
      (
        await this.prisma.gift.findMany({
          where: {
            orderId: { in: rows.filter((r) => r.gift).map((r) => r.id) },
          },
          select: { orderId: true, code: true },
        })
      ).map((g) => [g.orderId, g.code]),
    );
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
        bonusCoins: r.bonusCoins,
        promoCoins: r.promoCoins,
        gift: r.gift,
        giftCode: gifts.get(r.id) ?? null,
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
