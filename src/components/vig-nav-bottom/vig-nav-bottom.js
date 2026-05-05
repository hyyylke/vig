/**
 * <vig-nav-bottom> — fixed bottom nav.
 *
 * Attributes:
 *   home-href — link target for the home item
 *   active    — which item is highlighted ("home" today; future-proofed for
 *               more entries when the other tabs become real)
 */

import { renderTemplate } from "../../lib/template.js";

const TEMPLATE = "__TEMPLATE__";
const STYLES = "__STYLES__";

export class VigNavBottom extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const active = this.getAttribute("active") || "";
    const data = {
      homeHref: this.getAttribute("home-href") || "index.html",
      homeActive: active === "home" ? "active" : "",
    };
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLES}</style>${renderTemplate(TEMPLATE, data)}`;
  }
}

customElements.define("vig-nav-bottom", VigNavBottom);
