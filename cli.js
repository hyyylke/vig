#!/usr/bin/env node
/**
 * vig CLI — bootstrap a local video gallery in the current folder.
 *
 *   cd ~/Movies && vig
 *
 * Picks a free port, builds the gallery into .vig/site/, persists user data
 * (shots, heat) in .vig/meta/, and serves on http://localhost:<port>.
 */

import { spawn } from "child_process";
import { createServer as netCreateServer } from "net";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { platform } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();

// All paths into .vig/ inside the user's content folder. Absolute, because
// build.js and serve.js are spawned from a Node process whose cwd is the user's
// content folder — relative paths would land in the wrong tree.
const VIG_DIR = resolve(cwd, ".vig");
const VIG_SITE = resolve(VIG_DIR, "site");
const VIG_META = resolve(VIG_DIR, "meta");
const VIG_VIDEOS = cwd;
const VIG_PLAYER_SRC = resolve(__dirname, "vig-player.js");

const env = {
  ...process.env,
  VIG_VIDEOS,
  VIG_SITE,
  VIG_META,
  VIG_PLAYER_SRC,
};

// OSC 8 hyperlink escape — supported by iTerm2, Terminal.app, VS Code,
// WezTerm, Kitty, Windows Terminal. Falls back to plain text in non-TTY
// contexts (pipes, log files, CI) so we don't pollute output.
function clickable(url, text = url) {
  if (!process.stdout.isTTY) return text;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// Open the URL in the user's default browser. Platform-specific; silently
// no-ops on failure (user still has the clickable URL in the terminal).
// Set VIG_NO_OPEN=1 to disable (headless use, SSH session, …).
function openInBrowser(url) {
  if (process.env.VIG_NO_OPEN === "1") return;
  const p = platform();
  const [cmd, ...prefix] =
      p === "darwin" ? ["open"]
    : p === "win32"  ? ["cmd.exe", "/c", "start", ""]
    :                  ["xdg-open"];
  try {
    spawn(cmd, [...prefix, url], { detached: true, stdio: "ignore" }).unref();
  } catch { /* no-op */ }
}

async function main() {
  // Pick a port up-front so we can announce the URL before serve starts.
  const port = parseInt(process.env.VIG_PORT || "", 10) || (await pickFreePort());
  const url = `http://localhost:${port}`;

  // Announce the URL immediately, before serve.js starts. For big libraries
  // the initial build takes tens of seconds and would otherwise scroll this
  // out of view — serve.js also reprints it after every rebuild for the
  // same reason.
  console.log(`vig: serving ${cwd}`);
  console.log(`     ${clickable(url)}`);

  // serve.js handles the initial build itself (via its startup triggerRebuild),
  // so we don't run build.js separately here — that would cause a full build
  // followed by a redundant second build on serve startup.
  const serveProc = spawn(
    "node",
    [join(__dirname, "serve.js")],
    { stdio: "inherit", env: { ...env, VIG_PORT: String(port) } },
  );

  // Open the browser once serve.js has had a moment to start listening. The
  // page will show a live-reload spinner during the initial build (see
  // _layout.html's EventSource listener); the user doesn't have to wait or
  // reload manually.
  setTimeout(() => openInBrowser(url), 500);

  // Forward common signals to the child so Ctrl+C in the CLI stops the server.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { try { serveProc.kill(sig); } catch {} });
  }

  serveProc.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error("vig:", err.message);
  process.exit(1);
});
