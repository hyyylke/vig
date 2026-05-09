#!/usr/bin/env node
/**
 * vig — Static site generator for a personal video gallery
 *
 * Recursively scans videos/ for .mp4/.mov/.webm/.m4v files and generates
 * a static site with a Datastar-powered feed + grid browser.
 */

import { readdir, readFile, writeFile, mkdir, copyFile, symlink, readlink, link, lstat, rm, stat } from "fs/promises";
import { join, extname, basename, dirname, relative, resolve, sep, posix, isAbsolute } from "path";
import { existsSync } from "fs";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { renderTemplate } from "./src/lib/template.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────
// All paths are env-driven so the CLI (cli.js) can point them at .vig/site
// and .vig/meta inside the user's content folder. Defaults assume direct
// invocation from the vig project root.
const CONTENT_DIR = process.env.VIG_VIDEOS || process.cwd();
const OUT_DIR = process.env.VIG_SITE || "_site";
const META_ROOT = process.env.VIG_META || join(OUT_DIR, "meta");
const PLAYER_SRC = process.env.VIG_PLAYER_SRC || join(__dirname, "vig-player.js");
const POST_DIR = "post"; // subfolder of OUT_DIR
const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".m4v"]);
const IGNORE_NAMES = new Set([".DS_Store", "node_modules", "_site", ".vig"]);

function postOutDir(slug) {
  return join(OUT_DIR, POST_DIR, slug);
}
function metaOutDir(slug) {
  return join(META_ROOT, slug);
}
function videoFileName(originalFilename) {
  return "video" + extname(originalFilename);  // preserves source extension for MIME type
}

// ─── Walker ──────────────────────────────────────────────────────────────────

async function walkVideos(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (IGNORE_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);

    // readdir with withFileTypes returns Dirents whose .isDirectory()/.isFile()
    // refer to the link itself for symlinks — so a symlink to a folder reports
    // isDirectory()=false. Follow symlinks via stat() so users can drop a link
    // to e.g. an external drive into the content folder and have it scanned.
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const t = await stat(full);
        isDir = t.isDirectory();
        isFile = t.isFile();
      } catch {
        continue; // dangling symlink — skip silently
      }
    }

    if (isDir) {
      const nested = await walkVideos(full, base);
      out.push(...nested);
    } else if (isFile && VIDEO_EXTS.has(extname(entry.name).toLowerCase())) {
      const rel = relative(base, full).split(sep).join("/"); // posix for URLs
      const parentRel = dirname(rel) === "." ? "" : dirname(rel);
      const s = await stat(full);

      out.push({
        filename: entry.name,
        relPath: rel,            // "folder/sub/video.mp4"
        folder: parentRel,       // "folder/sub" (may be "")
        size: s.size,
        mtime: s.mtime.toISOString(),
      });
    }
  }
  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Single-line live progress, only when stdout is a TTY (so piped/spawned
// builds don't get \r escapes mixed into their logs).
function progress(line) {
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[K" + line);
}
function progressClear() {
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
}
function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function slugify(str) {
  let s = String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  // Slug must be non-empty AND start with [a-z0-9] (matches the API's SLUG_RE).
  // Sources with all-special-character names (e.g. "###.mp4") would otherwise
  // produce an empty slug and land at _site/post/video.mp4 instead of in a folder.
  if (!s) s = "untitled";
  if (!/^[a-z0-9]/.test(s)) s = "v-" + s;
  return s;
}

function titleFromFilename(filename) {
  const stem = filename.replace(/\.[^.]+$/, "");
  return stem.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
}

function formatBytes(n) {
  if (n >= 1_073_741_824) return (n / 1_073_741_824).toFixed(1).replace(/\.0$/, "") + " GB";
  if (n >= 1_048_576) return (n / 1_048_576).toFixed(1).replace(/\.0$/, "") + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}

function timeAgo(dateStr) {
  const now = new Date();
  const d = new Date(dateStr);
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m";
  if (diff < 86400) return Math.floor(diff / 3600) + "h";
  if (diff < 604800) return Math.floor(diff / 86400) + "d";
  if (diff < 31536000) return Math.floor(diff / 604800) + "w";
  return Math.floor(diff / 31536000) + "y";
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function folderLabel(folder) {
  return folder ? folder : "root";
}

function folderInitial(folder) {
  const label = folderLabel(folder);
  return label[0]?.toUpperCase() || "?";
}

// URL-encode a relative path's individual segments (preserves "/"), so filenames
// with spaces, "#", "?", "&", etc. resolve correctly when the browser fetches them.
function encodePath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

// Cumulative offsets of each clip within the stitched preview.mp4 (in seconds).
// Used by the JS so it can map preview.mp4 currentTime back to the right
// source-video timestamp when updating the deep-link href.
function previewCums(plan) {
  if (!plan || !Array.isArray(plan.ranges)) return [];
  const out = [];
  let cum = 0;
  for (const r of plan.ranges) {
    out.push(cum);
    cum += r.duration;
  }
  return out;
}

// Deterministic hash from a slug — same input always yields the same number,
// so layout decisions (e.g. which horizontal gets a big 2x2 tile) don't shift
// between rebuilds. djb2-style; modulo a small N gives stable bucketing.
function slugHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0;
  return Math.abs(h);
}


// ─── ffmpeg: poster frame extraction ─────────────────────────────────────────

function spawnCapture(cmd, args) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    // stdin: ignore — ffmpeg occasionally misbehaves when its stdin is an open
    // pipe nobody writes to (especially when this process itself was spawned
    // without a controlling terminal, as the dev server does).
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", () => resolve({ code: -1, out, err: "command not found" }));
    proc.on("close", (code) => resolve({ code, out, err }));
  });
}

async function checkFfmpeg() {
  const r = await spawnCapture("ffmpeg", ["-version"]);
  if (r.code === 0) {
    // First-line of `ffmpeg -version` is e.g. "ffmpeg version 6.1 …".
    // Logging it surfaces the case where `npm run dev` finds a different
    // ffmpeg via $PATH than your interactive shell does.
    const which = await spawnCapture("which", ["ffmpeg"]);
    const verLine = (r.out || "").split("\n")[0];
    console.log(`  ffmpeg:   ${which.out.trim() || "?"}  (${verLine})`);
  }
  return r.code === 0;
}

// One ffprobe call returns everything we need: duration, dimensions, framerate,
// and bitrate. The bits-per-pixel-per-second derived from those drives the
// adaptive encoder picks below.
async function getMetadata(srcPath) {
  const r = await spawnCapture("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate,bit_rate:format=duration,bit_rate",
    "-of", "json",
    srcPath,
  ]);
  if (r.code !== 0) return null;
  let parsed;
  try { parsed = JSON.parse(r.out); } catch { return null; }
  const stream = parsed?.streams?.[0];
  const format = parsed?.format;
  if (!stream || !format) return null;

  const duration = parseFloat(format.duration);
  const width = parseInt(stream.width, 10);
  const height = parseInt(stream.height, 10);
  const fps = parseFraction(stream.r_frame_rate) || 30;
  const bitrate = parseInt(stream.bit_rate || format.bit_rate || "0", 10);
  const bpp = (width && height && fps && bitrate) ? bitrate / (width * height * fps) : 0;

  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    width: width || null,
    height: height || null,
    fps,
    bitrate,
    bpp,
  };
}

