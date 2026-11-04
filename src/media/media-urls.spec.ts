import { MediaUrls } from './media-urls';

const make = (enabled = true, clock = { t: 0 }) => {
  const presign = jest.fn((key: string, ttl: number) =>
    Promise.resolve(
      `https://s3.example/bucket/${key}?sig=${clock.t}&ttl=${ttl}`,
    ),
  );
  const urls = new MediaUrls({
    publicEndpoint: 'https://s3.example/',
    bucket: 'bucket',
    enabled,
    ttlSeconds: 180 * 60,
    presign,
    now: () => clock.t,
  });
  return { urls, presign, clock };
};

describe('MediaUrls', () => {
  it('signs our files and passes other links through', async () => {
    const { urls } = make();
    expect(
      await urls.forBrowser('https://s3.example/bucket/videos/a.mp4'),
    ).toBe('https://s3.example/bucket/videos/a.mp4?sig=0&ttl=10800');
    expect(await urls.forBrowser('https://youtube.com/watch?v=x')).toBe(
      'https://youtube.com/watch?v=x',
    );
    expect(await urls.forBrowser(null)).toBeNull();
  });

  it('decodes %XX but keeps a literal +', () => {
    const { urls } = make();
    expect(urls.keyOf('https://s3.example/bucket/a%20b+c.mp4?x=1')).toBe(
      'a b+c.mp4',
    );
    expect(urls.keyOf('https://s3.example/bucket/')).toBeNull();
  });

  it('reuses a signed link for a third of its lifetime', async () => {
    const { urls, presign, clock } = make();
    const url = 'https://s3.example/bucket/v.mp4';
    const first = await urls.forBrowser(url);
    clock.t = 59 * 60_000;
    expect(await urls.forBrowser(url)).toBe(first);
    clock.t = 61 * 60_000;
    expect(await urls.forBrowser(url)).not.toBe(first);
    expect(presign).toHaveBeenCalledTimes(2);
  });

  it('passes everything through when signing is off', async () => {
    const { urls, presign } = make(false);
    const url = 'https://s3.example/bucket/v.mp4';
    expect(await urls.forBrowser(url)).toBe(url);
    expect(presign).not.toHaveBeenCalled();
  });
});
