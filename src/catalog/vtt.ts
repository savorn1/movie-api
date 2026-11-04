export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

/** WebVTT, written the way VideoLingo writes it (SubtitleFiles.toVtt) */
export function toVtt(cues: Cue[]): string {
  let out = 'WEBVTT\n\n';
  for (const c of cues) {
    // "-->" can't appear in cue text; & and < must be escaped
    const text = c.text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/-->/g, '--&gt;');
    out += `${timestamp(c.startMs)} --> ${timestamp(c.endMs)}\n${text}\n\n`;
  }
  return out;
}

export function timestamp(ms: number): string {
  const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');
  return `${pad(ms / 3_600_000)}:${pad((ms % 3_600_000) / 60_000)}:${pad((ms % 60_000) / 1000)}.${pad(ms % 1000, 3)}`;
}
