// The National Bank of Cambodia's KHQR SDK ships without types; only what movie-api uses.
declare module 'bakong-khqr' {
  export const khqrData: { currency: { usd: number; khr: number } };
  export class IndividualInfo {
    constructor(
      bakongAccountID: string,
      merchantName: string,
      merchantCity: string,
      optional?: Record<string, unknown>,
    );
  }
  export class BakongKHQR {
    generateIndividual(info: IndividualInfo): {
      status: {
        code: number;
        errorCode: number | null;
        message: string | null;
      };
      data: { qr: string; md5: string } | null;
    };
    static verify(qr: string): { isValid: boolean };
  }
}
