import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { log } from "../util/logger.js";
/**
 * Stitching for horizontally scrolling scores (white notation overlaid on video).
 *
 * The leftmost bar number of a scrolling score stays the same while new measures
 * enter on the right, so one-crop-per-bar dedup either drops or repeats content.
 * Instead we:
 *  1. turn each crop into a "notation" channel (bright, unsaturated pixels — the
 *     white overlay — minus colourful performer/guitar),
 *  2. estimate the horizontal shift between consecutive crops by correlating
 *     the vertical edges of thin bright strokes only (small top-hat + x-gradient):
 *     digits, stems, barlines and diagrams are matched, while staff lines (which
 *     match at any shift), the moving performer and screen-fixed edges are not,
 *  3. place every crop on one wide canvas and, per pixel, take a low percentile
 *     across all crops covering it: the notation is present in every crop and
 *     survives, while the moving background, playhead and highlight boxes do not,
 *  4. cut the canvas into rows at barlines.
 * Every part of the score is therefore stitched in exactly once; musical repeats
 * written in the score are untouched because they are different canvas columns.
 */
// Notation channel: brightness minus a chroma penalty (yellow guitar ≠ white ink).
const CHROMA_PENALTY = 2;
// Alignment is searched at 1/ALIGN_SCALE resolution, then refined at full res.
const ALIGN_SCALE = 8;
const MAX_SHIFT_FRACTION = 0.85; // largest shift tried, as a fraction of crop width
const STROKE_SIZE = 9; // top-hat size isolating notation strokes for alignment
const MIN_MATCH = 0.35; // NCC below this = discontinuity (cut, jump, non-tab)
const STATIC_STEP = 8; // px: frames within this of each other show the score at one position
const MAX_GROUP_FRAMES = 15; // frames per position used for the temporal median
const STAFF_ROW_FRACTION = 0.5; // a row is a staff line if this much of it is ink
const MAX_LINE_THICKNESS = 4; // thicker horizontal bands (beams) are not staff lines
const MIN_STAFF_LINES = 4;
const INK = 80;
// Final cleanup: bright structures that can contain a square this big are
// background (wall, guitar), not notation strokes.
const TOPHAT_SIZE = 19;
const BLOB_LEVEL = 100; // opening value above this = leftover background blob (flagged)
async function notationChannel(path) {
    const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const n = info.width * info.height;
    const out = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 3) {
        const r = data[p];
        const g = data[p + 1];
        const b = data[p + 2];
        const mx = Math.max(r, g, b);
        const v = mx - CHROMA_PENALTY * (mx - Math.min(r, g, b));
        out[i] = v < 0 ? 0 : v;
    }
    return { data: out, width: info.width, height: info.height };
}
/** Thin bright strokes only: value minus a horizontal+vertical box blur, clamped at 0. */
function highPass(img, radius) {
    const { data, width: w, height: h } = img;
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        let acc = 0;
        const row = y * w;
        for (let x = -radius; x < w + radius; x++) {
            const add = x + radius;
            const sub = x - radius - 1;
            if (add >= 0 && add < w)
                acc += data[row + add];
            if (sub >= 0 && sub < w)
                acc -= data[row + sub];
            if (x >= 0 && x < w)
                tmp[row + x] = acc / (2 * radius + 1);
        }
    }
    for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let y = -radius; y < h + radius; y++) {
            const add = y + radius;
            const sub = y - radius - 1;
            if (add >= 0 && add < h)
                acc += tmp[add * w + x];
            if (sub >= 0 && sub < h)
                acc -= tmp[sub * w + x];
            if (y >= 0 && y < h) {
                const v = data[y * w + x] - acc / (2 * radius + 1);
                out[y * w + x] = v > 0 ? v : 0;
            }
        }
    }
    return out;
}
function downscale(img, f) {
    const w = Math.floor(img.width / f);
    const h = Math.floor(img.height / f);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let acc = 0;
            for (let dy = 0; dy < f; dy++) {
                const row = (y * f + dy) * img.width + x * f;
                for (let dx = 0; dx < f; dx++)
                    acc += img.data[row + dx];
            }
            out[y * w + x] = acc / (f * f);
        }
    }
    return { data: out, width: w, height: h };
}
/**
 * Normalized cross-correlation of `a` and `b` where b's content is a's content
 * moved left by `shift` px (i.e. a[x + shift] ≈ b[x]), over their overlap.
 */
