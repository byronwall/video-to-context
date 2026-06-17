import fs from "node:fs/promises";
import path from "node:path";
import { fmtTime } from "./util.js";
import { sourceAt } from "./sources.js";

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Parse whisper.cpp JSON into [{ t (sec), text }]. */
export async function parseTranscript(jsonPath) {
  try {
    const raw = await fs.readFile(jsonPath, "utf8");
    const data = JSON.parse(raw);
    const segs = data.transcription || [];
    return segs
      .map((s) => ({
        t: (s.offsets?.from ?? 0) / 1000,
        text: (s.text || "").trim(),
      }))
      .filter((s) => s.text);
  } catch {
    return [];
  }
}

/** Markdown index — quick, plain, agent-readable. */
export async function writeIndex({
  outDir, title, sources, totalDuration, frames, opts, hasContactSheet,
}) {
  const multi = sources.length > 1;
  const L = [];
  L.push(`# ${title} — context package\n`);
  L.push(`- **Duration:** ${fmtTime(totalDuration)}`);
  L.push(`- **Sources:** ${sources.length}`);
  if (frames.length) L.push(`- **Screenshots:** ${frames.length}`);
  L.push(`- **Report:** \`report.html\` (open in a browser)`);
  if (hasContactSheet) L.push(`- **Contact sheet:** \`contact_sheet.jpg\``);
  L.push("");

  L.push(`## Sources / lineage\n`);
  L.push(`| # | File | Starts at | Duration |`);
  L.push(`|---|------|-----------|----------|`);
  for (const s of sources) {
    L.push(
      `| ${s.index + 1} | \`${s.name}\` | ${fmtTime(s.offset)} | ${fmtTime(
        s.duration
      )} |`
    );
  }
  L.push("");

  if (opts.transcript) {
    L.push(`## Transcript\n`);
    L.push(`- Plain text: \`transcript/transcript.txt\``);
    L.push(`- Timestamped (SRT): \`transcript/transcript.srt\``);
    L.push(`- Structured (JSON): \`transcript/transcript.json\`\n`);
  }

  if (opts.frames && frames.length) {
    const mode =
      opts.scene != null
        ? `scene-change detection (threshold ${opts.scene})`
        : `every ${opts.interval} seconds`;
    L.push(`## Screenshots\n`);
    L.push(`Extracted via ${mode}.\n`);
    L.push(`| Time | ${multi ? "Source | " : ""}Image |`);
    L.push(`|------|${multi ? "--------|" : ""}-------|`);
    for (const f of frames) {
      const srcCol = multi ? ` S${f.sourceIndex + 1} (${fmtTime(f.localTime)}) |` : "";
      L.push(`| ${fmtTime(f.globalTime)} |${srcCol} ![${fmtTime(f.globalTime)}](frames/${f.file}) |`);
    }
    L.push("");
  }

  await fs.writeFile(path.join(outDir, "index.md"), L.join("\n"), "utf8");
}

