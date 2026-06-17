import { exec } from "./util.js";

async function which(name) {
  try {
    const { stdout } = await exec("which", [name], { capture: true });
    const p = stdout.trim();
    return p || null;
  } catch {
    return null;
  }
}

/** Locate ffmpeg/ffprobe; throw with install hint if missing. */
export async function findFfmpeg() {
  const ffmpeg = await which("ffmpeg");
  if (!ffmpeg) {
    throw new Error(
      "ffmpeg not found. Install it with:\n    brew install ffmpeg"
    );
  }
  const ffprobe = await which("ffprobe");
  return { ffmpeg, ffprobe };
}

/**
 * Locate the whisper.cpp CLI. The Homebrew formula installs `whisper-cli`
 * (older versions shipped `whisper-cpp` / `main`). Return the first match.
 */
export async function findWhisper() {
  for (const name of ["whisper-cli", "whisper-cpp", "whisper"]) {
    const p = await which(name);
    if (p) return { bin: name, path: p };
  }
  throw new Error(
    "whisper.cpp not found. Install it with:\n    brew install whisper-cpp\n" +
      "(provides the `whisper-cli` binary)"
  );
}
