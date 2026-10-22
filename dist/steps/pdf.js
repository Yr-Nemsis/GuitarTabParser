import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { log } from "../util/logger.js";
// A4 portrait in PDF points (72 dpi).
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 36; // 0.5 inch
const GAP = 12; // vertical gap between stacked tabs
const TITLE_SIZE = 16;
const TITLE_GAP = 16; // space below the title heading
/** Split `text` into lines that fit `maxWidth` at `size` using `font`. */
function wrap(text, font, size, maxWidth) {
    const words = text.split(/\s+/);
    const lines = [];
    let line = "";
    for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
            lines.push(line);
            line = word;
        }
        else {
            line = candidate;
        }
    }
    if (line)
        lines.push(line);
    return lines;
}
/**
 * Stack the crops vertically down A4 pages (all at one scale, so the widest
 * image fills the content width; new page when the next image won't fit) and write the PDF to `outPath`. `title` is
 * used as a heading on the first page and as the document metadata title.
 */
export async function buildPdf(images, outPath, title) {
    if (images.length === 0) {
        throw new Error("No tab images to write — nothing survived detection/dedup.");
    }
    log.step(`Building PDF from ${images.length} tab images…`);
    const doc = await PDFDocument.create();
    doc.setTitle(title);
    doc.setSubject("Guitar tab extracted from a lesson video");
    doc.setCreator("tab-parser");
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const contentWidth = PAGE_WIDTH - MARGIN * 2;
    const maxContentHeight = PAGE_HEIGHT - MARGIN * 2;
    let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let cursorY = PAGE_HEIGHT - MARGIN; // top of the usable area, drawing downward
    // Title heading on the first page. The standard font only covers WinAnsi, so
    // characters it can't encode (e.g. CJK file names) are left out of the drawn
    // heading; the metadata title and file name keep the full title.
    const heading = [...title]
        .filter((ch) => {
        try {
            font.encodeText(ch);
            return true;
        }
        catch {
            return false;
        }
    })
        .join("")
        .replace(/\s+/g, " ")
        .trim();
    for (const line of heading ? wrap(heading, font, TITLE_SIZE, contentWidth) : []) {
        cursorY -= TITLE_SIZE;
        page.drawText(line, {
            x: MARGIN,
            y: cursorY,
            size: TITLE_SIZE,
            font,
            color: rgb(0, 0, 0),
        });
        cursorY -= 4;
    }
    cursorY -= TITLE_GAP;
    const pngs = [];
    for (const imgPath of images)
        pngs.push(await doc.embedPng(await readFile(imgPath)));
    // One scale for every image keeps text size consistent when rows differ in width.
    const scale = contentWidth / Math.max(...pngs.map((p) => p.width));
    for (const png of pngs) {
        let drawWidth = png.width * scale;
        let drawHeight = png.height * scale;
        // An image taller than a full page gets scaled down to fit one page.
        if (drawHeight > maxContentHeight) {
            const fit = maxContentHeight / drawHeight;
            drawHeight *= fit;
            drawWidth *= fit;
        }
        // Start a new page if this image won't fit in the remaining space.
        if (cursorY - drawHeight < MARGIN) {
            page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
            cursorY = PAGE_HEIGHT - MARGIN;
        }
        page.drawImage(png, {
            x: MARGIN,
            y: cursorY - drawHeight,
            width: drawWidth,
            height: drawHeight,
        });
        cursorY -= drawHeight + GAP;
    }
    await writeFile(outPath, await doc.save());
    log.success(`Wrote PDF → ${outPath} (${doc.getPageCount()} pages)`);
}
//# sourceMappingURL=pdf.js.map