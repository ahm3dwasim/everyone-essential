/**
 * Voice input: match what was said to one of the options on screen.
 *
 * The matching is plain and local -- the option list is short (four at most)
 * and known exactly, so there is no reason to send audio anywhere or to guess.
 * A transcript that matches nothing, or matches two things equally well, is
 * refused rather than resolved by a coin toss; the on-screen buttons are always
 * there as the required fallback.
 *
 * The recogniser itself is behind `SpeechLike` so it can be stubbed in tests
 * and in the headless smoke run, where the Web Speech API does not exist.
 */

export interface SpeechAlternative {
  transcript: string;
}
export interface SpeechEvent {
  resultIndex: number;
  /** `results[i][j].transcript` — the shape the Web Speech API reports. */
  results: ArrayLike<ArrayLike<SpeechAlternative>>;
}
export interface SpeechLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

export function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Which option was named. Exact phrase wins; otherwise the option that shares
 * the most words with what was said, provided it is clearly ahead of the next
 * best. Null means "say it again", never "pick one at random".
 */
export function matchOption(transcript: string, options: readonly string[]): number | null {
  const said = normalizePhrase(transcript);
  if (said.length === 0 || options.length === 0) return null;

  const normalized = options.map(normalizePhrase);
  const exact = normalized.findIndex((option) => option === said);
  if (exact >= 0) return exact;

  const saidWords = new Set(said.split(" "));
  const scores = normalized.map((option) => {
    const words = option.split(" ").filter((word) => word.length > 1);
    if (words.length === 0) return 0;
    let hits = 0;
    for (const word of words) if (saidWords.has(word)) hits += 1;
    return hits / words.length;
  });

  let best = -1;
  let bestScore = 0;
  let runnerUp = 0;
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i] ?? 0;
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = i;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  if (best < 0) return null;
  if (bestScore < 0.5) return null;
  if (bestScore - runnerUp < 0.25) return null;
  return best;
}

/** The browser's recogniser, or null when this browser has none. */
export function speechRecognition(): SpeechLike | null {
  const scope = globalThis as unknown as {
    SpeechRecognition?: new () => SpeechLike;
    webkitSpeechRecognition?: new () => SpeechLike;
  };
  const Ctor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  if (!Ctor) return null;
  return new Ctor();
}

export interface VoiceListener {
  stop(): void;
  readonly supported: boolean;
}

/**
 * Listen for one utterance at a time, restarting after each, and report the
 * transcript. Recognition is never required: if the browser has no recogniser
 * the buttons are the whole interface, and `supported` says so on screen.
 */
export function listen(
  onTranscript: (transcript: string) => void,
  onProblem: (message: string) => void,
): VoiceListener {
  const recogniser = speechRecognition();
  if (!recogniser) {
    return { stop: () => {}, supported: false };
  }
  let stopped = false;
  recogniser.lang = "en-US";
  recogniser.continuous = false;
  recogniser.interimResults = false;
  recogniser.maxAlternatives = 1;
  recogniser.onresult = (event) => {
    const result = event.results[event.resultIndex] ?? event.results[0];
    const alternative = result?.[0];
    if (alternative) onTranscript(alternative.transcript);
  };
  recogniser.onerror = (event) => {
    if (event.error !== "no-speech" && event.error !== "aborted") {
      onProblem(`speech recognition: ${event.error}`);
    }
  };
  recogniser.onend = () => {
    if (stopped) return;
    try {
      recogniser.start();
    } catch {
      // Already started; the browsers disagree about when this throws.
    }
  };
  try {
    recogniser.start();
  } catch (error) {
    onProblem(`speech recognition could not start: ${String(error)}`);
  }
  return {
    supported: true,
    stop: () => {
      stopped = true;
      try {
        recogniser.abort();
      } catch {
        // nothing to do
      }
    },
  };
}
