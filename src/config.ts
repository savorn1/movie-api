/** Settings from the environment (a .env file in the working directory is loaded by main.ts). */
export interface AppConfig {
  port: number;
  databaseUrl: string;
  /** Shared secret RuengFlix's server sends as `Authorization: Bearer <token>` */
  token: string;
  /** Time zone of VideoLingo's `timestamp` columns (its server's zone) */
  dbTimeZone: string;
  media: MediaConfig;
  payments: PaymentsConfig;
}

/** KHQR payments. Off until KHQR_ACCOUNT_ID is set; confirmed automatically only with BAKONG_TOKEN. */
export interface PaymentsConfig {
  /** Bakong account that receives payments, e.g. "ruengflix@aclb" */
  accountId: string;
  merchantName: string;
  merchantCity: string;
  /** Bakong Open API token (api-bakong.nbc.gov.kh); empty = an admin marks orders paid */
  bakongToken: string;
  bakongApiUrl: string;
  /** How long a KHQR can be paid */
  qrMinutes: number;
}

export interface MediaConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
  publicEndpoint: string;
  signedUrls: boolean;
  ttlMinutes: number;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

const MIN_TOKEN_LENGTH = 24;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL ?? '';
  const token = env.MOVIE_API_TOKEN ?? '';
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `MOVIE_API_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`,
    );
  }
  const dbTimeZone =
    env.DB_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Throws RangeError for an unknown zone, so a typo fails at startup
  new Intl.DateTimeFormat('en-US', { timeZone: dbTimeZone });

  // Same variable names and defaults as VideoLingo, so one set of S3 settings serves both
  const endpoint = env.S3_ENDPOINT ?? '';
  return {
    port: Number(env.PORT) || 3020,
    databaseUrl,
    token,
    dbTimeZone,
    media: {
      region: env.AWS_REGION || 'us-east-1',
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
      bucket: env.S3_BUCKET ?? '',
      endpoint,
      publicEndpoint: env.S3_PUBLIC_ENDPOINT || endpoint,
      signedUrls: env.MEDIA_SIGNED_URLS !== 'false',
      ttlMinutes: Math.max(5, Number(env.MEDIA_URL_TTL_MINUTES) || 180),
    },
    payments: {
      accountId: env.KHQR_ACCOUNT_ID ?? '',
      merchantName: env.KHQR_MERCHANT_NAME || 'RuengFlix',
      merchantCity: env.KHQR_MERCHANT_CITY || 'Phnom Penh',
      bakongToken: env.BAKONG_TOKEN ?? '',
      bakongApiUrl: (
        env.BAKONG_API_URL || 'https://api-bakong.nbc.gov.kh'
      ).replace(/\/+$/, ''),
      qrMinutes: Math.min(60, Math.max(3, Number(env.KHQR_MINUTES) || 15)),
    },
  };
}