function parseFraction(s) {
  if (!s) return 0;
  const parts = String(s).split("/");
  if (parts.length === 2) {
    const n = parseFloat(parts[0]);
    const d = parseFloat(parts[1]);
    if (d > 0 && Number.isFinite(n) && Number.isFinite(d)) return n / d;
  }
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}

// Adaptive encoder settings — match the encode quality to the source so we don't
// add more compression artifacts on top of an already-grainy input. Thresholds
// are bits per pixel per second:
//   ≥0.10  : modern good-source (Netflix-tier) → slight compression OK
//   ≥0.04  : decent source                     → moderate quality
//   ≥0.02  : low-bitrate source                → preserve detail, tune for grain
//   <0.02  : very low bitrate                  → nearly transparent, tune for grain
const ENCODER_TIERS = {
  high:       { crf: 24, preset: "medium", tune: null },
  medium:     { crf: 22, preset: "medium", tune: null },
  low:        { crf: 20, preset: "slow",   tune: "grain" },
  "very-low": { crf: 18, preset: "slow",   tune: "grain" },
  unknown:    { crf: 23, preset: "medium", tune: null },
};

function qualityTier(meta) {
  if (!meta || !meta.bpp) return "unknown";
  if (meta.bpp >= 0.10) return "high";
  if (meta.bpp >= 0.04) return "medium";
  if (meta.bpp >= 0.02) return "low";
  return "very-low";
}

// Preview layout: every video gets poster.jpg + N short MP4 clips (01.mp4..NN.mp4).
// Auto mode (no sidecar) samples evenly; user-shots mode uses the user's ranges.
const AUTO_PERCENTS = [0.20, 0.40, 0.60, 0.80];
const AUTO_CLIP_SECONDS = 1.8;           // length of each auto-mode clip
const SHORT_VIDEO_THRESHOLD = 10;        // shorter than this → single full-video clip
const MAX_USER_CLIPS = 8;                // cap cycling clips per card
const MAX_CLIP_SECONDS = 8;              // cap user-shot clip length

// Target the SHORT side of the frame (not the width) — ensures portrait and
// landscape videos both get enough pixels to fill the feed card crisply. Grid
// cells downscale cleanly from this; feed cards at ~470px get a sharp preview
// even on retina displays.
const PREVIEW_SHORT_SIDE = 720;
const PREVIEW_SCALE = `scale=w='if(gt(iw,ih),-2,${PREVIEW_SHORT_SIDE})':h='if(gt(iw,ih),${PREVIEW_SHORT_SIDE},-2)'`;

// VIG_DEBUG=1 streams every ffmpeg/ffprobe invocation (args + stderr) to the
// console — useful when previews come out wrong and you need to see exactly
// what's being run.
const DEBUG = !!process.env.VIG_DEBUG;

async function extractFrameAt(srcPath, destPath, seekSeconds) {
  await mkdir(dirname(destPath), { recursive: true });
  const args = [
    "-y", "-loglevel", "error",
    "-nostdin",                  // critical: without this ffmpeg can misbehave when stdin is a pipe (non-TTY)
    "-ss", String(seekSeconds),  // fast seek (before -i)
    "-i", srcPath,
    "-vframes", "1",
    "-vf", PREVIEW_SCALE,
    "-q:v", "4",
    destPath,
  ];
  if (DEBUG) console.log(`[debug] extractFrameAt: ffmpeg ${args.join(" ")}`);
  const r = await spawnCapture("ffmpeg", args);
  if (DEBUG && r.err) console.log(`[debug] stderr:\n${r.err.split("\n").map((l) => "    " + l).join("\n")}`);
  return r.code === 0;
}

async function extractClip(srcPath, destPath, startSec, durationSec, settings) {
  await mkdir(dirname(destPath), { recursive: true });
  // Single -ss before -i. With re-encode (-c:v libx264) modern ffmpeg does
  // keyframe seek + accurate trim by default; +genpts regenerates timestamps
  // for sources whose PTS was broken (which is what was making subsequent clips
  // come out as 1-frame: ffmpeg's accurate-seek logic relies on sane PTS).
  const args = [
    "-y", "-loglevel", "error",
    "-nostdin",                  // critical: without this ffmpeg can misbehave when stdin is a pipe (non-TTY)
    "-fflags", "+genpts",
    "-ss", String(startSec),
    "-i", srcPath,
    "-t", String(durationSec),
    "-vf", PREVIEW_SCALE,
    "-c:v", "libx264",
    "-preset", settings.preset,
    "-crf", String(settings.crf),
  ];
  if (settings.tune) args.push("-tune", settings.tune);
  args.push(
    "-an",                      // strip audio — smaller files, no mute-on-autoplay hassle
    "-movflags", "+faststart",
    "-pix_fmt", "yuv420p",
    destPath,
  );
  if (DEBUG) console.log(`[debug] extractClip: ffmpeg ${args.join(" ")}`);
  const r = await spawnCapture("ffmpeg", args);
  if (DEBUG && r.err) console.log(`[debug] stderr:\n${r.err.split("\n").map((l) => "    " + l).join("\n")}`);
  if (r.code !== 0) {
    const stderr = (r.err || "").trim();
    console.warn(`  ffmpeg clip failed (start=${startSec.toFixed(2)}, dur=${durationSec.toFixed(2)})`);
    console.warn(`    src: ${srcPath}`);
    if (stderr) console.warn(`    err: ${stderr.split("\n").slice(-3).join(" | ")}`);
    return false;
  }
  // Sanity check: count actual packets — the container's reported duration can
  // lie when a clip has only one frame (header says full length, stream is empty).
  try {
    const probe = await spawnCapture("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-count_packets",
      "-show_entries", "stream=nb_read_packets",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      destPath,
    ]);
    const lines = probe.out.trim().split("\n");
    const nb = parseInt(lines[0], 10);
    const out = parseFloat(lines[1]);
    if (Number.isFinite(nb) && nb < 5 && durationSec > 0.5) {
      console.warn(`  BAD clip: ${destPath} only ${nb} packet${nb === 1 ? "" : "s"} (asked ${durationSec.toFixed(2)}s, start ${startSec.toFixed(2)})`);
      console.warn(`    src: ${srcPath}`);
      console.warn(`    ffmpeg args: ${args.join(" ")}`);
      console.warn(`    ffmpeg stderr:\n${(r.err || "(empty)").split("\n").map((l) => "      " + l).join("\n")}`);
    } else if (Number.isFinite(out) && out < durationSec * 0.5 && durationSec > 0.5) {
      console.warn(`  short clip: ${destPath} got ${out.toFixed(2)}s (asked ${durationSec.toFixed(2)}s, start ${startSec.toFixed(2)})`);
      console.warn(`    ffmpeg stderr:\n${(r.err || "(empty)").split("\n").map((l) => "      " + l).join("\n")}`);
    }
  } catch (probeErr) {
    console.warn(`  ffprobe check failed for ${destPath}: ${probeErr.message}`);
  }
  return true;
}

