/**
 * <vig-card> — the post chrome (header, caption, meta) wrapping a slotted
 * media link. Authored as three sibling files (vig-card.html / .css / .js);
 * build.js bundles them into a single browser ESM that lives at
 * /components/vig-card.js.
 *
 * Two render paths:
 *   1. Server-rendered via Declarative Shadow DOM. The browser parses the
 *      <template shadowrootmode="open"> emitted by build.js, the shadow root
 *      already exists by the time this class registers, and we no-op.
 *   2. Client-rendered fallback. If the element is created in JS without a
 *      pre-rendered shadow root, we render from data-post + the inlined
 *      template.
 */

import { renderTemplate } from "../../lib/template.js";

// `'__TEMPLATE__'` and `'__STYLES__'` are sentinel strings — build.js inlines
// the contents of vig-card.html and vig-card.css here at bundle time.
const TEMPLATE = "__TEMPLATE__";
const STYLES = "__STYLES__";

export class VigCard extends HTMLElement {
  connectedCallback() {
    // Already hydrated by Declarative Shadow DOM → leave it alone.
    if (this.shadowRoot) return;

    const data = this._readData();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLES}</style>${renderTemplate(TEMPLATE, data)}`;
  }

  _readData() {
    try {
      return JSON.parse(this.dataset.post || "{}");
    } catch {
      return {};
    }
  }
}

customElements.define("vig-card", VigCard);
