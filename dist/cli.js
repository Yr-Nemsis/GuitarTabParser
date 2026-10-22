#!/usr/bin/env node
import { Command } from "commander";
import { DEFAULTS, OUTPUT_DIR } from "./config.js";
import { run } from "./pipeline.js";
import { log } from "./util/logger.js";
function toInt(name) {
    return (value) => {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
            throw new Error(`--${name} must be a positive number (got "${value}")`);
        }
        return n;
    };
}
function toSeconds(name) {
    return (value) => {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
            throw new Error(`--${name} must be a non-negative number of seconds (got "${value}")`);
        }
        return n;
    };
}
function toBox(value) {
    const parts = value.split(",").map((v) => Number(v.trim()));
    const [x0, y0, x1, y1] = parts;
    if (parts.length !== 4 ||
        parts.some((n) => !Number.isFinite(n) || n < 0 || n > 1000) ||
        x1 <= x0 ||
        y1 <= y0) {
        throw new Error(`--box must be "x0,y0,x1,y1" in 0–1000 coordinates (got "${value}")`);
    }
    return { x0, y0, x1, y1 };
}
const program = new Command();
program
    .name("tab-parser")
    .description(`Turn a YouTube (or local) guitar-lesson video into a PDF of the guitar tab (written to ${OUTPUT_DIR}/<video-title>.pdf).`)
    .argument("[youtube-url]", "YouTube video URL (omit when using --input)")
    .option("--input <path>", "local video file (skips download; title comes from the file name)")
    .option("--title <text>", "override the PDF title / file name")
    .option("-i, --interval <seconds>", "screenshot interval in seconds", toInt("interval"), DEFAULTS.interval)
    .option("--model <id>", "Claude vision model", DEFAULTS.model)
    .option("--sample <n>", "frames sampled for tab-region detection", toInt("sample"), DEFAULTS.sample)
    .option("--dedup-threshold <n>", "pre-dedup Hamming distance (cost control)", toInt("dedup-threshold"), DEFAULTS.dedupThreshold)
    .option("--max-height <px>", "cap download resolution", toInt("max-height"), DEFAULTS.maxHeight)
    .option("--keep-temp", "keep intermediate frames/crops", DEFAULTS.keepTemp)
    .option("--box <x0,y0,x1,y1>", "tab region in 0–1000 coords (skips vision detection)", toBox)
    .option("--scroll", "score scrolls horizontally: stitch overlapping crops instead of bar-number dedup", DEFAULTS.scroll)
    .option("--row-width <px>", "target PDF row width in source pixels for --scroll", toInt("row-width"), DEFAULTS.rowWidth)
    .option("--start <seconds>", "only process the video from this time", toSeconds("start"))
    .option("--end <seconds>", "only process the video up to this time", toSeconds("end"))
    .action(async (url, raw) => {
    const input = raw.input;
    if (Boolean(url) === Boolean(input)) {
        program.error("Provide either a YouTube URL or --input <path>, not both.");
    }
    const opts = {
        url,
        input,
        title: raw.title,
        interval: raw.interval,
        model: raw.model,
        sample: raw.sample,
        dedupThreshold: raw.dedupThreshold,
        maxHeight: raw.maxHeight,
        keepTemp: Boolean(raw.keepTemp),
        box: raw.box,
        scroll: Boolean(raw.scroll),
        rowWidth: raw.rowWidth,
        start: raw.start,
        end: raw.end,
    };
    try {
        const out = await run(opts);
        console.log(out);
    }
    catch (err) {
        log.error(err.message);
        if (err.stack) {
            console.error(err.stack);
        }
        process.exitCode = 1;
    }
});
program.parseAsync(process.argv).catch((err) => {
    log.error(err.message);
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map