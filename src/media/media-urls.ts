/**
 * Links to VideoLingo's stored files (videos, thumbnails, artwork) as browsers get them; ported from
 * VideoLingo's MediaUrls so both hand out the same kind of link. The database keeps the plain bucket
 * address (publicEndpoint/bucket/key); responses get a signed link that expires after the TTL, so the
 * bucket can stay private. A signed link is reused for a third of its lifetime, so the same file keeps
 * the same address for a while and any link handed out stays good for at least two thirds of the TTL.
 * Links to anything else pass through unchanged, and so does everything when signing is off.
 */
export interface MediaUrlsOptions {
  publicEndpoint: string;
  bucket: string;
  enabled: boolean;
  ttlSeconds: number;
  presign: (key: string, ttlSeconds: number) => Promise<string>;
  now?: () => number;
}

const CACHE_SIZE = 20_000;

export class MediaUrls {
  private readonly prefix: string | null;
  private readonly enabled: boolean;
  // Insertion order doubles as age order: the oldest entry is dropped when full
  private readonly cache = new Map<
    string,
    { url: string; reuseUntil: number }
  >();
  private readonly now: () => number;

  constructor(private readonly options: MediaUrlsOptions) {
    const configured = !!options.publicEndpoint && !!options.bucket;
    this.prefix = configured
      ? `${options.publicEndpoint.replace(/\/+$/, '')}/${options.bucket}/`
      : null;
    this.enabled = options.enabled && configured;
    this.now = options.now ?? Date.now;
  }

  /** The object key when `url` (signed or not) is one of our stored files; null otherwise */
  keyOf(url: string | null | undefined): string | null {
    if (!this.prefix || !url) return null;
    const bare = url.split('?')[0];
    if (!bare.startsWith(this.prefix) || bare.length === this.prefix.length) {
      return null;
    }
    try {
      // Keys are stored as written; only %XX is decoded (a literal '+' stays a '+')
      return decodeURIComponent(bare.slice(this.prefix.length));
    } catch {
      return null;
    }
  }

  /** What the browser gets: a signed link for one of our files, anything else unchanged */
  async forBrowser(url: string | null | undefined): Promise<string | null> {
    if (url == null) return null;
    const key = this.keyOf(url);
    if (!this.enabled || key == null) return url;
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && now < hit.reuseUntil) return hit.url;
    const signed = await this.options.presign(key, this.options.ttlSeconds);
    this.cache.delete(key);
    this.cache.set(key, {
      url: signed,
      reuseUntil: now + (this.options.ttlSeconds * 1000) / 3,
    });
    if (this.cache.size > CACHE_SIZE) {
      const [oldest] = this.cache.keys();
      this.cache.delete(oldest);
    }
    return signed;
  }
}