/** Self-contained HTML report tying everything together. */
export async function writeHtmlReport({
  outDir, title, sources, totalDuration, frames, segments, opts,
  contactSheetFile, generated,
}) {
  const multi = sources.length > 1;

  const meta = `
    <div class="meta">
      <span><b>${fmtTime(totalDuration)}</b> total</span>
      <span><b>${sources.length}</b> source${sources.length > 1 ? "s" : ""}</span>
      <span><b>${frames.length}</b> screenshots</span>
      <span><b>${segments.length}</b> transcript segments</span>
      <span class="dim">generated ${esc(generated)}</span>
    </div>`;

  const lineage = `
    <section>
      <h2>Sources &amp; lineage</h2>
      <table class="lineage">
        <thead><tr><th>#</th><th>File</th><th>Starts at</th><th>Duration</th></tr></thead>
        <tbody>
        ${sources
          .map(
            (s) => `<tr>
            <td>${s.index + 1}</td>
            <td><code>${esc(s.name)}</code></td>
            <td>${fmtTime(s.offset)}</td>
            <td>${fmtTime(s.duration)}</td>
          </tr>`
          )
          .join("\n")}
        </tbody>
      </table>
    </section>`;

  const contact = contactSheetFile
    ? `<section>
        <h2>Contact sheet</h2>
        <p class="dim">One frame sampled across the timeline — scan it to find a moment of interest, then jump to the screenshots or transcript below.</p>
        <a href="${esc(contactSheetFile)}" target="_blank"><img class="contact" src="${esc(contactSheetFile)}" alt="contact sheet"></a>
      </section>`
    : "";

  const haveFrames = opts.frames && frames.length > 0;
  const haveText = opts.transcript && segments.length > 0;

  // Interleaved walkthrough: each screenshot paired with the narration spoken
  // during its window (from its timestamp until the next screenshot).
  let body = "";
  if (haveFrames && haveText) {
    let lastSrc = -1;
    body = `<section>
      <h2>Walkthrough</h2>
      <p class="dim">Each screenshot is paired with the narration spoken while it was on screen.</p>
      ${frames
        .map((f, i) => {
          const start = i === 0 ? -Infinity : f.globalTime;
          const end = i + 1 < frames.length ? frames[i + 1].globalTime : Infinity;
          const segs = segments.filter((s) => s.t >= start && s.t < end);
          const { source, localTime } = sourceAt(sources, f.globalTime);
          let divider = "";
          if (multi && source.index !== lastSrc) {
            lastSrc = source.index;
            divider = `<div class="srcdivider">▶ ${esc(source.name)}</div>`;
          }
          const tag = multi
            ? `<span class="src">S${source.index + 1} · ${fmtTime(localTime)}</span>`
            : "";
          const lines =
            segs
              .map(
                (s) =>
                  `<p><span class="ts">${fmtTime(s.t)}</span> ${esc(s.text)}</p>`
              )
              .join("\n") || `<p class="dim">(no narration)</p>`;
          return `${divider}<div class="row">
            <a class="shot" href="frames/${esc(f.file)}" target="_blank">
              <img loading="lazy" src="frames/${esc(f.file)}" alt="${fmtTime(f.globalTime)}">
              <span class="cap"><span class="ts">${fmtTime(f.globalTime)}</span>${tag}</span>
            </a>
            <div class="lines">${lines}</div>
          </div>`;
        })
        .join("\n")}
    </section>`;
  } else if (haveText) {
    let lastSrc = -1;
    body = `<section>
      <h2>Transcript</h2>
      <div class="transcript">
      ${segments
        .map((s) => {
          const { source, localTime } = sourceAt(sources, s.t);
          let divider = "";
          if (multi && source.index !== lastSrc) {
            lastSrc = source.index;
            divider = `<div class="srcdivider">▶ ${esc(source.name)}</div>`;
          }
          const tag = multi
            ? ` <span class="src">S${source.index + 1} · ${fmtTime(localTime)}</span>`
            : "";
          return `${divider}<p><span class="ts">${fmtTime(s.t)}</span>${tag} ${esc(s.text)}</p>`;
        })
        .join("\n")}
      </div>
    </section>`;
  } else if (haveFrames) {
    body = `<section>
      <h2>Screenshots</h2>
      <div class="grid">
      ${frames
        .map((f) => {
          const tag = multi
            ? `<span class="src">S${f.sourceIndex + 1} · ${fmtTime(f.localTime)}</span>`
            : "";
          return `<figure>
            <a href="frames/${esc(f.file)}" target="_blank"><img loading="lazy" src="frames/${esc(f.file)}" alt="${fmtTime(f.globalTime)}"></a>
            <figcaption><span class="ts">${fmtTime(f.globalTime)}</span>${tag}</figcaption>
          </figure>`;
        })
        .join("\n")}
      </div>
    </section>`;
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — video context</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --fg:#e6e8eb; --dim:#9aa3af; --accent:#6ea8fe; --line:#2a2f3a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  header { padding:28px 32px 20px; border-bottom:1px solid var(--line); position:sticky; top:0; background:linear-gradient(var(--bg),rgba(15,17,21,.92)); backdrop-filter:blur(6px); z-index:5; }
  h1 { margin:0 0 10px; font-size:22px; }
  h2 { font-size:17px; margin:0 0 14px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  .meta { display:flex; flex-wrap:wrap; gap:16px; color:var(--dim); font-size:13px; }
  .meta b { color:var(--fg); }
  main { max-width:1100px; margin:0 auto; padding:24px 32px 80px; }
  section { margin:34px 0; }
  .dim { color:var(--dim); }
  code { background:var(--panel); padding:1px 6px; border-radius:4px; font-size:13px; }
  table.lineage { border-collapse:collapse; width:100%; font-size:14px; }
  table.lineage th, table.lineage td { text-align:left; padding:7px 12px; border-bottom:1px solid var(--line); }
  table.lineage th { color:var(--dim); font-weight:600; }
  img.contact { width:100%; border-radius:10px; border:1px solid var(--line); display:block; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:14px; }
  figure { margin:0; background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  figure img { width:100%; display:block; aspect-ratio:16/9; object-fit:cover; }
  figcaption { padding:7px 10px; font-size:12px; display:flex; justify-content:space-between; align-items:center; gap:8px; }
  .ts { font-variant-numeric:tabular-nums; color:var(--accent); font-weight:600; }
  .src { color:var(--dim); font-size:11px; }
  .transcript { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:8px 18px; }
  .transcript p { margin:9px 0; }
  .transcript .ts { margin-right:8px; }
  .srcdivider { margin:22px 0 6px; padding-top:14px; border-top:1px dashed var(--line); color:var(--dim); font-weight:600; font-size:13px; }
  .row { display:flex; gap:20px; padding:16px 0; border-bottom:1px solid var(--line); align-items:flex-start; }
  .shot { flex:0 0 340px; max-width:340px; display:block; border:1px solid var(--line); border-radius:10px; overflow:hidden; background:var(--panel); position:sticky; top:104px; }
  .shot img { width:100%; display:block; aspect-ratio:16/9; object-fit:cover; }
  .shot .cap { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 10px; font-size:12px; }
  .lines { flex:1; min-width:0; padding-top:2px; }
  .lines p { margin:8px 0; }
  .lines .ts { margin-right:8px; }
  a { color:var(--accent); text-decoration:none; }
  @media (max-width:680px) {
    .row { flex-direction:column; gap:10px; }
    .shot { position:static; flex-basis:auto; max-width:100%; width:100%; }
  }
</style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  ${meta}
</header>
<main>
  ${lineage}
  ${contact}
  ${body}
</main>
</body>
</html>`;

  await fs.writeFile(path.join(outDir, "report.html"), html, "utf8");
}
