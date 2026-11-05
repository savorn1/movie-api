/**
 * RuengFlix's home page rows, edited in videolingo-web under RuengFlix › Home rows (VideoLingo's
 * streaming_home_rows). Sent with the prices; RuengFlix fills each row from its catalog, and shows its
 * built-in rows when the list is empty.
 */
export type HomeRowSource = 'latest' | 'popular' | 'category' | 'genre';

export interface HomeRow {
  title: string;
  source: HomeRowSource;
  /** A category key ('cultivation', 'romance', 'fantasy') or a genre's name; null for latest and popular */
  value: string | null;
  /** How many series the row shows at most */
  max: number;
}

const SOURCES: Record<string, HomeRowSource> = {
  LATEST: 'latest',
  POPULAR: 'popular',
  CATEGORY: 'category',
  GENRE: 'genre',
};
const CATEGORIES = new Set(['cultivation', 'romance', 'fantasy']);

/** The stored rows (already active and in order) as RuengFlix reads them; ones it couldn't show are left out. */
export function homeRowsFrom(
  rows: {
    title: string;
    source: string;
    value: string | null;
    maxItems: number;
  }[],
): HomeRow[] {
  const out: HomeRow[] = [];
  for (const r of rows) {
    const source = SOURCES[r.source];
    const title = r.title?.trim();
    if (!source || !title) continue;
    let value: string | null = null;
    if (source === 'category') {
      value = (r.value ?? '').trim().toLowerCase();
      if (!CATEGORIES.has(value)) continue;
    } else if (source === 'genre') {
      value = (r.value ?? '').trim();
      if (!value) continue;
    }
    out.push({
      title,
      source,
      value,
      max: Math.min(30, Math.max(4, r.maxItems || 12)),
    });
  }
  return out;
}
