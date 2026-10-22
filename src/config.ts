import type { Box } from "./steps/detect.js";

export interface Options {
  /** YouTube URL (downloaded with yt-dlp). Exactly one of `url` / `input`. */
  url?: string;
  /** Local video file; skips yt-dlp entirely. */
  input?: string;
  /** Override the PDF title / file name (default: video title or local file name). */
  title?: string;
  interval: number;
  model: string;
  sample: number;
  dedupThreshold: number;
  maxHeight: number;
  keepTemp: boolean;
  /** Manual tab region (0–1000 coords); skips vision detection. */
  box?: Box;
  /** Horizontally scrolling score: align and stitch crops instead of bar-number dedup. */
  scroll: boolean;
  /** Target row width in source pixels for --scroll (rows break at barlines). */
  rowWidth: number;
  /** Only process this time range of the video (seconds). */
  start?: number;
  end?: number;
}

export const DEFAULTS = {
  interval: 2,
  model: "claude-sonnet-5",
  sample: 6,
  dedupThreshold: 12,
  maxHeight: 720,
  keepTemp: false,
  scroll: false,
  rowWidth: 2000,
} as const;

// Output goes here with zero configuration; the file is named after the video.
export const OUTPUT_DIR = "out";

export function resolveApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Export it or put it in a .env file and run with `node --env-file=.env`. " +
        "(With --box and --scroll no API calls are made and no key is needed.)",
    );
  }
  return key;
}