function ncc(a, b, w, h, shift, rowStep = 1) {
    const x0 = Math.max(0, -shift);
    const x1 = Math.min(w, w - shift);
    if (x1 - x0 < w * (1 - MAX_SHIFT_FRACTION) * 0.9)
        return -1;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let y = 0; y < h; y += rowStep) {
        const row = y * w;
        for (let x = x0; x < x1; x++) {
            const va = a[row + x + shift];
            const vb = b[row + x];
            sab += va * vb;
            saa += va * va;
            sbb += vb * vb;
        }
    }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}
/** |d/dx| of the thin bright strokes (value minus its grayscale opening). */
function strokeEdges(img, k) {
    const opened = morph(morph(img, k, true), k, false);
    const { width: w, height: h } = img;
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            const a = img.data[i + 1] - opened.data[i + 1];
            const b = img.data[i - 1] - opened.data[i - 1];
            out[i] = Math.abs(a - b);
        }
    }
    return out;
}
function features(img) {
    const small = downscale(img, ALIGN_SCALE);
    return {
        coarse: strokeEdges(small, 3),
        cw: small.width,
        ch: small.height,
        fine: strokeEdges(img, STROKE_SIZE),
    };
}
/** Best shift (full-res px) of frame b relative to frame a, with its match score. */
function align(a, b, width, height) {
    const maxCoarse = Math.floor(a.cw * MAX_SHIFT_FRACTION);
    let best = { shift: 0, score: -1 };
    for (let s = -Math.floor(maxCoarse / 8); s <= maxCoarse; s++) {
        const score = ncc(a.coarse, b.coarse, a.cw, a.ch, s);
        if (score > best.score)
            best = { shift: s, score };
    }
    const center = best.shift * ALIGN_SCALE;
    let fine = { shift: center, score: -1 };
    for (let s = center - ALIGN_SCALE; s <= center + ALIGN_SCALE; s++) {
        const score = ncc(a.fine, b.fine, width, height, s, 2);
        if (score > fine.score)
            fine = { shift: s, score };
    }
    return fine;
}
/**
 * Find the tab staff: the longest run of ≥ MIN_STAFF_LINES thin, evenly spaced
 * full-width lines. `ink(i)` gives the ink strength of pixel i.
 */
