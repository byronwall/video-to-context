import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { findFfmpeg, findWhisper } from "./tools.js";
import { ensureModel } from "./models.js";
import { resolveInputs, buildTimeline } from "./sources.js";
import { buildContactSheet } from "./contact.js";
import { parseTranscript, writeIndex, writeHtmlReport } from "./report.js";
import { exec, log, step, done, info, fmtTime } from "./util.js";

const HELP = `
video-to-context — turn screen recordings into a structured, digestible context
package (transcript + screenshots + contact sheet + HTML report) using local
FFmpeg and whisper.cpp. No API calls, no uploads.

USAGE
  video-to-context [input] [options]
  v2c [input] [options]

  input may be a video FILE, a DIRECTORY (all eligible videos in it are
  concatenated into one timeline with lineage back to each source), or omitted
  (defaults to the current directory).

OPTIONS
  -o, --output <dir>     Output directory (default: <name>-context)
  -m, --model <name>     Whisper model: tiny(.en) base(.en) small(.en)
                         medium(.en) large-v3 large-v3-turbo, or a path to a
                         ggml-*.bin file (default: base.en)
  -l, --language <code>  Spoken language hint, e.g. en (default: auto)
      --interval <sec>   Seconds between screenshots (default: 10)
      --scene [thresh]   Scene-change detection instead of fixed interval
                         (threshold 0..1, default 0.08)
      --contact <n>      Frames in the contact sheet (default: 25; 0 disables)
      --no-source        Don't copy source video(s) into the package
      --no-frames        Skip screenshot extraction
      --no-transcript    Skip transcription
  -f, --force            Overwrite an existing output directory
  -h, --help             Show this help

EXAMPLES
  video-to-context                       # all videos in the current folder
  video-to-context demo.mov
  video-to-context ~/Desktop -m medium   # concatenate every video on the Desktop
  video-to-context demo.mov --scene 0.05 -o ./demo-context
`;

