/**
 * <vig-detail> — page-level layout shell that hosts a single <vig-player>.
 * Layout-only (no behavior) but registered as a custom element so that future
 * page-level concerns (scroll restoration, key handling, etc.) have a natural
 * home that doesn't pollute the global script.
 */

import { renderTemplate } from "../../lib/template.js";

const TEMPLATE = "__TEMPLATE__";
const STYLES = "__STYLES__";

export class VigDetail extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLES}</style>${renderTemplate(TEMPLATE, {})}`;
  }
}

customElements.define("vig-detail", VigDetail);
