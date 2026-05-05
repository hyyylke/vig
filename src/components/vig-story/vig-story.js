/**
 * <vig-story> — single collection avatar.
 *
 * Attributes:
 *   href     — link to the first post in this collection
 *   initial  — single character displayed in the avatar
 *   display  — visible folder label (truncated upstream)
 */

import { renderTemplate } from "../../lib/template.js";

const TEMPLATE = "__TEMPLATE__";
const STYLES = "__STYLES__";

export class VigStory extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const data = {
      href: this.getAttribute("href") || "#",
      initial: this.getAttribute("initial") || "?",
      display: this.getAttribute("display") || "",
    };
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLES}</style>${renderTemplate(TEMPLATE, data)}`;
  }
}

customElements.define("vig-story", VigStory);
