/**
 * <vig-view-toggle> — layout shell for the feed/grid toggle buttons.
 *
 * The two <button>s are slotted from light DOM (so Datastar's
 * data-on-click="$gallery = …" and data-class-active="…" attributes stay
 * visible to Datastar's document-level MutationObserver). The shadow DOM
 * supplies only structure and scoped styling.
 */

import { renderTemplate } from "../../lib/template.js";

const TEMPLATE = "__TEMPLATE__";
const STYLES = "__STYLES__";

export class VigViewToggle extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLES}</style>${renderTemplate(TEMPLATE, {})}`;
  }
}

customElements.define("vig-view-toggle", VigViewToggle);
