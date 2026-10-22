export const DEFAULTS = {
    interval: 2,
    model: "claude-sonnet-5",
    sample: 6,
    dedupThreshold: 12,
    maxHeight: 720,
    keepTemp: false,
    scroll: false,
    rowWidth: 2000,
};
// Output goes here with zero configuration; the file is named after the video.
export const OUTPUT_DIR = "out";
export function resolveApiKey() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
        throw new Error("ANTHROPIC_API_KEY is not set. Export it or put it in a .env file and run with `node --env-file=.env`. " +
            "(With --box and --scroll no API calls are made and no key is needed.)");
    }
    return key;
}
//# sourceMappingURL=config.js.map