// Stitch the per-shot clips into a single preview.mp4 so the feed/grid card can
// loop through them with no black flash between source swaps. Uses ffmpeg's
// concat demuxer with -c copy, which is instant: it stitches the existing H.264
// streams without re-encoding (all clips share the same codec/scale settings).
async function concatClips(destDir, count) {
  if (count < 2) {
    // Single clip — just copy/link it as preview.mp4 (cheap, but skip if it'd be a no-op).
    const single = join(destDir, "01.mp4");
    const out = join(destDir, "preview.mp4");
    if (existsSync(single)) {
      await rm(out, { force: true });
      try { await link(single, out); } catch { await copyFile(single, out); }
      return true;
    }
    return false;
  }
  const listPath = join(destDir, ".concat-list.txt");
  const lines = [];
  for (let i = 1; i <= count; i++) {
    lines.push(`file '${String(i).padStart(2, "0")}.mp4'`);
  }
  await writeFile(listPath, lines.join("\n"));
  const concatArgs = [
    "-y", "-loglevel", "error",
    "-nostdin",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    "-movflags", "+faststart",
    join(destDir, "preview.mp4"),
  ];
  if (DEBUG) console.log(`[debug] concatClips: ffmpeg ${concatArgs.join(" ")}`);
  const r = await spawnCapture("ffmpeg", concatArgs);
  if (DEBUG && r.err) console.log(`[debug] stderr:\n${r.err.split("\n").map((l) => "    " + l).join("\n")}`);
  await rm(listPath, { force: true });
  return r.code === 0;
}

// Peak-finding from a heat sidecar: pick the N hottest non-overlapping points
// in the buckets array and return clip windows centred on each. Returns null
// when the heat is empty or doesn't have any signal worth deriving from.
function deriveClipsFromHeat(heat, { count = AUTO_PERCENTS.length, clipDuration = AUTO_CLIP_SECONDS, minPeak = 1 } = {}) {
  if (!heat || !Array.isArray(heat.buckets) || heat.buckets.length === 0) return null;
  const bs = heat.bucketSize || 1;
  const work = heat.buckets.slice();
  let max = 0;
  for (const v of work) if (v > max) max = v;
  if (max < minPeak) return null;

  // Exclusion zone around each pick — keeps derived clips spread out instead
  // of clustering on the front of a flat-but-watched stretch.
  const exclusion = Math.max(1, Math.round((clipDuration * 5) / bs));
  const halfDur = clipDuration / 2;
  const clips = [];

  for (let n = 0; n < count; n++) {
    let maxIdx = -1, maxVal = 0;
    for (let i = 0; i < work.length; i++) {
      if (work[i] > maxVal) { maxVal = work[i]; maxIdx = i; }
    }
    if (maxIdx < 0 || maxVal < minPeak) break;

    const center = (maxIdx + 0.5) * bs;
    clips.push({ start: Math.max(0, center - halfDur), end: center + halfDur });

    const lo = Math.max(0, maxIdx - exclusion);
    const hi = Math.min(work.length, maxIdx + exclusion);
    for (let i = lo; i < hi; i++) work[i] = 0;
  }

  if (clips.length === 0) return null;
  clips.sort((a, b) => a.start - b.start);
  return clips;
}

// Work out what clips to make for this post — source of truth for both generation
// and idempotent cleanup. Returns { ranges: [{start, duration}], posterAt: seconds }.
function previewPlan(post, duration) {
  if (post.shots && post.shots.length > 0) {
    const shots = post.shots.slice(0, MAX_USER_CLIPS);
    return {
      ranges: shots.map((s) => ({
        start: s.start,
        duration: Math.min(s.end - s.start, MAX_CLIP_SECONDS),
      })),
      posterAt: (shots[0].start + shots[0].end) / 2,
    };
  }

  // No manual shots — try the heat sidecar before falling back to fixed percentages.
  const derived = deriveClipsFromHeat(post.heat);
  if (derived) {
    return {
      ranges: derived.map((c) => ({ start: c.start, duration: c.end - c.start })),
      posterAt: (derived[0].start + derived[0].end) / 2,
    };
  }

  if (duration && duration < SHORT_VIDEO_THRESHOLD) {
    // Tiny clip: one full-video snippet that loops natively in the card.
    return {
      ranges: [{ start: 0, duration }],
      posterAt: duration * 0.4,
    };
  }
  if (duration) {
    return {
      ranges: AUTO_PERCENTS.map((p) => ({
        start: Math.max(0.1, duration * p),
        duration: AUTO_CLIP_SECONDS,
      })),
      posterAt: duration * 0.4,
    };
  }
  // Probe failed — guess.
  return {
    ranges: [0.5, 2.5, 4.5, 6.5].map((t) => ({ start: t, duration: AUTO_CLIP_SECONDS })),
    posterAt: 2.5,
  };
}

function expectedPreviewFiles(plan) {
  const files = ["poster.jpg", "preview.mp4"];
  for (let i = 0; i < plan.ranges.length; i++) {
    files.push(`${String(i + 1).padStart(2, "0")}.mp4`);
  }
  return files;
}

async function extractPreviews(post, srcPath, destDir, meta) {
  const tier = qualityTier(meta);
  const settings = ENCODER_TIERS[tier];
  const plan = previewPlan(post, meta?.duration);

  const posterOk = await extractFrameAt(srcPath, join(destDir, "poster.jpg"), plan.posterAt);
  // Serial extraction (was Promise.all) — concurrent ffmpegs on the same source
  // produced 1-frame clips for non-faststart inputs where each process has to
  // re-read the moov atom from file-end. The first clip would succeed and the
  // rest would land badly. Serial costs ~1-2s extra per video; reliability wins.
  const clipResults = [];
  for (let i = 0; i < plan.ranges.length; i++) {
    const r = plan.ranges[i];
    const dest = join(destDir, `${String(i + 1).padStart(2, "0")}.mp4`);
    clipResults.push(await extractClip(srcPath, dest, r.start, r.duration, settings));
  }

  // Stitch the clips into a single seamless preview.mp4 (no re-encode, just
  // concat). This is what the feed/grid card actually plays — looping a single
  // file means no black flash between cycles.
  let concatOk = false;
  if (clipResults.every(Boolean)) {
    concatOk = await concatClips(destDir, plan.ranges.length);
  }

  post.previewCount = plan.ranges.length;
  post.previewPlan = plan;
  post.qualityTier = tier;
  return posterOk && concatOk;
}

// ─── Build dependency tracking ───────────────────────────────────────────────
// A per-video manifest (.build-meta.json) records what produced the existing
// previews: the source/sidecar mtimes AND a hash of the encoding pipeline.
// If any of those change — including pure code edits to the extract functions
// or their constants — the affected videos re-encode on next build.

const BUILD_META_NAME = ".build-meta.json";

function getPipelineHash() {
  // Hash only the encoder-relevant code: layout/CSS edits stay cheap, but a
  // tweak to scale/CRF/clip-length or the heat-derivation algorithm forces a
  // rebuild of every video.
  const sources = [
    extractFrameAt.toString(),
    extractClip.toString(),
    concatClips.toString(),
    extractPreviews.toString(),
    previewPlan.toString(),
    expectedPreviewFiles.toString(),
    deriveClipsFromHeat.toString(),
    qualityTier.toString(),
    `ENCODER_TIERS=${JSON.stringify(ENCODER_TIERS)}`,
    `PREVIEW_SCALE=${PREVIEW_SCALE}`,
    `PREVIEW_SHORT_SIDE=${PREVIEW_SHORT_SIDE}`,
    `MAX_CLIP_SECONDS=${MAX_CLIP_SECONDS}`,
    `AUTO_CLIP_SECONDS=${AUTO_CLIP_SECONDS}`,
    `SHORT_VIDEO_THRESHOLD=${SHORT_VIDEO_THRESHOLD}`,
    `MAX_USER_CLIPS=${MAX_USER_CLIPS}`,
    `AUTO_PERCENTS=${AUTO_PERCENTS.join(",")}`,
  ];
  return createHash("sha256").update(sources.join("\n")).digest("hex").slice(0, 16);
}

