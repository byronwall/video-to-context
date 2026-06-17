import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { info, step, done } from "./util.js";

const BASE_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

const KNOWN = new Set([
  "tiny", "tiny.en",
  "base", "base.en",
  "small", "small.en",
  "medium", "medium.en",
  "large-v1", "large-v2", "large-v3", "large-v3-turbo",
]);

export function modelsDir() {
  return path.join(os.homedir(), ".cache", "video-to-context", "models");
}

/**
 * Resolve a whisper model name to a local ggml .bin path, downloading and
 * caching it on first use. Accepts a known model name or a direct path to a
 * .bin file.
 */
export async function ensureModel(model) {
  // Allow passing an explicit file path.
  if (model.endsWith(".bin") || model.includes("/")) {
    const abs = path.resolve(model);
    await fs.access(abs);
    return abs;
  }
  if (!KNOWN.has(model)) {
    throw new Error(
      `Unknown model "${model}". Known: ${[...KNOWN].join(", ")}\n` +
        "Or pass a direct path to a ggml-*.bin file."
    );
  }
  const dir = modelsDir();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `ggml-${model}.bin`);
  try {
    const st = await fs.stat(file);
    if (st.size > 0) return file;
  } catch {
    /* not cached */
  }
  step(`Downloading whisper model "${model}" (one-time)`);
  info(`→ ${file}`);
  await download(`${BASE_URL}/ggml-${model}.bin`, file);
  done(`Model cached`);
  return file;
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Too many redirects"));
    https
      .get(url, { headers: { "User-Agent": "video-to-context" } }, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          return resolve(download(res.headers.location, dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(
            new Error(`Download failed: HTTP ${res.statusCode} for ${url}`)
          );
        }
        const total = parseInt(res.headers["content-length"] || "0", 10);
        let received = 0;
        let lastPct = -1;
        const out = createWriteStream(dest);
        res.on("data", (chunk) => {
          received += chunk.length;
          if (total) {
            const pct = Math.floor((received / total) * 100);
            if (pct !== lastPct && pct % 5 === 0) {
              lastPct = pct;
              process.stdout.write(
                `\r  ${pct}%  (${(received / 1e6).toFixed(0)} / ${(
                  total / 1e6
                ).toFixed(0)} MB)`
              );
            }
          }
        });
        res.pipe(out);
        out.on("finish", () => {
          process.stdout.write("\r" + " ".repeat(40) + "\r");
          out.close(() => resolve());
        });
        out.on("error", (err) =>
          fs.unlink(dest).finally(() => reject(err))
        );
      })
      .on("error", reject);
  });
}
