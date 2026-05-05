/**
 * <vig-hot-shots> — autoplay-on-viewport preview <video> that cycles through
 * preview.mp4's pre-stitched clips, while keeping its wrapping <a>'s href in
 * sync with the current shot's source-video timestamp (so a click jumps to
 * "this moment, in the original").
 *
 * Attributes:
 *   variant   — "feed" | "grid"   (drives aspect-ratio in the shadow CSS)
 *   base      — "post/<slug>"     (preview.mp4 lives at <base>/preview.mp4)
 *   poster    — "<base>/poster.jpg" (baked into shadow <video> at SSR time)
 *   starts    — "2,8,14"          (source-video seconds for each shot)
 *   cums      — "0,1.8,3.6"       (cumulative offsets within preview.mp4)
 *
 * Runtime contract:
 *   - One IntersectionObserver is shared across all instances on the page.
 *   - Arming defers until window.load (or a 2.5s fallback) so posters and
 *     metadata settle before videos start fetching.
 *   - On stop(), src is removed and load() is called to drop decoder/buffer —
 *     keeps memory bounded across hundreds of cards (Safari reloads tabs at
 *     ~1GB held video state).
 */

import { renderTemplate } from "../../lib/template.js";

const TEMPLATE = "__TEMPLATE__";
const STYLES = "__STYLES__";

// ─── Shared autoplay coordinator ──────────────────────────────────────────────
// One IntersectionObserver for the whole page. Components register on connect
// and unregister on disconnect. Arming is deferred to window.load (or a 2.5s
// fallback) so layout/posters settle before we start fetching video clips.

let sharedObserver = null;
let armed = false;
const pending = new Set();

function ensureObserver() {
  if (sharedObserver) return sharedObserver;
  if (typeof IntersectionObserver === "undefined") return null;
  sharedObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const el = entry.target;
      if (!(el instanceof VigHotShots)) continue;
      if (entry.isIntersecting) el.start();
      else el.stop();
    }
  }, { threshold: 0.5 });
  return sharedObserver;
}

function register(el) {
  if (armed) {
    const obs = ensureObserver();
    if (obs) obs.observe(el);
  } else {
    pending.add(el);
  }
}

function unregister(el) {
  pending.delete(el);
  sharedObserver?.unobserve(el);
}

function armNow() {
  if (armed) return;
  armed = true;
  const obs = ensureObserver();
  if (obs) for (const el of pending) obs.observe(el);
  pending.clear();
}

if (typeof window !== "undefined") {
  if (document.readyState === "complete") armNow();
  else {
    window.addEventListener("load", armNow, { once: true });
    setTimeout(armNow, 2500);
  }
}

// ─── Element ──────────────────────────────────────────────────────────────────

export class VigHotShots extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      // Client-side fallback when no Declarative Shadow DOM was emitted.
      this.attachShadow({ mode: "open" });
      this.shadowRoot.innerHTML =
        `<style>${STYLES}</style>${renderTemplate(TEMPLATE, { poster: this.getAttribute("poster") || "" })}`;
    }
    if (!this._initialized) this._setup();
  }

  disconnectedCallback() {
    unregister(this);
    this._releaseVideo();
  }

  _setup() {
    this._initialized = true;
    this._video = this.shadowRoot.querySelector("video");
    if (!this._video) return;

    this._previewUrl = (this.getAttribute("base") || "") + "/preview.mp4";
    this._starts = this._parseFloatList("starts");
    this._cums = this._parseFloatList("cums");
    this._link = this.closest("a");
    this._linkBase = this._link ? this._link.getAttribute("href") : null;
    this._active = false;

    // Keep the wrapping anchor's href in sync with the current shot, so
    // clicking the card jumps into the source video at the right second.
    this._video.addEventListener("timeupdate", () => this._syncHref());
    this._syncHref();

    this.addEventListener("mouseenter", () => this.start());
    this.addEventListener("mouseleave", () => this.stop());

    register(this);
  }

  start() {
    if (this._active || !this._video) return;
    this._active = true;
    if (!this._video.getAttribute("src")) this._video.src = this._previewUrl;
    this._video.play().catch(() => {});
  }

  stop() {
    if (!this._active) return;
    this._releaseVideo();
    this._syncHref();
  }

  _releaseVideo() {
    if (!this._video) return;
    this._active = false;
    this._video.pause();
    this._video.removeAttribute("src");
    this._video.load();
  }

  _parseFloatList(attr) {
    return (this.getAttribute(attr) || "")
      .split(",")
      .map(parseFloat)
      .filter(Number.isFinite);
  }

  _clipIndexAt(t) {
    for (let i = this._cums.length - 1; i >= 0; i--) {
      if (t >= this._cums[i]) return i;
    }
    return 0;
  }

  _syncHref() {
    if (!this._link || !this._linkBase || !this._video) return;
    const s = this._starts[this._clipIndexAt(this._video.currentTime)];
    if (!Number.isFinite(s) || s <= 0) {
      this._link.setAttribute("href", this._linkBase);
    } else {
      this._link.setAttribute("href", `${this._linkBase}?t=${s.toFixed(2)}`);
    }
  }
}

customElements.define("vig-hot-shots", VigHotShots);
