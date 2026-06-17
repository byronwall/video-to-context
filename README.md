# video-to-context

Turn screen recordings into a structured, **digestible** context package —
a timestamped transcript, screenshots, a single-image **contact sheet**, and a
self-contained **HTML report** tying it all together — using **local** FFmpeg
and whisper.cpp. No API calls, no uploads.

The resulting folder is the artifact you hand to a person or an LLM/agent when
you want to understand or ask questions over a walkthrough. On completion the
CLI prints a flat list of every produced file so an agent can consume them
directly.

## Install

Prerequisites (Homebrew):

```bash
brew install ffmpeg whisper-cpp
```

Then install the CLI globally:

```bash
cd video-to-context
npm install -g .      # or: npm link
```

This exposes two commands: `video-to-context` and the short alias `v2c`.

Whisper models are downloaded and cached automatically on first use under
`~/.cache/video-to-context/models/`.

## Usage

```bash
video-to-context [input] [options]
```

`input` may be:

- a **video file** — processed on its own
- a **directory** — every eligible video in it (non-recursive) is concatenated
  into one timeline, with full lineage back to each source file
- **omitted** — defaults to the current directory

So you can `cd ~/Desktop && video-to-context` to bundle every recording on your
Desktop into one digestible package.

| Option | Description |
|---|---|
| `-o, --output <dir>` | Output directory (default: `<name>-context`) |
| `-m, --model <name>` | Whisper model: `tiny(.en)`, `base(.en)`, `small(.en)`, `medium(.en)`, `large-v3`, `large-v3-turbo`, or a path to a `ggml-*.bin` (default: `base.en`) |
| `-l, --language <code>` | Spoken-language hint, e.g. `en` (default: auto-detect) |
| `--interval <sec>` | Seconds between screenshots (default: `10`) |
| `--scene [thresh]` | Scene-change detection instead of fixed interval (0..1, default `0.08`) |
| `--contact <n>` | Frames in the contact sheet (default: `25`; `0` disables) |
| `--no-source` | Don't copy source video(s) into the package |
| `--no-frames` | Skip screenshot extraction |
| `--no-transcript` | Skip transcription |
| `-f, --force` | Overwrite an existing output directory |
| `-h, --help` | Show help |

### Examples

```bash
# Every video in the current folder, concatenated with lineage
video-to-context

# A single recording
video-to-context demo.mov

# Concatenate everything on the Desktop, higher-accuracy transcript
video-to-context ~/Desktop -m medium

# Mostly-static UI: only capture meaningful screen changes
video-to-context demo.mov --scene 0.05 -o ./demo-context
```

## Output structure

```
demo-context/
  report.html              # ← open this: report + contact sheet + gallery + transcript
  contact_sheet.jpg        # 25 timestamped thumbnails in one image
  index.md                 # plain-text/markdown index (lineage + links)
  source/                  # copies of the original video(s) (omit with --no-source)
  audio/audio.wav          # mono 16 kHz extracted audio (concatenated)
  frames/frame_0001.jpg …  # screenshots across the whole timeline
  transcript/
    transcript.txt         # plain text
    transcript.srt         # timestamped
    transcript.json        # structured, for scripting/search
```

### Lineage (directory / multi-video mode)

When multiple videos are combined, every screenshot and transcript segment
records both its **global** time on the combined timeline and the **source**
file + local time it came from. The HTML report and `index.md` both show a
lineage table (which file occupies which time range), and the contact sheet
labels each thumbnail with its source (e.g. `S2`).

## Model guidance

Start with `base.en` (fast, small download). If product names or jargon come
out wrong, rerun with `-m medium` or `-m large-v3-turbo`.