function findStaff(width, height, ink) {
    const bands = [];
    for (let y = 0; y < height; y++) {
        let n = 0;
        for (let x = 0; x < width; x++)
            if (ink(y * width + x) > INK)
                n++;
        if (n <= width * STAFF_ROW_FRACTION)
            continue;
        const last = bands[bands.length - 1];
        if (last && last[1] === y - 1)
            last[1] = y;
        else
            bands.push([y, y]);
    }
    const lines = bands.filter(([a, b]) => b - a + 1 <= MAX_LINE_THICKNESS);
    let best = null;
    let bestCount = 0;
    for (let i = 0; i < lines.length; i++) {
        let j = i + 1;
        const gap = j < lines.length ? lines[j][0] - lines[i][0] : 0;
        while (j < lines.length && Math.abs(lines[j][0] - lines[j - 1][0] - gap) <= Math.max(3, gap * 0.15))
            j++;
        if (j - i > bestCount) {
            bestCount = j - i;
            best = { top: lines[i][0], bottom: lines[j - 1][1] };
        }
    }
    return bestCount >= MIN_STAFF_LINES ? best : null;
}
/** 1-D running min or max over a window of `k` (van Herk / Gil-Werman, O(1) per sample). */
function runningExtreme(src, k, isMin) {
    const n = src.length;
    const r = k >> 1;
    const pad = isMin ? 255 : 0;
    const op = isMin ? Math.min : Math.max;
    const len = Math.ceil((n + 2 * r) / k) * k;
    const p = new Uint8Array(len).fill(pad);
    p.set(src, r);
    const g = new Uint8Array(len);
    const hh = new Uint8Array(len);
    for (let b = 0; b < len; b += k) {
        g[b] = p[b];
        for (let i = b + 1; i < b + k; i++)
            g[i] = op(g[i - 1], p[i]);
        hh[b + k - 1] = p[b + k - 1];
        for (let i = b + k - 2; i >= b; i--)
            hh[i] = op(hh[i + 1], p[i]);
    }
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++)
        out[i] = op(hh[i], g[Math.min(len - 1, i + k - 1)]);
    return out;
}
/** Separable square erosion (isMin) or dilation of a grayscale image. */
function morph(img, k, isMin) {
    const { width: w, height: h } = img;
    const tmp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
        tmp.set(runningExtreme(img.data.subarray(y * w, (y + 1) * w), k, isMin), y * w);
    const out = new Uint8Array(w * h);
    const col = new Uint8Array(h);
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++)
            col[y] = tmp[y * w + x];
        const res = runningExtreme(col, k, isMin);
        for (let y = 0; y < h; y++)
            out[y * w + x] = res[y];
    }
    return { data: out, width: w, height: h };
}
function fmt(t) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
/** Per-pixel median of a set of equally sized images. */
function median(imgs) {
    const { width, height } = imgs[0];
    const out = new Uint8Array(width * height);
    const vals = new Uint8Array(imgs.length);
    const mid = imgs.length >> 1;
    for (let i = 0; i < out.length; i++) {
        for (let k = 0; k < imgs.length; k++)
            vals[k] = imgs[k].data[i];
        out[i] = vals.sort()[mid];
    }
    return { data: out, width, height };
}
/**
 * Collapse a segment into one image per score position (temporal median, which
 * removes the playhead, highlight boxes and moving hands), then combine the
 * positions per pixel with a minimum: notation is bright at every position,
 * while background only stays where it is bright at all of them. Single-frame
 * positions (motion-blurred mid-slide frames) are only used for columns no
 * steady position covers.
 */
function stack(imgs, seg, times) {
    const { width: w, height: h } = imgs[seg.frames[0]];
    const minOff = Math.min(...seg.offsets);
    const groups = [];
    for (let k = 0; k < seg.frames.length; k++) {
        const g = groups[groups.length - 1];
        if (g && Math.abs(seg.offsets[g[0]] - seg.offsets[k]) < STATIC_STEP)
            g.push(k);
        else
            groups.push([k]);
    }
    const positions = groups.map((g) => {
        const step = Math.max(1, g.length / MAX_GROUP_FRAMES);
        const pick = [];
        for (let i = 0; i < g.length; i += step)
            pick.push(imgs[seg.frames[g[Math.floor(i)]]]);
        return {
            offset: seg.offsets[g[0]] - minOff,
            image: pick.length > 2 ? median(pick) : pick[0],
            frames: g.length,
            time: times[seg.frames[g[0]]],
        };
    });
    const width = Math.max(...positions.map((p) => p.offset)) + w;
    const canvas = new Uint8Array(width * h);
    const coverage = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
        const covering = positions.filter((p) => x >= p.offset && x < p.offset + w);
        const steady = covering.filter((p) => p.frames > 1);
        const use = steady.length ? steady : covering;
        coverage[x] = steady.length;
        for (let y = 0; y < h; y++) {
            let v = 255;
            for (const p of use)
                v = Math.min(v, p.image.data[y * w + (x - p.offset)]);
            canvas[y * width + x] = v;
        }
    }
    return { canvas: { data: canvas, width, height: h }, positions, coverage };
}
/** x ranges (≥ minLen) where `pred(x)` holds. */
function ranges(width, pred, minLen) {
    const out = [];
    let start = -1;
    for (let x = 0; x <= width; x++) {
        const on = x < width && pred(x);
        if (on && start < 0)
            start = x;
        if (!on && start >= 0) {
            if (x - start >= minLen)
                out.push([start, x]);
            start = -1;
        }
    }
    return out;
}
/** Barline x positions: columns that are ink over nearly the whole staff height. */
function barlines(img, top, bottom) {
    const xs = [];
    const span = bottom - top + 1;
    for (let x = 0; x < img.width; x++) {
        let ink = 0;
        for (let y = top; y <= bottom; y++)
            if (img.data[y * img.width + x] > INK)
                ink++;
        if (ink >= span * 0.9)
            xs.push(x);
    }
    // Merge adjacent columns and double/repeat barlines into one break point (their left edge).
    const merged = [];
    let last = -Infinity;
    for (const x of xs) {
        if (x - last > 14)
            merged.push(x);
        last = x;
    }
    return merged;
}
/**
 * Row breaks at barlines with rows of similar width (≈ rowWidth, never a tiny
 * leftover row). Each cut is moved to the emptiest column just left of its
 * barline in the area above the staff, so chord names that overhang the barline
 * are not split; the barline itself starts the next row.
 */
