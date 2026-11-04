import { Logger } from '@nestjs/common';
import { BakongKHQR, IndividualInfo, khqrData } from 'bakong-khqr';
import type { PaymentsConfig } from '../config';

export interface BakongPayment {
  hash: string;
  amount: number;
  currency: string;
  toAccountId: string;
}

/**
 * KHQR codes (with the National Bank of Cambodia's SDK) and Bakong's check of whether one was paid.
 * Every Cambodian banking app can pay a KHQR. Bakong finds the payment by the code's md5.
 */
export class Khqr {
  private readonly log = new Logger('khqr');

  constructor(
    private readonly config: PaymentsConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get enabled() {
    return !!this.config.accountId;
  }

  /** Bakong can confirm payments by itself; otherwise an admin marks them paid */
  get autoConfirm() {
    return this.enabled && !!this.config.bakongToken;
  }

  /** A dynamic KHQR for exactly `amountUsd`, payable until `expiresAt` */
  make(amountUsd: number, bill: string, expiresAt: Date) {
    const info = new IndividualInfo(
      this.config.accountId,
      this.config.merchantName,
      this.config.merchantCity,
      {
        currency: khqrData.currency.usd,
        amount: amountUsd,
        billNumber: bill,
        expirationTimestamp: expiresAt.getTime(),
      },
    );
    const result = new BakongKHQR().generateIndividual(info);
    if (!result.data) {
      throw new Error(`KHQR not made: ${result.status.message ?? 'unknown'}`);
    }
    return result.data;
  }

  /** The payment for a KHQR, once Bakong has it; null while unpaid or when Bakong can't be asked */
  async paymentFor(md5: string): Promise<BakongPayment | null> {
    if (!this.autoConfirm) return null;
    try {
      const res = await this.fetchFn(
        `${this.config.bakongApiUrl}/v1/check_transaction_by_md5`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.bakongToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ md5 }),
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!res.ok) {
        this.log.warn(`Bakong answered ${res.status}`);
        return null;
      }
      const body = (await res.json()) as {
        responseCode?: number;
        data?: {
          hash?: string;
          amount?: number;
          currency?: string;
          toAccountId?: string;
        } | null;
      };
      // responseCode 0 with data: found; 1: not paid (yet)
      if (body.responseCode !== 0 || !body.data) return null;
      return {
        hash: String(body.data.hash ?? ''),
        amount: Number(body.data.amount),
        currency: String(body.data.currency ?? ''),
        toAccountId: String(body.data.toAccountId ?? ''),
      };
    } catch (err) {
      this.log.warn(`Bakong check failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** A payment counts only if it went to our account, in dollars, for at least the order's amount */
  accepts(payment: BakongPayment, amountUsd: number) {
    return (
      payment.toAccountId === this.config.accountId &&
      payment.currency.toUpperCase() === 'USD' &&
      payment.amount + 0.001 >= amountUsd
    );
  }
}
