/**
 * VideoLingo stores times as `timestamp without time zone` in its server's local time (Java
 * LocalDateTime.now()). Prisma reads such a column as if it were UTC, so a value comes back as a Date
 * whose UTC fields are the local wall-clock time. These convert between that and real instants.
 */
export class DbTime {
  constructor(private readonly zone: string) {}

  /** A value read from the database → the real moment it names */
  toInstant(wall: Date): Date;
  toInstant(wall: Date | null): Date | null;
  toInstant(wall: Date | null): Date | null {
    if (!wall) return null;
    const w = wall.getTime();
    // The offset depends on the instant, which is what we're solving for: guess, then correct once
    // (enough for daylight-saving changes; the hour skipped or repeated by one is ambiguous anyway).
    const guess = w - offsetMs(this.zone, wall);
    return new Date(w - offsetMs(this.zone, new Date(guess)));
  }

  /** A real moment → the value to write to the database */
  toWall(instant: Date): Date {
    return new Date(instant.getTime() + offsetMs(this.zone, instant));
  }
}

/** How far `zone`'s clock is ahead of UTC at `at`, in ms */
export function offsetMs(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - (at.getTime() - (((at.getTime() % 1000) + 1000) % 1000));
}
