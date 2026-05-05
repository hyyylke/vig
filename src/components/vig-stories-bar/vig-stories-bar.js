/**
 * <vig-stories-bar> — horizontal layout shell that hosts <vig-story> children.
 *
 * Stories live as slotted light-DOM children so each one is independently
 * authored, styled and (potentially in the future) interactive. The bar
 * provides nothing but layout + scroll behavior.
 */

import { renderTemplate } from "../../lib/template.js";

const TEMPLATE = "__TEMPLATE__";
const STYLES = "__STYLES__";

export class VigStoriesBar extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLES}</style>${renderTemplate(TEMPLATE, {})}`;
  }
}

customElements.define("vig-stories-bar", VigStoriesBar);
