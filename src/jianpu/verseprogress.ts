/** Optional congregational verse cues. Kept separate from the source notation and slide page numbers. */
export type VerseProgressMode = "off" | "auto" | "manual";

export interface VerseProgressOptions {
  mode: VerseProgressMode;
  /** One label per sung segment, separated by | or newlines. Empty entries hide a cue. */
  labels: string;
}

export interface VerseSegment {
  passIndex: number;
  start: number;
  verse: number;
}

/** Each new singing pass (or a verse change inside JP-Word's combined .Layout pass) begins a segment. */
export function verseSegments(passes: readonly { verses: readonly number[] }[]): VerseSegment[] {
  const segments: VerseSegment[] = [];
  passes.forEach((p, passIndex) => {
    let last = -1;
    p.verses.forEach((verse, start) => {
      if (start === 0 || verse !== last) segments.push({ passIndex, start, verse });
      last = verse;
    });
  });
  return segments;
}

/** Safe auto mode only when the play-order model says the tune is simple and the
 * segments are exactly consecutive numbered stanzas. No guesses on refrains / jumps. */
export function verseProgressLabels(
  segments: readonly VerseSegment[],
  simple: boolean,
  options: VerseProgressOptions | undefined,
): string[] {
  if (!options || options.mode === "off") return [];
  if (options.mode === "manual") {
    const labels = options.labels.split(/[|\r\n]/);
    return segments.map((_, i) => (labels[i] ?? "").trim().slice(0, 32));
  }
  if (!simple || segments.length < 2 || !segments.every((s, i) => s.verse === i + 1)) return [];
  return segments.map((s) => `${s.verse}/${segments.length}节`);
}
