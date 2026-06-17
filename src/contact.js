import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exec, fmtTime } from "./util.js";

const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
];

async function findFont() {
  for (const f of FONT_CANDIDATES) {
    if (await fs.stat(f).then(() => true).catch(() => false)) return f;
  }
  return null;
}

/** Evenly sample up to `count` items from an array. */
function sample(arr, count) {
  if (arr.length <= count) return arr.slice();
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(arr[Math.round((i * (arr.length - 1)) / (count - 1))]);
  }
  return out;
}

/**
 * Build a single contact-sheet image: up to `count` thumbnails arranged in a
 * grid, each labelled with its timeline timestamp (and source tag when there
 * is more than one source). Returns the chosen frames (for the index/report).
 */
export async function buildContactSheet(
  ffmpeg,
  frames,
  framesDir,
  outPath,
  { count = 25, multiSource = false, width = 360 } = {}
) {
  if (!frames.length) return [];
  const chosen = sample(frames, count);
  const cols = Math.min(5, Math.ceil(Math.sqrt(chosen.length)));
  const rows = Math.ceil(chosen.length / cols);

  const font = await findFont();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "v2c-contact-"));
  try {
    // Render one labelled, downscaled thumbnail per chosen frame.
    for (let i = 0; i < chosen.length; i++) {
      const f = chosen[i];
      const src = path.join(framesDir, f.file);
      const out = path.join(tmp, `thumb_${String(i).padStart(3, "0")}.jpg`);
      const label =
        (multiSource ? `S${f.sourceIndex + 1}  ` : "") + fmtTime(f.globalTime);
      const filters = [`scale=${width}:-1`];
      if (font) {
        // Use textfile to avoid escaping the colons in the timestamp.
        const labelFile = path.join(tmp, `label_${i}.txt`);
        await fs.writeFile(labelFile, label, "utf8");
        filters.push(
          `drawtext=fontfile=${font}:textfile=${labelFile}:` +
            `x=6:y=6:fontsize=20:fontcolor=white:` +
            `box=1:boxcolor=black@0.6:boxborderw=6`
        );
      }
      await exec(ffmpeg, [
        "-y", "-i", src,
        "-vf", filters.join(","),
        "-frames:v", "1",
        out,
      ]);
    }

    // Tile the thumbnails into one image.
    await exec(ffmpeg, [
      "-y",
      "-framerate", "1",
      "-i", path.join(tmp, "thumb_%03d.jpg"),
      "-frames:v", "1",
      "-vf", `tile=${cols}x${rows}:margin=10:padding=6:color=0x222222`,
      outPath,
    ]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return chosen;
}