async function readBuildMeta(dir) {
  const path = join(dir, BUILD_META_NAME);
  if (!existsSync(path)) return null;
  try { return JSON.parse(await readFile(path, "utf-8")); } catch { return null; }
}

async function writeBuildMeta(dir, meta) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, BUILD_META_NAME), JSON.stringify(meta, null, 2));
}

async function generateThumbs(posts) {
  const ok = await checkFfmpeg();
  if (!ok) {
    console.log("  ffmpeg not found on PATH — skipping previews");
    console.log("  (grid view will show folder-initial placeholders; install via `brew install ffmpeg`)");
    return false;
  }

  const pipelineHash = getPipelineHash();

  let generated = 0, skipped = 0, failed = 0, fromShots = 0;
  const tierCounts = {};

  // Phase 1: gather state for all posts in parallel. Pure I/O — read each
  // post's .build-meta.json, decide if it's cached. ffprobe and hash are only
  // called when needed (cache miss / mtime mismatch).
  let phase1Done = 0;
  const states = await Promise.all(posts.map(async (post) => {
    const srcPath = join(CONTENT_DIR, post.relPath);
    const destDir = post.outDir;
    const srcMs = new Date(post.mtime).getTime();
    const sidecarMs = post.sidecarMtime || 0;
    const heatMs = post.heatMtime || 0;

    const buildMeta = await readBuildMeta(destDir);
    const mtimeMatches = !!(buildMeta && buildMeta.srcMtime === srcMs);

    // mtime-touch fallback: if mtime moved but file size is identical to the
    // cached size, the content is virtually certainly unchanged (Spotlight,
    // Time Machine, Drive Sync, etc. touch mtimes without writing bytes).
    // For videos especially, two distinct files happening to have the exact
    // same byte count is so unlikely it's not worth hashing for.
    let mtimeRefresh = false;
    let contentUnchanged = mtimeMatches;
    if (!mtimeMatches && buildMeta && buildMeta.srcSize === post.size) {
      contentUnchanged = true;
      mtimeRefresh = true;  // refresh mtime in manifest so next run takes the fast path
    }

    // Use cached metadata when source content is unchanged.
    let meta = null;
    if (contentUnchanged && buildMeta?.metadata) {
      meta = buildMeta.metadata;
    }

    let plan = null, expectedFiles = null, fresh = false;
    if (meta) {
      post.dimensions = meta.width && meta.height ? { w: meta.width, h: meta.height } : null;
      post.qualityTier = qualityTier(meta);

      plan = previewPlan(post, meta.duration);
      expectedFiles = expectedPreviewFiles(plan);

      const metaMatches = buildMeta
        && buildMeta.pipelineHash === pipelineHash
        && buildMeta.sidecarMtime === sidecarMs
        && buildMeta.heatMtime === heatMs
        && buildMeta.frameCount === plan.ranges.length;

      fresh = metaMatches;
      if (fresh) {
        for (const name of expectedFiles) {
          if (!existsSync(join(destDir, name))) { fresh = false; break; }
        }
      }
    }

    phase1Done++;
    progress(`  checking cache ${phase1Done}/${posts.length}`);
    return { post, srcPath, destDir, srcMs, sidecarMs, heatMs, meta, plan, expectedFiles, fresh, buildMeta, mtimeRefresh };
  }));
  progressClear();

  // Phase 2: handle the cached posts in parallel (just file housekeeping —
  // restore previewPlan onto the post so templates have it, and tidy any
  // stale stragglers in their dirs). If we verified content via hash because
  // mtime moved, also write back a refreshed manifest so the next build can
  // use the fast mtime path again.
  await Promise.all(states.filter((s) => s.fresh).map(async (s) => {
    s.post.hasThumb = true;
    s.post.previewCount = s.plan.ranges.length;
    s.post.previewPlan = s.plan;
    if (s.post.shots.length > 0) fromShots++;
    skipped++;
    tierCounts[s.post.qualityTier] = (tierCounts[s.post.qualityTier] || 0) + 1;
    await cleanupStaleFiles(s.destDir, s.expectedFiles);
    if (s.mtimeRefresh) {
      await writeBuildMeta(s.destDir, {
        ...s.buildMeta,
        srcMtime: s.srcMs,
      });
    }
  }));

  // Phase 3: stale posts — sequential because ffmpeg has trouble with
  // multiple concurrent encodes against the same source filesystem.
  const stale = states.filter((s) => !s.fresh);
  const phaseStart = Date.now();
  for (let i = 0; i < stale.length; i++) {
    const s = stale[i];
    const pct = stale.length > 0 ? Math.floor((i / stale.length) * 100) : 0;
    const elapsed = (Date.now() - phaseStart) / 1000;
    const eta = i > 0 ? (elapsed / i) * (stale.length - i) : null;
    const etaStr = eta != null ? `  · ~${formatDuration(eta)} left` : "";
    progress(`  encoding ${i + 1}/${stale.length} (${pct}%)${etaStr}  ${s.post.title}`);
    // No cached metadata? Probe now (this is the first time we see this video).
    if (!s.meta) {
      s.meta = await getMetadata(s.srcPath);
      s.post.dimensions = s.meta && s.meta.width && s.meta.height
        ? { w: s.meta.width, h: s.meta.height } : null;
      s.post.qualityTier = qualityTier(s.meta);
      s.plan = previewPlan(s.post, s.meta?.duration);
      s.expectedFiles = expectedPreviewFiles(s.plan);
    }
    tierCounts[s.post.qualityTier] = (tierCounts[s.post.qualityTier] || 0) + 1;

    await cleanupStaleFiles(s.destDir, s.expectedFiles);
    const success = await extractPreviews(s.post, s.srcPath, s.destDir, s.meta);
    if (success) {
      s.post.hasThumb = true;
      generated++;
      if (s.post.shots.length > 0) fromShots++;
      await writeBuildMeta(s.destDir, {
        pipelineHash,
        srcMtime: s.srcMs,
        srcSize: s.post.size,
        sidecarMtime: s.sidecarMs,
        heatMtime: s.heatMs,
        frameCount: s.plan.ranges.length,
        qualityTier: s.post.qualityTier,
        metadata: s.meta,
      });
    } else {
      failed++;
      console.warn(`  previews failed: ${s.post.relPath}`);
    }
  }
  progressClear();

  const parts = [];
  if (generated) parts.push(`${generated} new`);
  if (skipped) parts.push(`${skipped} cached`);
  if (failed) parts.push(`${failed} failed`);
  if (fromShots) parts.push(`${fromShots} from user shots`);
  console.log(`  previews: ${parts.join(", ") || "none"}`);

  const tierOrder = ["high", "medium", "low", "very-low", "unknown"];
  const tierLine = tierOrder
    .filter((t) => tierCounts[t])
    .map((t) => `${tierCounts[t]} ${t}`)
    .join(", ");
  if (tierLine) console.log(`  quality:  ${tierLine}`);
  return true;
}

async function cleanupStaleFiles(destDir, keepSet) {
  if (!existsSync(destDir)) return;
  const keep = new Set(keepSet);
  try {
    const entries = await readdir(destDir);
    for (const name of entries) {
      if (!keep.has(name) && /^(poster\.jpg|preview\.mp4|\d{2}\.(jpg|mp4))$/.test(name)) {
        await rm(join(destDir, name), { force: true });
      }
    }
  } catch { /* ignore */ }
}


