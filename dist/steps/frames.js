import { execa } from "execa";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../util/logger.js";
/**
 * Extract one frame every `interval` seconds from `videoPath` into `framesDir`,
 * optionally limited to the [`start`, `end`) time range (seconds). Frames keep
 * the source resolution. Returns the sorted list of absolute frame paths
 * (chronological order); frame i was taken at roughly `start + i * interval`.
 */
export async function extractFrames(videoPath, framesDir, interval, start, end) {
    await assertBinary("ffmpeg");
    log.step(`Extracting a frame every ${interval}s…`);
    const range = [];
    if (start !== undefined)
        range.push("-ss", String(start));
    if (end !== undefined)
        range.push("-t", String(end - (start ?? 0)));
    const pattern = join(framesDir, "frame-%05d.png");
    await execa("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        ...range,
        "-i",
        videoPath,
        "-vf",
        `fps=1/${interval}`,
        pattern,
    ], { stdout: "ignore", stderr: "inherit" });
    const files = (await readdir(framesDir))
        .filter((f) => f.startsWith("frame-") && f.endsWith(".png"))
        .sort()
        .map((f) => join(framesDir, f));
    if (files.length === 0) {
        throw new Error("ffmpeg produced no frames — is the video valid?");
    }
    log.success(`Extracted ${files.length} frames`);
    return files;
}
async function assertBinary(name) {
    try {
        await execa(name, ["-version"]);
    }
    catch {
        throw new Error(`Required binary "${name}" was not found on PATH. Please install it (e.g. \`brew install ${name}\`).`);
    }
}
//# sourceMappingURL=frames.js.map