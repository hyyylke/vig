/**
 * Tiny template engine — used both server-side (during build) and client-side
 * (inlined into each component bundle).
 *
 *   {{path}}                       → escaped value
 *   {{{path}}}                     → raw value (use only for trusted HTML)
 *   {{a.b.c}}                      → dotted lookup; missing values render empty
 *   {{#each items}} … {{/each}}    → iterate; inside, {{this}} is the item
 *                                    (or {{prop}} for object items, {{this.x}}
 *                                    for nested access)
 *
 * No nested loops, no conditionals — for branchy markup, compose at the call
 * site by passing pre-rendered raw HTML into a {{{slot}}}.
 */

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

function lookup(path, ctx) {
  if (path === "this") return ctx;
  const start = path.startsWith("this.") ? path.slice(5) : path;
  return start.split(".").reduce((o, k) => (o == null ? o : o[k]), ctx);
}

function expandVars(template, ctx) {
  return template.replace(/\{\{\{?([\w.]+)\}?\}\}/g, (match, path) => {
    const raw = match.startsWith("{{{");
    const value = lookup(path, ctx);
    if (value == null) return "";
    return raw ? String(value) : escapeHtml(value);
  });
}

export function renderTemplate(template, data) {
  // First expand {{#each path}}…{{/each}} blocks. Non-nested (single level only):
  // for nested or branchy content, pre-render strings and pass via {{{slot}}}.
  const expanded = template.replace(
    /\{\{#each\s+([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_, path, body) => {
      const list = lookup(path, data);
      if (!Array.isArray(list)) return "";
      return list.map((item) => expandVars(body, item)).join("");
    }
  );
  return expandVars(expanded, data);
}