function videoPlayerScript() {
  return `
  <script>
  document.addEventListener('DOMContentLoaded', function() {
    // ── vig-player integration (detail pages only) ──
    // The custom element handles playback/scrubbing/in-out marking and emits
    // shots-change events. We:
    //   1) push the URL ?t=<seconds> into the player as start-at
    //   2) POST shot edits to the sidecar API
    //   3) track watched intervals (heatmap) and POST them to /_api/heat
    if (window.customElements && customElements.whenDefined) {
      customElements.whenDefined('vig-player').then(function() {
        document.querySelectorAll('vig-player').forEach(setupPlayer);
      });
    }

    function setupPlayer(player) {
      // Note: start-at from URL ?t= is set synchronously in detail.html, BEFORE
      // vig-player.js loads, so the seek happens during initial render rather
      // than racing with autoplay. Re-applying it here would clobber any manual
      // scrub the user made between page load and DOMContentLoaded.

      // Prefer history.back() over the player's back-href so the browser can
      // restore scroll position on the feed. The back-href stays as fallback
      // for direct URL loads where there's no history to pop.
      player.addEventListener('back', function(e) {
        if (window.history.length > 1) {
          e.preventDefault();
          window.history.back();
        }
      });

      var slug = player.dataset.slug;
      if (!slug) return;

      player.addEventListener('shots-change', function(e) {
        fetch('/_api/shots?slug=' + encodeURIComponent(slug), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(e.detail.shots),
        }).catch(function(err) { console.warn('shots save failed:', err); });
      });

      // Heat tracking — needs the inner <video> element from the player's open shadow DOM.
      var video = player.shadowRoot && player.shadowRoot.querySelector('.vp-video');
      if (video) {
        bindHeat(video, slug);
        bindAudioPersistence(video);
      }
    }

    // Mute + volume are global per origin: changing them on one detail page
    // carries over to every other detail page (and reopens of the same one).
    // Stored in localStorage so it survives full reloads.
    function bindAudioPersistence(video) {
      try {
        var stored = JSON.parse(localStorage.getItem('vig:audio') || 'null');
        if (stored) {
          if (typeof stored.volume === 'number') video.volume = stored.volume;
          if (typeof stored.muted === 'boolean') video.muted = stored.muted;
        }
      } catch (e) {}
      video.addEventListener('volumechange', function() {
        try {
          localStorage.setItem('vig:audio', JSON.stringify({
            volume: video.volume,
            muted: video.muted,
          }));
        } catch (e) {}
      });
    }

    function bindHeat(video, slug) {
      // Threshold for what counts as "watched": short scrubs / accidental plays
      // shouldn't pollute the heatmap. SEEK_JUMP detects forward/backward jumps
      // bigger than a normal timeupdate delta.
      var MIN_DUR = 2;
      var SEEK_JUMP = 2;
      var session = null;

      function endSession(useBeacon) {
        if (!session) return;
        var s = session; session = null;
        var dur = s.lastTime - s.start;
        if (dur < MIN_DUR) return;
        var payload = JSON.stringify({ from: s.start, to: s.lastTime });
        var url = '/_api/heat?slug=' + encodeURIComponent(slug);
        if (useBeacon && navigator.sendBeacon) {
          try { navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' })); } catch (e) {}
        } else {
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            keepalive: true,
          }).catch(function(){});
        }
      }

      video.addEventListener('play', function() {
        session = { start: video.currentTime, lastTime: video.currentTime };
      });
      video.addEventListener('timeupdate', function() {
        if (!session) return;
        var t = video.currentTime;
        if (Math.abs(t - session.lastTime) > SEEK_JUMP) {
          // Seek detected — flush current span, start a new one at the jump target.
          endSession(false);
          session = { start: t, lastTime: t };
        } else {
          session.lastTime = t;
        }
      });
      video.addEventListener('pause', function() { endSession(false); });
      video.addEventListener('ended', function() { endSession(false); });
      // Tab close / navigate-away — beacon is the only reliable method here.
      window.addEventListener('pagehide', function() { endSession(true); });
    }

    // Hot-shots cycling and viewport autoplay live inside the <vig-hot-shots>
    // component (src/components/vig-hot-shots/) — each instance manages its
    // own video lifecycle and registers with a shared IntersectionObserver.
  });
  ${"<"}/script>`;
}

// ─── Template: Shell ─────────────────────────────────────────────────────────
// Wraps a body fragment in the full HTML document. Markup lives in
// src/pages/_layout.html — this function only injects the data, including the
// per-page list of component bundles to load.

function shell(title, body, { isDetail = false, components = [] } = {}) {
  const prefix = isDetail ? "../../" : "";
  return renderTemplate(LAYOUT_TPL, {
    title,
    cssHref: prefix + "style.css",
    body,
    componentScripts: components.map((c) => `${prefix}components/${c}.js`),
    footerScripts: videoPlayerScript(),
  });
}

// ─── Components ──────────────────────────────────────────────────────────────
// Each component lives at src/components/<name>/ as three sibling files:
//   <name>.html  — shadow-DOM markup with {{var}} placeholders
//   <name>.css   — scoped styles applied inside the shadow root
//   <name>.js    — custom-element class
// At build time we (a) server-render into Declarative Shadow DOM and (b) bundle
// the trio into one ESM at _site/components/<name>.js so the browser's class
// definition can take over for any non-SSR'd usage.

async function loadComponentSources(name) {
  const dir = join(__dirname, "src/components", name);
  const [html, css, js] = await Promise.all([
    readFile(join(dir, `${name}.html`), "utf-8"),
    readFile(join(dir, `${name}.css`), "utf-8"),
    readFile(join(dir, `${name}.js`), "utf-8"),
  ]);
  return { html, css, js };
}

async function bundleComponent(name) {
  const { html, css, js } = await loadComponentSources(name);
  const libSrc = await readFile(join(__dirname, "src/lib/template.js"), "utf-8");

  // Self-contained ESM bundle:
  //   1. inline the template helper (strip its `export`s — they become local)
  //   2. drop the component's `import { ... } from '../../lib/template.js'`
  //   3. replace the "__TEMPLATE__" / "__STYLES__" sentinels with file
  //      contents, JSON.stringify'd for proper escape handling
  const libInlined = libSrc.replace(/^export\s+/gm, "");
  const jsNoImport = js.replace(
    /^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?\s*\n/gm, "");
  const bundle =
    `// Auto-generated by build.js — do not edit. Source: src/components/${name}/\n\n` +
    libInlined + "\n" + jsNoImport
      .replace(/"__TEMPLATE__"/g, JSON.stringify(html))
      .replace(/"__STYLES__"/g, JSON.stringify(css));

  await mkdir(join(OUT_DIR, "components"), { recursive: true });
  await writeFile(join(OUT_DIR, "components", `${name}.js`), bundle);
  console.log(`  wrote components/${name}.js`);
}

// Loaded once per build.js invocation. Each `node build.js` call re-reads, so
// edits to component files are picked up by the next rebuild.
const VIG_CARD = await loadComponentSources("vig-card");
const VIG_HOT_SHOTS = await loadComponentSources("vig-hot-shots");
const VIG_STORIES_BAR = await loadComponentSources("vig-stories-bar");
const VIG_STORY = await loadComponentSources("vig-story");
const VIG_VIEW_TOGGLE = await loadComponentSources("vig-view-toggle");
const VIG_DETAIL = await loadComponentSources("vig-detail");
const VIG_NAV_TOP = await loadComponentSources("vig-nav-top");
const VIG_NAV_BOTTOM = await loadComponentSources("vig-nav-bottom");
const VIG_GALLERY_GRID = await loadComponentSources("vig-gallery-grid");

