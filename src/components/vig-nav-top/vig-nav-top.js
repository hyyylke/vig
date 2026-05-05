/**
 * <vig-nav-top> — sticky top bar with logo and icons.
 *
 * Attributes:
 *   home-href — link target for the logo (varies per page: "index.html" on
 *               feed, "../../index.html" on detail pages).
 */

import { renderTemplate } from "../../lib/template.js";

const TEMPLATE = "__TEMPLATE__";
const STYLES = "__STYLES__";

export class VigNavTop extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const data = { homeHref: this.getAttribute("home-href") || "index.html" };
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLES}</style>${renderTemplate(TEMPLATE, data)}`;
  }
}

customElements.define("vig-nav-top", VigNavTop);
