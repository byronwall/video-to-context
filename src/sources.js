import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "./util.js";

export const VIDEO_EXTS = new Set([
  ".mov", ".mp4", ".m4v", ".mkv", ".webm", ".avi", ".mpg", ".mpeg",
]);

/**
 * Resolve the CLI input into an ordered list of source video paths.
 * - a file        → just that file
 * - a directory   → all eligible videos in that directory (non-recursive)
 * - nothing       → all eligible videos in the current working directory
 * Returns { mode: 'file'|'dir', dir, videos: string[] }.
 */
export async function resolveInputs(input) {
  const target = path.resolve(input || ".");
  const st = await fs.stat(target).catch(() => {
    throw new Error(`Input not found: ${target}`);
  });

  if (st.isFile()) {
    if (!VIDEO_EXTS.has(path.extname(target).toLowerCase())) {
      throw new Error(`Not a recognised video file: ${target}`);
    }
    return { mode: "file", dir: path.dirname(target), videos: [target] };
  }

  const entries = await fs.readdir(target, { withFileTypes: true });
  const videos = entries
    .filter((e) => e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(target, e.name))
    .sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b), undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );
  if (!videos.length) {
    throw new Error(
      `No eligible videos found in ${target}\n` +
        `(looked for: ${[...VIDEO_EXTS].join(", ")})`
    );
  }
  return { mode: "dir", dir: target, videos };
}

/**
 * Probe each video and lay them out on a single combined timeline.
 * Returns sources: [{ index, path, name, duration, offset }] and totalDuration.
 */
export async function buildTimeline(ffprobe, videos) {
  const sources = [];
  let offset = 0;
  for (let i = 0; i < videos.length; i++) {
    const p = videos[i];
    const duration = await probeDuration(ffprobe, p);
    sources.push({
      index: i,
      path: p,
      name: path.basename(p),
      duration,
      offset,
    });
    offset += duration || 0;
  }
  return { sources, totalDuration: offset };
}

export async function probeDuration(ffprobe, input) {
  if (!ffprobe) return 0;
  try {
    const { stdout } = await exec(
      ffprobe,
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        input,
      ],
      { capture: true }
    );
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) ? d : 0;
  } catch {
    return 0;
  }
}

/** Map a global timeline second back to its originating source + local time. */
export function sourceAt(sources, t) {
  for (const s of sources) {
    if (t >= s.offset && t < s.offset + (s.duration || Infinity)) {
      return { source: s, localTime: t - s.offset };
    }
  }
  const last = sources[sources.length - 1];
  return { source: last, localTime: t - last.offset };
}
