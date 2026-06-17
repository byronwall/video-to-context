import { spawn } from "node:child_process";

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
};

export function log(msg) {
  console.log(msg);
}

export function step(msg) {
  console.log(`${c.cyan}${c.bold}›${c.reset} ${msg}`);
}

export function done(msg) {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}

export function info(msg) {
  console.log(`  ${c.dim}${msg}${c.reset}`);
}

export function warn(msg) {
  console.log(`${c.yellow}!${c.reset} ${msg}`);
}

/**
 * Run a command, streaming its output. Resolves on exit code 0, rejects otherwise.
 * Captures stderr so callers can inspect it (e.g. ffmpeg showinfo).
 */
export function exec(cmd, args, { capture = false, quiet = true, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", quiet ? "pipe" : "inherit", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      if (!capture && !quiet) process.stderr.write(d);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.trim().split("\n").slice(-8).join("\n");
        reject(new Error(`\`${cmd}\` exited with code ${code}\n${tail}`));
      }
    });
  });
}

/** Seconds -> HH:MM:SS */
export function fmtTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