function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    model: "base.en",
    language: null,
    interval: 10,
    scene: null,
    contact: 25,
    copySource: true,
    frames: true,
    transcript: true,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "-h": case "--help": opts.help = true; break;
      case "-o": case "--output": opts.output = next(); break;
      case "-m": case "--model": opts.model = next(); break;
      case "-l": case "--language": opts.language = next(); break;
      case "--interval": opts.interval = parseFloat(next()); break;
      case "--contact": opts.contact = parseInt(next(), 10); break;
      case "--scene": {
        const peek = argv[i + 1];
        opts.scene = peek && !peek.startsWith("-") ? parseFloat(next()) : 0.08;
        break;
      }
      case "--no-source": opts.copySource = false; break;
      case "--no-frames": opts.frames = false; break;
      case "--no-transcript": opts.transcript = false; break;
      case "-f": case "--force": opts.force = true; break;
      default:
        if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
        if (opts.input) throw new Error(`Unexpected argument: ${a}`);
        opts.input = a;
    }
  }
  return opts;
}

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    log(HELP);
    return;
  }

  // 0. Resolve tools first so we fail fast with install hints.
  const { ffmpeg, ffprobe } = await findFfmpeg();
  const whisper = opts.transcript ? await findWhisper() : null;

  // 1. Resolve inputs → ordered source list → combined timeline.
  const { mode, dir, videos } = await resolveInputs(opts.input);
  const { sources, totalDuration } = await buildTimeline(ffprobe, videos);

  const title =
    mode === "file"
      ? path.basename(videos[0], path.extname(videos[0]))
      : path.basename(dir);
  const outDir = path.resolve(opts.output || `${title}-context`);

  const exists = await fs.stat(outDir).then(() => true).catch(() => false);
  if (exists && !opts.force) {
    throw new Error(
      `Output directory already exists: ${outDir}\nUse --force to overwrite, or -o to choose another.`
    );
  }
  if (exists) await fs.rm(outDir, { recursive: true, force: true });

  const dirs = {
    root: outDir,
    source: path.join(outDir, "source"),
    audio: path.join(outDir, "audio"),
    frames: path.join(outDir, "frames"),
    transcript: path.join(outDir, "transcript"),
  };
  for (const d of Object.values(dirs)) await fs.mkdir(d, { recursive: true });

  log(`\n\x1b[1mvideo-to-context\x1b[0m  →  ${outDir}`);
  if (sources.length > 1) {
    info(`${sources.length} sources, ${fmtTime(totalDuration)} combined:`);
    for (const s of sources) {
      info(`  ${s.index + 1}. ${s.name}  (${fmtTime(s.duration)} @ ${fmtTime(s.offset)})`);
    }
  }
  log("");

  const modelPath = opts.transcript ? await ensureModel(opts.model) : null;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "v2c-"));

  try {
    // 2. Source copies (preserve lineage of originals inside the package).
    if (opts.copySource) {
      step("Copying source video(s)");
      for (const s of sources) {
        await fs.copyFile(s.path, path.join(dirs.source, s.name));
      }
      done(`${sources.length} file(s) → source/`);
    } else {
      await fs.rmdir(dirs.source).catch(() => {});
    }

    // 3. Audio — extract each source to wav, then concatenate.
    step("Extracting audio (mono 16 kHz WAV)");
    const audioPath = path.join(dirs.audio, "audio.wav");
    await extractAudio(ffmpeg, sources, audioPath, tmp);
    done(path.relative(outDir, audioPath));

    // 4. Frames — extract per source, then merge onto the combined timeline.
    let frames = [];
    if (opts.frames) {
      const label =
        opts.scene != null
          ? `scene change > ${opts.scene}`
          : `every ${opts.interval}s`;
      step(`Extracting screenshots (${label})`);
      frames = await extractFrames(ffmpeg, sources, dirs.frames, tmp, opts);
      done(`${frames.length} screenshots`);
    } else {
      await fs.rmdir(dirs.frames).catch(() => {});
    }

    // 5. Transcription on the combined audio.
    let segments = [];
    if (opts.transcript) {
      step(`Transcribing with whisper.cpp (model: ${opts.model})`);
      info("this can take a while on longer videos…");
      const prefix = path.join(dirs.transcript, "transcript");
      const wargs = [
        "-m", modelPath, "-f", audioPath,
        "-otxt", "-osrt", "-oj", "-of", prefix,
      ];
      if (opts.language) wargs.push("-l", opts.language);
      await exec(whisper.bin, wargs, { quiet: false });
      segments = await parseTranscript(`${prefix}.json`);
      done(`${segments.length} segments → transcript/transcript.{txt,srt,json}`);
    } else {
      await fs.rmdir(dirs.transcript).catch(() => {});
    }

    // 6. Contact sheet.
    let contactSheetFile = null;
    if (opts.frames && opts.contact > 0 && frames.length) {
      step(`Building contact sheet (${Math.min(opts.contact, frames.length)} frames)`);
      const out = path.join(outDir, "contact_sheet.jpg");
      await buildContactSheet(ffmpeg, frames, dirs.frames, out, {
        count: opts.contact,
        multiSource: sources.length > 1,
      });
      contactSheetFile = "contact_sheet.jpg";
      done("contact_sheet.jpg");
    }

    // 7. Reports.
    step("Writing index.md + report.html");
    const generated = new Date(parseInt(process.env.V2C_NOW || Date.now(), 10))
      .toISOString()
      .replace("T", " ")
      .slice(0, 16);
    await writeIndex({
      outDir, title, sources, totalDuration, frames, opts,
      hasContactSheet: !!contactSheetFile,
    });
    await writeHtmlReport({
      outDir, title, sources, totalDuration, frames, segments, opts,
      contactSheetFile, generated,
    });
    done("index.md, report.html");

    // 8. Agent-friendly manifest.
    await printManifest({ outDir, dirs, sources, frames, opts, contactSheetFile, audioPath });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function extractAudio(ffmpeg, sources, audioPath, tmp) {
  const wavs = [];
  for (const s of sources) {
    const w = path.join(tmp, `audio_${s.index}.wav`);
    await exec(ffmpeg, [
      "-y", "-i", s.path,
      "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
      w,
    ]);
    wavs.push(w);
  }
  if (wavs.length === 1) {
    await fs.copyFile(wavs[0], audioPath);
    return;
  }
  const listFile = path.join(tmp, "audio_list.txt");
  await fs.writeFile(
    listFile,
    wavs.map((w) => `file '${w.replace(/'/g, "'\\''")}'`).join("\n"),
    "utf8"
  );
  await exec(ffmpeg, [
    "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", audioPath,
  ]);
}

async function extractFrames(ffmpeg, sources, framesDir, tmp, opts) {
  const merged = [];
  let n = 0;
  for (const s of sources) {
    const srcTmp = path.join(tmp, `frames_${s.index}`);
    await fs.mkdir(srcTmp, { recursive: true });
    const local =
      opts.scene != null
        ? await extractScene(ffmpeg, s.path, srcTmp, opts.scene)
        : await extractInterval(ffmpeg, s.path, srcTmp, opts.interval);
    for (const f of local) {
      n++;
      const file = `frame_${String(n).padStart(4, "0")}.jpg`;
      await fs.rename(path.join(srcTmp, f.file), path.join(framesDir, file));
      merged.push({
        file,
        sourceIndex: s.index,
        localTime: f.time,
        globalTime: s.offset + (f.time ?? 0),
      });
    }
  }
  return merged;
}

async function extractInterval(ffmpeg, input, framesDir, interval) {
  await exec(ffmpeg, [
    "-y", "-i", input, "-vf", `fps=1/${interval}`, "-q:v", "2",
    path.join(framesDir, "frame_%04d.jpg"),
  ]);
  const files = (await fs.readdir(framesDir)).filter((f) => f.endsWith(".jpg")).sort();
  return files.map((file, idx) => ({ file, time: idx * interval }));
}

async function extractScene(ffmpeg, input, framesDir, threshold) {
  const { stderr } = await exec(ffmpeg, [
    "-y", "-i", input,
    "-vf", `select='gt(scene,${threshold})',showinfo`,
    "-vsync", "vfr", "-q:v", "2",
    path.join(framesDir, "scene_%04d.jpg"),
  ]);
  const times = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => parseFloat(m[1]));
  const files = (await fs.readdir(framesDir)).filter((f) => f.endsWith(".jpg")).sort();
  return files.map((file, idx) => ({ file, time: times[idx] ?? null }));
}

