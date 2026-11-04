import { BakongKHQR } from 'bakong-khqr';
import { Khqr } from './khqr';

const config = {
  accountId: 'ruengflix@aclb',
  merchantName: 'RuengFlix',
  merchantCity: 'Phnom Penh',
  bakongToken: 'token',
  bakongApiUrl: 'https://bakong.test',
  qrMinutes: 15,
};

describe('Khqr', () => {
  it('makes a valid dynamic KHQR for the amount', () => {
    const k = new Khqr(config);
    const { qr, md5 } = k.make(2.49, 'RF-ABC-1234', new Date(Date.now() + 9e5));
    expect(BakongKHQR.verify(qr).isValid).toBe(true);
    expect(qr).toContain('ruengflix@aclb');
    expect(qr).toContain('54042.49');
    expect(qr).toContain('RF-ABC-1234');
    expect(md5).toMatch(/^[0-9a-f]{32}$/);
  });

  it('finds a payment through Bakong', async () => {
    const fetchFn = jest
      .fn<Promise<unknown>, [string, RequestInit]>()
      .mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            responseCode: 0,
            data: {
              hash: 'h1',
              amount: 2.49,
              currency: 'USD',
              toAccountId: 'ruengflix@aclb',
            },
          }),
      });
    const k = new Khqr(config, fetchFn as unknown as typeof fetch);
    const p = (await k.paymentFor('abc'))!;
    expect(p.hash).toBe('h1');
    expect(k.accepts(p, 2.49)).toBe(true);
    expect(k.accepts({ ...p, amount: 2.4 }, 2.49)).toBe(false);
    expect(k.accepts({ ...p, toAccountId: 'other@aba' }, 2.49)).toBe(false);
    expect(k.accepts({ ...p, currency: 'KHR' }, 2.49)).toBe(false);
    expect(fetchFn.mock.calls[0][0]).toBe(
      'https://bakong.test/v1/check_transaction_by_md5',
    );
  });

  it('treats "not found" and errors as unpaid', async () => {
    const notFound = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ responseCode: 1, data: null }),
    });
    expect(
      await new Khqr(config, notFound as unknown as typeof fetch).paymentFor(
        'x',
      ),
    ).toBeNull();
    const down = jest.fn().mockRejectedValue(new Error('down'));
    expect(
      await new Khqr(config, down as unknown as typeof fetch).paymentFor('x'),
    ).toBeNull();
  });

  it('is off without an account, manual without a token', () => {
    expect(new Khqr({ ...config, accountId: '' }).enabled).toBe(false);
    const manual = new Khqr({ ...config, bakongToken: '' });
    expect(manual.enabled && !manual.autoConfirm).toBe(true);
  });
});
