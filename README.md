# Youtube Guitar Tab Parser

CLI that turns a YouTube guitar-lesson video into a PDF of the guitar tab.

It downloads the video, samples frames, uses Claude vision to locate the tab
region, crops every frame to that region, de-duplicates the crops by the bar
number printed on each line of the score, and stitches the distinct tab lines
vertically into a PDF. It works out of the box with no configuration — the PDF
is written to `out/<video-title>.pdf`, with the video title as a heading on the
first page and in the document metadata.

## Example

Generated from the YouTube lesson
[Game of Thrones - Guitar Lesson + TAB](https://youtu.be/WgU5tDGC-Vc):

- 🎬 Source video: <https://youtu.be/WgU5tDGC-Vc>
- 📄 Output PDF: [examples/Game of Thrones.pdf](examples/Game%20of%20Thrones.pdf)

## Requirements

- Node.js ≥ 20
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and [`ffmpeg`](https://ffmpeg.org/) on your `PATH`
  (`brew install yt-dlp ffmpeg`)
- An Anthropic API key

## Setup

```bash
npm install
npm run build
cp .env.example .env   # then put your ANTHROPIC_API_KEY in it
```

## Usage

```bash
# with a .env file
node --env-file=.env dist/cli.js "https://www.youtube.com/watch?v=WgU5tDGC-Vc"

# or with the key already exported
export ANTHROPIC_API_KEY=sk-ant-...
node dist/cli.js "https://www.youtube.com/watch?v=WgU5tDGC-Vc"
```

During development you can skip the build step:

```bash
node --env-file=.env --import tsx src/cli.ts "<url>"
```

The result is written to `out/<video-title>.pdf` (its path is also printed to
stdout); progress goes to stderr.

### Local video files

Pass `--input` instead of a URL to use a video you already have. yt-dlp is not
needed or called, the file is read in place at its original resolution, and the
PDF is named after the file (override with `--title`). Paths with spaces or
Unicode work as long as they are quoted.

```bash
node --env-file=.env dist/cli.js --input "/path/to/my lesson.mp4"
```

### Horizontally scrolling scores (no API key needed)

Some lessons overlay white notation on the video and scroll the score sideways.
There the leftmost bar number stays the same while new measures enter on the
right, so the default bar-number dedup drops or repeats measures. Use
`--scroll` to align the overlapping crops and stitch every part of the score in
exactly once, then cut it into rows at barlines. Combined with a manual
`--box` (from a frame you inspected), no Claude calls are made:

```bash
# preview a short range first, then drop --start/--end for the whole video
node dist/cli.js --input "/path/to/video.mov" --box 0,55,1000,880 --scroll -i 0.5 --start 10 --end 30
```

Next to the PDF, `out/<title>.parts/` keeps the stitched panorama, the row
images, `shifts.txt` (the measured scroll per frame) and `flags.txt` (sections
with timestamps where the background could not be fully separated, frames
without a staff, or alignment breaks). Check those spots against the video.

## Options

Everything has a sensible default; you normally only need the URL.

```
-i, --interval <seconds>   screenshot interval (default 2)
--model <id>               Claude vision model (default claude-sonnet-5)
--sample <n>               frames sampled for tab-region detection (default 6)
--dedup-threshold <n>      pre-dedup Hamming distance, cost control (default 12)
--max-height <px>          cap download resolution (default 720)
--keep-temp                keep intermediate frames/crops
--input <path>             local video file instead of a URL (no download)
--title <text>             override the PDF title / file name
--box <x0,y0,x1,y1>        tab region in 0–1000 coords; skips vision detection
--scroll                   stitch a horizontally scrolling score (no bar-number dedup)
--row-width <px>           target PDF row width in source pixels for --scroll (default 2000)
--start <s> / --end <s>    only process this time range of the video
```

An Anthropic API key is only required for vision detection (no `--box`) and
for bar-number dedup (no `--scroll`).

## How it works

1. **Download** — `yt-dlp` fetches the video (≤ `--max-height`).
2. **Frames** — `ffmpeg` extracts one frame every `--interval` seconds.
3. **Detect** — two stages, since vision models are reliable at picking labeled
   regions but not at precise pixel coordinates:
   - A labeled row/column grid is drawn on `--sample` frames and Claude vision
     reports which rows and columns the sheet music overlaps. The per-edge median
     across samples gives a coarse box (works whether the tab is a full-width
     bottom strip or a corner overlay).
   - That box is then snapped to the actual paper edges with an image mask
     (sheet music is dark content on a light, unsaturated background, unlike the
     colourful performer/backdrop), so the crop hugs the tab tightly. If no clear
     paper region is found (e.g. a dark-themed tab viewer), the vision box is used.
4. **Crop** — `sharp` crops every frame to that box.
5. **Pre-dedup** — a dHash perceptual hash drops near-identical consecutive crops.
   This is only a cost control to reduce the number of vision calls in the next step.
6. **Bar-number dedup** — Claude reads the measure/bar number printed at the start
   of each line and whether the crop is real sheet music. The tool keeps exactly
   one crop per distinct bar number (first appearance wins) and drops non-tab
   crops (title cards, intros/outros). Because the bar number is constant while
   the playback cursor sweeps a line and only changes when the score advances,
   this collapses all the near-identical cursor frames of a line into a single page.
7. **PDF** — `pdf-lib` stacks the distinct tab lines vertically down A4 pages,
   in the order they appear in the video. The video title (read from `yt-dlp`)
   becomes the file name, a heading on the first page, and the document metadata
   title. Output: `out/<video-title>.pdf`.