async function printManifest({ outDir, dirs, sources, frames, opts, contactSheetFile, audioPath }) {
  const produced = [["index", path.join(outDir, "index.md")]];
  produced.push(["report", path.join(outDir, "report.html")]);
  if (contactSheetFile) produced.push(["contact_sheet", path.join(outDir, contactSheetFile)]);
  if (opts.transcript) {
    for (const ext of ["txt", "srt", "json"]) {
      produced.push([`transcript_${ext}`, path.join(dirs.transcript, `transcript.${ext}`)]);
    }
  }
  produced.push(["audio", audioPath]);
  if (opts.frames) {
    for (const f of frames) produced.push(["frame", path.join(dirs.frames, f.file)]);
  }
  if (opts.copySource) {
    for (const s of sources) produced.push(["source", path.join(dirs.source, s.name)]);
  }

  const existing = [];
  for (const [kind, p] of produced) {
    if (await fs.stat(p).then(() => true).catch(() => false)) existing.push([kind, p]);
  }

  log(`\n\x1b[32m✓ Done.\x1b[0m  Context package ready at:\n  ${outDir}\n`);
  log(`\x1b[1mOutput files:\x1b[0m`);
  for (const [kind, p] of existing) log(`  ${kind.padEnd(15)} ${p}`);
  log("");
}