// Drives both bundleComponent() loop and the page-script injection.
// Order matters only for predictable script-tag order in the HTML head.
const FEED_COMPONENTS = [
  "vig-card",
  "vig-hot-shots",
  "vig-stories-bar",
  "vig-story",
  "vig-view-toggle",
  "vig-nav-top",
  "vig-nav-bottom",
  "vig-gallery-grid",
];
const DETAIL_COMPONENTS = ["vig-detail"];
const ALL_COMPONENTS = [...new Set([...FEED_COMPONENTS, ...DETAIL_COMPONENTS])];

// Page templates (markup-only files) — same lazy-load pattern as components.
const LAYOUT_TPL = await readFile(join(__dirname, "src/pages/_layout.html"), "utf-8");
const FEED_TPL = await readFile(join(__dirname, "src/pages/feed.html"), "utf-8");
const FEED_EMPTY_TPL = await readFile(join(__dirname, "src/pages/feed-empty.html"), "utf-8");
const DETAIL_TPL = await readFile(join(__dirname, "src/pages/detail.html"), "utf-8");

// Common helper: wrap a component's inner shadow + slotted children into the
// SSR'd Declarative Shadow DOM markup. Saves repeating the boilerplate in
// every renderVigX() function.
function declarativeShadow(tag, attrs, comp, innerShadow, lightChildren = "") {
  const attrStr = Object.entries(attrs)
    .filter(([, v]) => v != null && v !== false)
    .map(([k, v]) => v === true ? k : `${k}="${escapeHtml(v)}"`)
    .join(" ");
  return `<${tag}${attrStr ? " " + attrStr : ""}>
    <template shadowrootmode="open">
      <style>${comp.css}</style>
      ${innerShadow}
    </template>
    ${lightChildren}
  </${tag}>`;
}

// ─── <vig-hot-shots> SSR ─────────────────────────────────────────────────────
// Cycling preview <video> with viewport-autoplay and href-syncing — see the
// component class for runtime behaviour. Server-rendered with the poster baked
// into the shadow <video> so the very first paint already shows the still.
function renderVigHotShots(post, variant) {
  const innerShadow = renderTemplate(VIG_HOT_SHOTS.html, {
    poster: `post/${post.slug}/poster.jpg`,
  });
  const starts = post.previewPlan ? post.previewPlan.ranges.map((r) => r.start) : [];
  const cums = previewCums(post.previewPlan);
  return declarativeShadow("vig-hot-shots", {
    variant,
    base: `post/${post.slug}`,
    starts: starts.map((s) => s.toFixed(2)).join(","),
    cums: cums.map((c) => c.toFixed(2)).join(","),
    "aria-label": post.title,
  }, VIG_HOT_SHOTS, innerShadow);
}

// ─── <vig-card> SSR ──────────────────────────────────────────────────────────
// Chrome (header, caption, meta) in the shadow root; wrapping
// <a class="post-media-link"> slotted from light DOM so the <vig-hot-shots>
// inside can resolve closest('a') for href syncing.
function renderVigCard(post) {
  const folder = folderLabel(post.folder);
  const href = `post/${post.slug}/index.html`;
  const innerShadow = renderTemplate(VIG_CARD.html, {
    href,
    folder,
    folderInitial: folderInitial(post.folder),
    timeAgo: timeAgo(post.mtime),
    title: post.title,
    size: formatBytes(post.size),
  });
  const mediaInner = post.hasThumb
    ? renderVigHotShots(post, "feed")
    : `<div class="post-media no-media"><div class="grid-placeholder">${escapeHtml(folderInitial(post.folder))}</div></div>`;
  const slottedMedia = `<a slot="media" class="post-media-link" href="${href}">${mediaInner}</a>`;
  return declarativeShadow("vig-card", {}, VIG_CARD, innerShadow, slottedMedia);
}

// ─── <vig-story> SSR ─────────────────────────────────────────────────────────

function renderVigStory(c) {
  const innerShadow = renderTemplate(VIG_STORY.html, c);
  return declarativeShadow("vig-story", {
    href: c.href,
    initial: c.initial,
    display: c.display,
  }, VIG_STORY, innerShadow);
}

// ─── <vig-stories-bar> SSR ───────────────────────────────────────────────────
// Each collection avatar is its own <vig-story> child (slotted in light DOM)
// so the bar stays pure layout. Empty when no collections (e.g. zero posts).
function renderVigStoriesBar(posts) {
  const seen = new Set();
  const collections = [];
  for (const p of posts) {
    const top = p.folder ? p.folder.split("/")[0] : "root";
    if (seen.has(top)) continue;
    seen.add(top);
    collections.push({
      href: `post/${p.slug}/index.html`,
      display: top.length > 10 ? top.slice(0, 9) + "…" : top,
      initial: top[0]?.toUpperCase() || "?",
    });
  }
  if (collections.length === 0) return "";

  const stories = collections.map(renderVigStory).join("\n");
  const innerShadow = renderTemplate(VIG_STORIES_BAR.html, {});
  return declarativeShadow("vig-stories-bar", {}, VIG_STORIES_BAR, innerShadow, stories);
}

// ─── <vig-view-toggle> SSR ───────────────────────────────────────────────────
// Buttons are slotted in light DOM so Datastar's data-on-click and
// data-class-active continue to work — Datastar's MutationObserver doesn't
// scan into shadow roots, so anything reactive must stay in light DOM.
function renderVigViewToggle() {
  const innerShadow = renderTemplate(VIG_VIEW_TOGGLE.html, {});
  const buttons = `
    <button slot="feed" class="toggle-btn" data-class-active="!$gallery" data-on-click="$gallery = false">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>
    </button>
    <button slot="grid" class="toggle-btn" data-class-active="$gallery" data-on-click="$gallery = true">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 3h7v7H3zm0 11h7v7H3zm11-11h7v7h-7zm0 11h7v7h-7z"/></svg>
    </button>`;
  return declarativeShadow("vig-view-toggle", {}, VIG_VIEW_TOGGLE, innerShadow, buttons);
}

// ─── <vig-detail> SSR ────────────────────────────────────────────────────────
// Layout shell wrapping a single <vig-player>. Provides the full-viewport
// black backdrop that used to live in the .vig-detail global CSS rule.
function renderVigDetail(slottedContent) {
  const innerShadow = renderTemplate(VIG_DETAIL.html, {});
  return declarativeShadow("vig-detail", {}, VIG_DETAIL, innerShadow, slottedContent);
}

// ─── <vig-nav-top> / <vig-nav-bottom> SSR ────────────────────────────────────

function renderVigNavTop({ homeHref = "index.html" } = {}) {
  const innerShadow = renderTemplate(VIG_NAV_TOP.html, { homeHref });
  return declarativeShadow("vig-nav-top", { "home-href": homeHref }, VIG_NAV_TOP, innerShadow);
}

function renderVigNavBottom({ homeHref = "index.html", active = "home" } = {}) {
  const innerShadow = renderTemplate(VIG_NAV_BOTTOM.html, {
    homeHref,
    homeActive: active === "home" ? "active" : "",
  });
  return declarativeShadow("vig-nav-bottom", {
    "home-href": homeHref,
    active,
  }, VIG_NAV_BOTTOM, innerShadow);
}

