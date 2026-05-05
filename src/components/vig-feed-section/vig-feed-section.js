/**
 * <vig-feed-section> — vertical group in the feed for one folder's posts.
 *
 * Attributes:
 *   folder   — folder path ("" for root, "action", "action/thriller", …).
 *              Used as the visual label.
 *   display  — pre-formatted display name (e.g. "root" for empty folder).
 *   count    — number of posts in this folder, for the right-aligned counter.
 *
 * Cards are slotted in light DOM so each <vig-card> still owns its own
 * shadow + lifecycle.
 */

import { renderTemplate } from "../../lib/template.js";

const TEMPLATE = "__TEMPLATE__";
const STYLES = "__STYLES__";

export class VigFeedSection extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const data = {
      display: this.getAttribute("display") || this.getAttribute("folder") || "root",
      count: this.getAttribute("count") || "",
    };
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLES}</style>${renderTemplate(TEMPLATE, data)}`;
  }
}

customElements.define("vig-feed-section", VigFeedSection);
