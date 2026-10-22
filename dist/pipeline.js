import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { OUTPUT_DIR, resolveApiKey } from "./config.js";
import { createWorkspace } from "./util/workspace.js";
import { downloadVideo } from "./steps/download.js";
import { extractFrames } from "./steps/frames.js";
import { detectTabBox } from "./steps/detect.js";
import { cropFrames } from "./steps/crop.js";
import { dedupCrops } from "./steps/dedup.js";
import { dedupeByBar } from "./steps/classify.js";
import { buildPdf } from "./steps/pdf.js";
import { stitchScrolling } from "./steps/stitch.js";
import { log } from "./util/logger.js";
/** Turn a video title into a safe file name (no path separators / reserved chars). */
function sanitizeFilename(name) {
    return (name
        .replace(/[/\\?%*:|"<>]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120) || "tabs");
}
/**
 * Resolve a local video file: it is read in place (never copied or re-encoded,
 * so the original resolution is kept) and its file name becomes the title.
 */
function localVideo(input) {
    const videoPath = resolve(input);
    if (!existsSync(videoPath) || !statSync(videoPath).isFile()) {
        throw new Error(`Input video not found: ${videoPath}`);
    }
    log.success(`Using local video ${videoPath}`);
    return { videoPath, title: basename(videoPath, extname(videoPath)) };
}
/** Run the full video → PDF pipeline. Returns the absolute output path. */
export async function run(opts) {
    // Vision calls are only needed to detect the box and to read bar numbers.
    const needsApi = !opts.box || !opts.scroll;
    const apiKey = needsApi ? resolveApiKey() : "";
    const ws = createWorkspace(opts.keepTemp);
    try {
        let videoPath = ws.videoPath;
        let title;
        if (opts.input) {
            ({ videoPath, title } = localVideo(opts.input));
        }
        else {
            title = await downloadVideo(opts.url, ws.videoPath, opts.maxHeight);
        }
        title = opts.title ?? title;
        const frames = await extractFrames(videoPath, ws.framesDir, opts.interval, opts.start, opts.end);
        const box = opts.box ?? (await detectTabBox(apiKey, opts.model, frames, opts.sample));
        const crops = await cropFrames(frames, box, ws.cropsDir);
        const name = sanitizeFilename(title);
        const outPath = resolve(OUTPUT_DIR, `${name}.pdf`);
        mkdirSync(dirname(outPath), { recursive: true });
        let tabs;
        if (opts.scroll) {
            // A scrolling score keeps the same leftmost bar while new measures enter
            // on the right, so bar-number dedup would drop content. Instead, align the
            // overlapping crops and stitch each part of the score in exactly once.
            // Panorama, rows and flagged regions are kept next to the PDF.
            const times = frames.map((_, i) => (opts.start ?? 0) + i * opts.interval);
            tabs = await stitchScrolling(crops, times, resolve(OUTPUT_DIR, `${name}.parts`), opts.rowWidth);
        }
        else {
            // Cheap local pre-dedup drops near-identical consecutive frames to cut the
            // number of vision calls; the bar-number pass is the authoritative dedup.
            const distinctCrops = await dedupCrops(crops, opts.dedupThreshold);
            tabs = await dedupeByBar(apiKey, opts.model, distinctCrops);
        }
        await buildPdf(tabs, outPath, title);
        return outPath;
    }
    finally {
        ws.cleanup();
    }
}
//# sourceMappingURL=pipeline.js.map