// ─── <vig-gallery-grid> SSR ──────────────────────────────────────────────────
// Layout shell — cells are passed as a pre-rendered slotted-children string
// so the existing build-time hashing (1×1, 1×2, 2×2) stays pure JS.
function renderVigGalleryGrid(cellsHtml) {
  const innerShadow = renderTemplate(VIG_GALLERY_GRID.html, {});
  return declarativeShadow("vig-gallery-grid", {}, VIG_GALLERY_GRID, innerShadow, cellsHtml);
}

// ─── Template: Detail Page ───────────────────────────────────────────────────

function detailPage(post) {
  const src = post.videoFile;                                  // relative to detail page
  const poster = post.hasThumb ? "poster.jpg" : "";
  // Safe-for-inline JSON: escape </ so a shot label can never close the <script> tag.
  const initialShotsJson = JSON.stringify(post.shots || []).replace(/</g, "\\u003c");

  const player = `<vig-player
        src="${src}"
        ${poster ? `poster="${poster}"` : ""}
        center-action="back"
        back-href="../../index.html"
        autoplay
        muted
        data-slug="${post.slug}">
        <script type="application/json" slot="shots">${initialShotsJson}</script>
      </vig-player>`;

  const vigPlayerSrc = `../../vig-player.js${globalThis.__vigPlayerVersion ? `?v=${globalThis.__vigPlayerVersion}` : ""}`;

  return shell(
    `${post.title} — vig`,
    renderTemplate(DETAIL_TPL, {
      vigDetail: renderVigDetail(player),
      vigPlayerSrc,
    }),
    { isDetail: true, components: DETAIL_COMPONENTS }
  );
}

// ─── Template: Gallery Grid (cells) ──────────────────────────────────────────
// Builds the slotted children for <vig-gallery-grid>. Per-cell hashing
// (1×1, 1×2, 2×2) stays here as build-time logic — the component just lays
// the cells out.
function galleryCells(posts) {
  return posts
    .map((post) => {
      const isVertical = post.dimensions && post.dimensions.h > post.dimensions.w;
      const isBig = !isVertical && (slugHash(post.slug) % 8 === 0);
      let spanStyle = "";
      if (isVertical) spanStyle = ' style="grid-row: span 2"';
      else if (isBig) spanStyle = ' style="grid-column: span 2; grid-row: span 2"';

      const thumb = post.hasThumb
        ? renderVigHotShots(post, "grid")
        : `<div class="grid-placeholder">${escapeHtml(folderInitial(post.folder))}</div>`;
      return `
      <a href="post/${post.slug}/index.html" class="grid-cell"${spanStyle}>
        ${thumb}
        <div class="grid-overlay">
          <span class="grid-stat">${escapeHtml(post.title)}</span>
        </div>
      </a>`;
    })
    .join("");
}

// ─── Template: Feed (index.html) ─────────────────────────────────────────────

function feedPage(posts) {
  if (posts.length === 0) {
    return shell("vig", renderTemplate(FEED_EMPTY_TPL, {
      navBar: renderVigNavTop(),
      navBottom: renderVigNavBottom(),
      contentDir: CONTENT_DIR,
    }), { components: ["vig-nav-top", "vig-nav-bottom"] });
  }

  return shell("vig", renderTemplate(FEED_TPL, {
    navBar: renderVigNavTop(),
    storiesBar: renderVigStoriesBar(posts),
    viewToggle: renderVigViewToggle(),
    cards: posts.map(renderVigCard).join("\n"),
    grid: renderVigGalleryGrid(galleryCells(posts)),
    navBottom: renderVigNavBottom(),
  }), { components: FEED_COMPONENTS });
}

// ─── Build ───────────────────────────────────────────────────────────────────

