/**
 * <vig-folder-section> — vertical group in either feed or grid view for one
 * folder's posts. Header block (avatar + name + count) above slotted content.
 *
 * Attributes:
 *   folder       — folder path ("" for root, "action", "action/thriller", …)
 *   display      — pre-formatted display name (e.g. "root" for empty folder)
 *   initial      — single character for the avatar circle
 *   count        — number of posts in this folder
 *   count-label  — "video" or "videos", pluralised upstream
 *   variant      — "feed" | "grid", drives header max-width
 *
 * Slotted content: feed view = <vig-card> children, grid view = a single
 * <vig-gallery-grid>. The component doesn't care which.
 */

import { renderTemplate } from "../../lib/template.js";

const TEMPLATE = "__TEMPLATE__";
const STYLES = "__STYLES__";

export class VigFolderSection extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const data = {
      display: this.getAttribute("display") || this.getAttribute("folder") || "root",
      initial: this.getAttribute("initial") || "?",
      count: this.getAttribute("count") || "0",
      countLabel: this.getAttribute("count-label") || "videos",
    };
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLES}</style>${renderTemplate(TEMPLATE, data)}`;
  }
}

customElements.define("vig-folder-section", VigFolderSection);