function rowBreaks(img, bars, staffTop, rowWidth) {
    const width = img.width;
    const n = Math.max(1, Math.round(width / rowWidth));
    const target = width / n;
    const inkAbove = (x) => {
        let c = 0;
        for (let y = 0; y < staffTop; y++)
            if (img.data[y * width + x] > INK)
                c++;
        return c;
    };
    const cuts = [0];
    for (let r = 1; r < n; r++) {
        const want = r * target;
        const prev = cuts[cuts.length - 1];
        const near = bars.filter((b) => b > prev + target * 0.5 && Math.abs(b - want) < target * 0.4);
        if (!near.length) {
            cuts.push(Math.round(want));
            continue;
        }
        const bar = near.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
        let best = bar - 1;
        for (let x = bar - 1; x >= Math.max(prev + 1, bar - 60); x--)
            if (inkAbove(x) < inkAbove(best))
                best = x;
        cuts.push(best);
    }
    cuts.push(width);
    return cuts;
}
/**
 * Stitch the crops of a horizontally scrolling score into row images (PNG paths,
 * in score order) written to `outDir`, together with the full panorama(s) and a
 * `flags.txt` listing uncertain regions with video timestamps.
 */
export async function stitchScrolling(crops, times, outDir, rowWidth) {
    log.step(`Aligning ${crops.length} crops of a scrolling score…`);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const flags = [];
    const imgs = [];
    for (const c of crops)
        imgs.push(await notationChannel(c));
    const { width: w, height: h } = imgs[0];
    // Frames without a staff (intro/outro, scene cuts) are not tab. Thin strokes
    // only (high-pass), so bright backdrop rows don't count as staff lines.
    const isTab = imgs.map((img) => {
        const hp = highPass(img, 4);
        return findStaff(w, h, (i) => hp[i] * 2) !== null;
    });
    let runStart = -1;
    for (let i = 0; i <= imgs.length; i++) {
        if (i < imgs.length && !isTab[i]) {
            if (runStart < 0)
                runStart = i;
        }
        else if (runStart >= 0) {
            flags.push(`${fmt(times[runStart])}–${fmt(times[i - 1])}: no tab staff detected; frames skipped`);
            runStart = -1;
        }
    }
    // Chain consecutive tab frames into segments by their measured shift.
    const segments = [];
    const shifts = [];
    let cur = null;
    let prev = -1;
    let prevFeat = null;
    for (let i = 0; i < imgs.length; i++) {
        if (!isTab[i]) {
            cur = null;
            prevFeat = null;
            continue;
        }
        const feat = features(imgs[i]);
        if (cur && prevFeat) {
            const { shift, score } = align(prevFeat, feat, w, h);
            shifts.push(`${fmt(times[i])} shift=${shift} ncc=${score.toFixed(2)}`);
            if (score >= MIN_MATCH) {
                cur.frames.push(i);
                cur.offsets.push(cur.offsets[cur.offsets.length - 1] + shift);
            }
            else {
                flags.push(`${fmt(times[prev])}→${fmt(times[i])}: score could not be aligned (ncc ${score.toFixed(2)}); ` +
                    "started a new section — check for missing or repeated measures here");
                cur = null;
            }
        }
        if (!cur) {
            cur = { frames: [i], offsets: [0] };
            segments.push(cur);
        }
        prev = i;
        prevFeat = feat;
    }
    writeFileSync(join(outDir, "shifts.txt"), shifts.join("\n") + "\n");
    if (segments.length === 0) {
        throw new Error("No frames with a tab staff found — check --box and the time range.");
    }
    log.debug(`${segments.length} section(s): ` + segments.map((s) => `${fmt(times[s.frames[0]])}–${fmt(times[s.frames[s.frames.length - 1]])}`).join(", "));
    const rows = [];
    for (let si = 0; si < segments.length; si++) {
        const seg = segments[si];
        const { canvas: stacked, positions, coverage } = stack(imgs, seg, times);
        const tag = `section-${String(si + 1).padStart(2, "0")}`;
        const timeAt = (x) => {
            const p = positions.find((q) => x >= q.offset && x < q.offset + w) ?? positions[0];
            return fmt(p.time);
        };
        // Remove leftover large bright areas (top-hat) and flag where they were,
        // since notation drawn over them may be faint or missing.
        const opened = morph(morph(stacked, TOPHAT_SIZE, true), TOPHAT_SIZE, false);
        const canvas = { data: new Uint8Array(stacked.data.length), width: stacked.width, height: h };
        // Contrast relative to the local background: a white stroke over a light wall
        // is as much ink as one over the dark pillarbox.
        for (let i = 0; i < canvas.data.length; i++) {
            const o = opened.data[i];
            canvas.data[i] = Math.min(255, ((stacked.data[i] - o) * 255) / Math.max(255 - o, 60));
        }
        const blobCols = new Uint16Array(canvas.width);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < canvas.width; x++)
                if (opened.data[y * canvas.width + x] > BLOB_LEVEL)
                    blobCols[x]++;
        }
        for (const [a, b] of ranges(canvas.width, (x) => blobCols[x] > h * 0.1, 30)) {
            flags.push(`${tag} x ${a}–${b} (on screen ~${timeAt(a)}): background could not be fully separated from the ` +
                "notation; strokes there may be faint — compare with the video");
        }
        for (const [a, b] of ranges(canvas.width, (x) => coverage[x] < 2, 200)) {
            flags.push(`${tag} x ${a}–${b} (on screen ~${timeAt(a)}): seen at only ${Math.min(...coverage.subarray(a, b))} ` +
                "steady score position(s); background suppression is weaker here");
        }
        // Ink → dark on white paper; stretch so faint anti-aliased strokes stay legible.
        const paper = Buffer.alloc(canvas.data.length);
        for (let i = 0; i < canvas.data.length; i++) {
            const v = Math.min(1, Math.max(0, (canvas.data[i] - 40) / 160));
            paper[i] = Math.round(255 * (1 - v));
        }
        const raw = { raw: { width: canvas.width, height: h, channels: 1 } };
        await sharp(paper, raw).png().toFile(join(outDir, `${tag}-panorama.png`));
        const staff = findStaff(canvas.width, h, (i) => canvas.data[i]);
        const bars = staff ? barlines(canvas, staff.top, staff.bottom) : [];
        if (!bars.length)
            flags.push(`${tag}: no barlines found; rows cut at fixed width`);
        const cuts = rowBreaks(canvas, bars, staff?.top ?? 0, rowWidth);
        for (let r = 0; r + 1 < cuts.length; r++) {
            const dest = join(outDir, `${tag}-row-${String(r + 1).padStart(2, "0")}.png`);
            await sharp(paper, raw)
                .extract({ left: cuts[r], top: 0, width: cuts[r + 1] - cuts[r], height: h })
                .png()
                .toFile(dest);
            rows.push(dest);
        }
        log.info(`${tag}: ${seg.frames.length} frames at ${positions.length} positions → ${canvas.width}px panorama, ${bars.length} barlines, ${cuts.length - 1} rows`);
    }
    writeFileSync(join(outDir, "flags.txt"), (flags.length ? flags.join("\n") : "no issues flagged") + "\n");
    for (const f of flags)
        log.warn(f);
    log.success(`Stitched ${segments.length} section(s) into ${rows.length} rows → ${outDir}`);
    return rows;
}
//# sourceMappingURL=stitch.js.map