async function build() {
  console.log("Building vig…");

  // 1. Verify content dir.
  // Auto-create only relative paths (the project-local "videos/" default);
  // an absolute external source must already exist — silently creating it
  // somewhere unexpected would mask a misconfiguration.
  if (!existsSync(CONTENT_DIR)) {
    if (CONTENT_DIR.startsWith("/")) {
      console.error(`Content directory not found: ${CONTENT_DIR}`);
      console.error("Set VIG_VIDEOS or check the path.");
      process.exit(1);
    }
    await mkdir(CONTENT_DIR, { recursive: true });
    console.log(`  Created empty ${CONTENT_DIR}/`);
  }

  // 2. Walk videos recursively
  const videos = await walkVideos(CONTENT_DIR);

  const posts = videos.map((v) => {
    const stem = v.filename.replace(/\.[^.]+$/, "");
    const slug = slugify((v.folder ? v.folder.replace(/\//g, "-") + "-" : "") + stem);
    return {
      ...v,
      title: titleFromFilename(v.filename),
      slug,
      outDir: postOutDir(slug),
      metaDir: metaOutDir(slug),
      videoFile: videoFileName(v.filename),
      hasThumb: false,
      // sidecars filled in below
      shots: [],
      sidecarMtime: 0,
      heat: null,
      heatMtime: 0,
    };
  });

  // Ensure slug uniqueness (very defensive — append counter on collision).
  const seenSlugs = new Map();
  for (const p of posts) {
    const count = seenSlugs.get(p.slug) || 0;
    if (count > 0) {
      p.slug = `${p.slug}-${count}`;
      p.outDir = postOutDir(p.slug);
      p.metaDir = metaOutDir(p.slug);
    }
    seenSlugs.set(p.slug, count + 1);
  }

  // Load sidecars per post in parallel — pure I/O, sequential just adds latency.
  // They live in _site/meta/<slug>/ so a wipe of the post/ tree (full rebuild)
  // doesn't lose the user's shots and heat data.
  await Promise.all(posts.map(async (post) => {
    const shotsPath = join(post.metaDir, "shots.json");
    if (existsSync(shotsPath)) {
      try {
        const [raw, sst] = await Promise.all([readFile(shotsPath, "utf-8"), stat(shotsPath)]);
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          post.shots = parsed.filter((s) =>
            typeof s?.start === "number" && typeof s?.end === "number" && s.end > s.start);
        }
        post.sidecarMtime = sst.mtime.getTime();
      } catch (err) {
        console.warn(`  skipping malformed shots ${shotsPath}: ${err.message}`);
      }
    }
    const heatPath = join(post.metaDir, "heat.json");
    if (existsSync(heatPath)) {
      try {
        const [raw, hst] = await Promise.all([readFile(heatPath, "utf-8"), stat(heatPath)]);
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.buckets) && typeof parsed.bucketSize === "number") {
          post.heat = parsed;
          post.heatMtime = hst.mtime.getTime();
        }
      } catch (err) {
        console.warn(`  skipping malformed heat ${heatPath}: ${err.message}`);
      }
    }
  }));

  // Sort newest first
  posts.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

  console.log(`  Found ${posts.length} video${posts.length === 1 ? "" : "s"}`);

  // 3. Create output dirs.
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(join(OUT_DIR, POST_DIR), { recursive: true });
  await mkdir(META_ROOT, { recursive: true });
  // Each post's meta dir, in parallel (was sequential — 519× await mkdir
  // takes 2-3s of silent waiting).
  await Promise.all(posts.map((p) => mkdir(p.metaDir, { recursive: true })));

  // 3b. One-shot cleanup of the previous layout — _site/media/ and _site/thumbs/
  // were used before everything moved into _site/post/<slug>/. Just delete them
  // if present so disk doesn't bloat with orphaned files from old builds.
  for (const old of ["media", "thumbs"]) {
    const oldDir = join(OUT_DIR, old);
    if (existsSync(oldDir)) {
      await rm(oldDir, { recursive: true, force: true });
      console.log(`  removed legacy ${oldDir}`);
    }
  }

  // 4. Link each source video to its post's outDir as video.<ext>.
  //    Strategy: hardlink first (same filesystem, zero disk overhead, looks
  //    like a regular file to the static server), and on failure (e.g. cross-
  //    filesystem) fall back to an absolute symlink. We never copy — videos
  //    are big and the source folder is the source of truth.
  //    Done in parallel: pure I/O, no reason to serialise.
  let linkDone = 0;
  const linkResults = await Promise.all(posts.map(async (post) => {
    const srcPath = join(CONTENT_DIR, post.relPath);
    if (!existsSync(srcPath)) {
      linkDone++; progress(`  linking media ${linkDone}/${posts.length}`);
      return "missing";
    }
    await mkdir(post.outDir, { recursive: true });
    const destPath = join(post.outDir, post.videoFile);

    // Up-to-date check — handle both hardlink (inode match) and symlink
    // (link target match) without needing to recreate.
    try {
      const destStat = await lstat(destPath);
      if (destStat.isSymbolicLink()) {
        const target = await readlink(destPath);
        const resolved = isAbsolute(target) ? target : resolve(dirname(destPath), target);
        if (resolved === srcPath) {
          linkDone++; progress(`  linking media ${linkDone}/${posts.length}`);
          return "skipped";
        }
      } else {
        const srcStat = await stat(srcPath);
        if (destStat.ino === srcStat.ino) {
          linkDone++; progress(`  linking media ${linkDone}/${posts.length}`);
          return "skipped";
        }
      }
      // Stale (different file, or wrong type) — remove and re-link.
      await rm(destPath, { force: true });
    } catch { /* doesn't exist — fine */ }

    try {
      await link(srcPath, destPath);
      linkDone++; progress(`  linking media ${linkDone}/${posts.length}`);
      return "linked";
    } catch {
      try {
        // Cross-filesystem (or APFS firmlink edge case) — fall back to an
        // absolute symlink. serve.js follows symlinks via stat() so this
        // works fine for the dev server.
        await symlink(srcPath, destPath);
        linkDone++; progress(`  linking media ${linkDone}/${posts.length}`);
        return "symlinked";
      } catch (err) {
        console.warn(`\n  could not link ${post.relPath}: ${err.message}`);
        linkDone++; progress(`  linking media ${linkDone}/${posts.length}`);
        return "failed";
      }
    }
  }));
  progressClear();
  if (posts.length > 0) {
    const counts = { linked: 0, symlinked: 0, skipped: 0, missing: 0, failed: 0 };
    for (const r of linkResults) counts[r] = (counts[r] || 0) + 1;
    const parts = [];
    if (counts.linked)    parts.push(`${counts.linked} hardlinked`);
    if (counts.symlinked) parts.push(`${counts.symlinked} symlinked (cross-filesystem)`);
    if (counts.skipped)   parts.push(`${counts.skipped} up-to-date`);
    if (counts.missing)   parts.push(`${counts.missing} missing source`);
    if (counts.failed)    parts.push(`${counts.failed} failed`);
    console.log(`  media: ${parts.join(", ")}`);
  }

  // 5. Generate poster + clip previews via ffmpeg, into each post's outDir.
  //    Gracefully no-ops when ffmpeg isn't installed.
  if (posts.length > 0) {
    await generateThumbs(posts);
  }

  // 5b. Write per-post meta.json — keeps each post folder self-contained even
  //     if you copy/move/share it without the source. Parallel: pure I/O.
  await Promise.all(posts.map((post) => writeFile(
    join(post.outDir, "meta.json"),
    JSON.stringify({
      slug: post.slug,
      originalName: post.filename,
      relPath: post.relPath,
      folder: post.folder,
      title: post.title,
      videoFile: post.videoFile,
      size: post.size,
      mtime: post.mtime,
    }, null, 2),
  )));

  // 6. Link the vig-player web component into _site/ so detail pages can load
  //    it as a same-origin module (file:// + cross-dir module loading is fragile,
  //    and the static server only serves _site). Capture the source mtime so
  //    detail pages can cache-bust the import URL on player updates.
  let playerVersion = "";
  if (existsSync(PLAYER_SRC)) {
    const dest = join(OUT_DIR, "vig-player.js");
    const s = await stat(PLAYER_SRC);
    playerVersion = String(Math.floor(s.mtimeMs));
    let stale = true;
    try {
      const d = await lstat(dest);
      if (!d.isSymbolicLink() && s.ino === d.ino) stale = false;
      else if (d.mtime.getTime() >= s.mtime.getTime()) stale = false;
    } catch { /* dest doesn't exist */ }
    if (stale) {
      await rm(dest, { force: true });
      try { await link(PLAYER_SRC, dest); }
      catch { await copyFile(PLAYER_SRC, dest); }
      console.log("  linked vig-player.js");
    }
  } else {
    console.warn(`  vig-player.js not found at ${PLAYER_SRC} — detail pages won't have the player`);
  }

  // Make the version available to detailPage() via a closure-y global.
  globalThis.__vigPlayerVersion = playerVersion;

  // 7. Write CSS
  await copyFile(join(__dirname, "src/style.css"), join(OUT_DIR, "style.css"));
  console.log("  wrote style.css");

  // 7b. Bundle web components into _site/components/<name>.js
  for (const name of ALL_COMPONENTS) {
    await bundleComponent(name);
  }

  // 8. Write feed page
  await writeFile(join(OUT_DIR, "index.html"), feedPage(posts));
  console.log("  wrote index.html");

  // 9. Write detail pages — each into its own post folder. Parallel: pure I/O.
  await Promise.all(posts.map(async (post) => {
    await mkdir(post.outDir, { recursive: true });
    await writeFile(join(post.outDir, "index.html"), detailPage(post));
  }));
  if (posts.length > 0) {
    console.log(`  wrote ${posts.length} detail page${posts.length === 1 ? "" : "s"}`);
  }

  // 10. Cleanup orphan post entries. Folders left over from previous builds
  //     against a different source folder, plus any stray files at the post
  //     root (e.g. an earlier slug-empty bug that wrote video.mp4 there).
  const validSlugs = new Set(posts.map((p) => p.slug));
  try {
    const entries = await readdir(join(OUT_DIR, POST_DIR), { withFileTypes: true });
    let orphans = 0;
    for (const entry of entries) {
      const p = join(OUT_DIR, POST_DIR, entry.name);
      if (entry.isDirectory()) {
        if (!validSlugs.has(entry.name)) {
          await rm(p, { recursive: true, force: true });
          orphans++;
        }
      } else {
        // Anything that isn't a slug-folder is junk: remove.
        await rm(p, { force: true });
        orphans++;
      }
    }
    if (orphans > 0) console.log(`  cleaned ${orphans} orphan post entr${orphans === 1 ? "y" : "ies"}`);
  } catch { /* post root missing — nothing to clean */ }

  console.log(`\nDone. Built ${posts.length} post${posts.length === 1 ? "" : "s"} → ${OUT_DIR}/`);
}


// ─── Run ─────────────────────────────────────────────────────────────────────
build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
