/**
 * <vig-gallery-grid> — grid layout shell. Cells are slotted <a class="grid-cell">
 * elements (light DOM) so the per-cell `style="grid-column/row span"` from
 * build.js still controls placement, and the cell internals (overlay, label,
 * placeholder) can keep their light-DOM CSS without ::slotted gymnastics.
 */

import { renderTemplate } from "../../lib/template.js";

const TEMPLATE = "__TEMPLATE__";
const STYLES = "__STYLES__";

export class VigGalleryGrid extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLES}</style>${renderTemplate(TEMPLATE, {})}`;
  }
}

customElements.define("vig-gallery-grid", VigGalleryGrid);
