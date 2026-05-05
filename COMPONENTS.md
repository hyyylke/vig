# Componenten — recipe-gids

Praktische gids voor het maken, aanpassen en begrijpen van vig-componenten.
Voor de high-level architectuur: zie [ARCHITECTURE.md](ARCHITECTURE.md).

## Anatomie van een component

Elke component is een folder onder `src/components/<name>/` met drie files:

```
vig-card/
├── vig-card.html      ← shadow-DOM markup met {{var}} placeholders
├── vig-card.css       ← scoped styles binnen de shadow root
└── vig-card.js        ← class extends HTMLElement + customElements.define
```

### vig-card.html

Markup zoals het er in de shadow root uitziet. Variabelen via de
template-engine. Slots voor content die in light DOM moet blijven.

```html
<article class="card">
  <a class="header" href="{{href}}">
    <div class="avatar">{{folderInitial}}</div>
    <span class="username">{{folder}}</span>
  </a>
  <slot name="media"></slot>
</article>
```

### vig-card.css

Scoped styles. CSS custom properties (`var(--bg)`, `var(--border)`, etc.)
inheriteren vanuit de parent — die definieer je in `src/style.css` op
`:root`. Class names zijn lokaal — `.card` hier botst niet met `.card`
ergens anders.

```css
:host {
  display: block;
  border-bottom: 1px solid var(--border);
  max-width: var(--feed-card-max);
  margin: 0 auto;
}

.card { padding: 12px 0; }

::slotted(a.media-link) {
  display: block;
  color: inherit;
}
```

### vig-card.js

Custom element class. Twee paden:

1. **SSR (normaal)**: `this.shadowRoot` bestaat al via Declarative Shadow
   DOM → niets doen.
2. **Client-only fallback**: render via de inline template + CSS.

```js
import { renderTemplate } from "../../lib/template.js";

const TEMPLATE = "__TEMPLATE__";   // build.js vervangt deze sentinels
const STYLES = "__STYLES__";        // met de echte file-content

export class VigCard extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const data = JSON.parse(this.dataset.post || "{}");
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLES}</style>${renderTemplate(TEMPLATE, data)}`;
  }
}

customElements.define("vig-card", VigCard);
```

## Recipe: een nieuwe component toevoegen

Stel je wil `<vig-tag>` maken: een gekleurde tag-pil met label.

### 1. Maak de folder + drie files

```
src/components/vig-tag/
├── vig-tag.html
├── vig-tag.css
└── vig-tag.js
```

### 2. Schrijf de markup

`vig-tag.html`:
```html
<span class="pill" data-color="{{color}}">{{label}}</span>
```

### 3. Schrijf de styles

`vig-tag.css`:
```css
:host { display: inline-block; }
.pill {
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 11px;
  background: var(--bg-elevated);
  color: var(--text);
}
.pill[data-color="red"] { background: #f44; color: white; }
.pill[data-color="green"] { background: #4a4; color: white; }
```

### 4. Schrijf de class

`vig-tag.js`:
```js
import { renderTemplate } from "../../lib/template.js";

const TEMPLATE = "__TEMPLATE__";
const STYLES = "__STYLES__";

export class VigTag extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const data = {
      label: this.getAttribute("label") || "",
      color: this.getAttribute("color") || "",
    };
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLES}</style>${renderTemplate(TEMPLATE, data)}`;
  }
}

customElements.define("vig-tag", VigTag);
```

### 5. Voeg toe aan `build.js`

a. Laad de bron bij module-init (rond de andere `loadComponentSources`):
```js
const VIG_TAG = await loadComponentSources("vig-tag");
```

b. Voeg toe aan de juiste components-array:
```js
const FEED_COMPONENTS = [..., "vig-tag"];
```

c. Schrijf de SSR render-functie:
```js
function renderVigTag({ label, color = "" } = {}) {
  const innerShadow = renderTemplate(VIG_TAG.html, { label, color });
  return declarativeShadow("vig-tag", { label, color }, VIG_TAG, innerShadow);
}
```

d. Roep `renderVigTag(...)` aan vanaf de plek waar je de tag wil renderen
   (in een page template of in een andere component's render-functie).

### 6. Build draaien

```sh
npm run dev
```

`bundleComponent("vig-tag")` schrijft `_site/components/vig-tag.js`
automatisch. Het script wordt ingeladen in de pagina via
`_layout.html`'s `{{#each componentScripts}}` loop.

## Beslisbomen

### Shadow DOM vs. slotted light DOM vs. light DOM?

```
Wat hoort waar?
│
├── Heeft het Datastar-bindings (data-on-click, data-show, data-class-…)?
│   ├── JA  → Light DOM, geslot via <slot>. Shadow DOM is alleen layout-shell.
│   │        (Datastar's MutationObserver scant geen shadow roots.)
│   └── NEE → ga door
│
├── Moet light-DOM JS er bij kunnen via closest()/querySelector?
│   ├── JA  → Slotted in light DOM, of helemaal niet in shadow.
│   │        (closest() steekt niet door shadow boundaries heen.)
│   └── NEE → ga door
│
├── Moeten externe styles erbij kunnen?
│   ├── JA  → Light DOM. Of gebruik CSS custom properties als bridge.
│   └── NEE → Shadow DOM (encapsulation by default).
│
└── Default: Shadow DOM. Encapsulation is een feature.
```

### Component vs. page template?

```
Wat hoort het te zijn?
│
├── Heeft het lifecycle / behavior / event handlers?
│   ├── JA  → Component (3 files)
│   └── NEE → ga door
│
├── Hergebruikt het styling die los moet leven van de pagina?
│   ├── JA  → Component (3 files)
│   └── NEE → ga door
│
├── Wordt het op meerdere pagina's gebruikt met variërende inhoud?
│   ├── JA, met verschillende data → Component met attributes
│   ├── JA, identiek               → Page template fragment of helper-functie
│   └── NEE → ga door
│
└── Is het alleen markup met variabelen?
    └── Page template (`.html` in src/pages/)
```

### Wanneer een leaf-component vs. inline markup?

Heb je een lijst van vergelijkbare items?

```
Lijst met identieke structuur, varierende data?
│
├── Items hebben ≥3 visuele elementen + eigen styling?
│   └── JA → Eigen leaf-component (zoals vig-story onder vig-stories-bar)
│
├── Items zijn klein én alleen op deze plek gebruikt?
│   └── Pre-render in een loop in JS, geef door als {{{items}}} aan parent.
│
└── Twijfel? Begin met inline. Promote naar component als het complex wordt.
```

## Datastar-coexistence regels

Datastar (CDN-loaded reactive lib) werkt op de **light DOM** via
MutationObserver. Het kijkt **niet** in shadow roots. Concrete regels:

- **`data-signals-*`** kan op een light-DOM element staan dat als parent
  fungeert van components én van Datastar-reactieve targets.
- **`data-on-click`, `data-class-*`, `data-show`** moet op **light-DOM**
  elementen, niet op shadow-DOM elementen.
- Components met interactieve buttons → buttons als **slotted light-DOM
  kinderen** met `slot="…"` attribuut. Shadow DOM rendert alleen de
  layout-wrapper met `<slot>`.
- Components zelf kunnen Datastar-attributes hebben — die zijn op het host
  element, dat in light DOM zit.

Voorbeeld (vig-view-toggle):

```html
<vig-view-toggle>
  <template shadowrootmode="open">
    <style>:host { display: block; } .row { display: flex; }</style>
    <div class="row">
      <slot name="feed"></slot>
      <slot name="grid"></slot>
    </div>
  </template>
  <button slot="feed" data-on-click="$gallery = false" data-class-active="!$gallery">
    <svg>…</svg>
  </button>
  <button slot="grid" data-on-click="$gallery = true" data-class-active="$gallery">
    <svg>…</svg>
  </button>
</vig-view-toggle>
```

De buttons leven in light DOM. Datastar ziet ze. De active-class wordt
toegevoegd → de shadow-DOM `::slotted(button.active)` regel matcht → de
visuele state update. Werkt.

## Common patterns

### Variant-attribute voor visuele varianten

In plaats van meerdere componenten:

```html
<vig-hot-shots variant="feed">…</vig-hot-shots>
<vig-hot-shots variant="grid">…</vig-hot-shots>
```

Met scoped CSS:

```css
:host([variant="feed"]) { aspect-ratio: 9 / 16; }
:host([variant="grid"]) { width: 100%; height: 100%; }
```

### Lifecycle-style component (vig-hot-shots als referentie)

```js
export class VigSomething extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this.shadowRoot.innerHTML = `<style>${STYLES}</style>${renderTemplate(TEMPLATE, data)}`;
    }
    if (!this._initialized) this._setup();
  }

  disconnectedCallback() {
    // unobserve, removeEventListener, free resources
  }

  _setup() {
    this._initialized = true;
    // bind events, register observers, etc.
  }
}
```

### Shared coordinator (één observer, meerdere instances)

Voor IntersectionObserver, ResizeObserver, etc. die je niet per-instance
wil opzetten:

```js
let sharedObserver = null;
const pending = new Set();
let armed = false;

function ensureObserver() { /* lazy create */ }
function register(el) { /* observe of queue */ }
function unregister(el) { /* unobserve */ }

if (typeof window !== "undefined") {
  if (document.readyState === "complete") armNow();
  else window.addEventListener("load", armNow, { once: true });
}

export class VigSomething extends HTMLElement {
  connectedCallback() { /* … */ register(this); }
  disconnectedCallback() { unregister(this); }
}
```

### Render-functie + declarativeShadow helper

In `build.js`:

```js
function renderVigSomething(post) {
  const innerShadow = renderTemplate(VIG_SOMETHING.html, { /* data */ });
  return declarativeShadow("vig-something", {
    "some-attr": "value",
    variant: "feed",
  }, VIG_SOMETHING, innerShadow, /* optional: lightChildren */);
}
```

### Slotted children met named slots

Component HTML:
```html
<article>
  <header><slot name="header"></slot></header>
  <main><slot></slot></main>
  <footer><slot name="footer"></slot></footer>
</article>
```

SSR side:
```js
return declarativeShadow("vig-x", {}, VIG_X, innerShadow, `
  <h1 slot="header">${title}</h1>
  <p>${content}</p>
  <button slot="footer" data-on-click="…">${buttonLabel}</button>
`);
```

## Quick reference

### Bestaande componenten

| Component             | Soort         | Doel                                       |
| --------------------- | ------------- | ------------------------------------------ |
| `vig-card`            | Markup-only   | Post-chrome (header, caption, meta) + slot |
| `vig-hot-shots`       | Stateful      | Cycling preview <video> + IntersectionObs  |
| `vig-stories-bar`     | Markup-only   | Layout shell voor `<vig-story>` kinderen   |
| `vig-story`           | Markup-only   | Single collection avatar (leaf)            |
| `vig-view-toggle`     | Markup-only   | Layout voor 2 slotted Datastar-buttons     |
| `vig-detail`          | Markup-only   | Page-level black backdrop voor vig-player  |
| `vig-nav-top`         | Markup-only   | Sticky top bar                             |
| `vig-nav-bottom`      | Markup-only   | Fixed bottom nav                           |
| `vig-gallery-grid`    | Markup-only   | Grid layout shell                          |

### Build.js: belangrijke functies

| Functie                          | Wat het doet                                |
| -------------------------------- | ------------------------------------------- |
| `loadComponentSources(name)`     | Lees html/css/js van een component-folder   |
| `bundleComponent(name)`          | Produceer ESM bundle in `_site/components/` |
| `declarativeShadow(tag, …)`      | Wrap shadow + light children in HTML markup |
| `renderTemplate(template, data)` | Vul {{var}} / {{#each}} placeholders in     |
| `renderVigX(...)`                | SSR render per component (één per element)  |

### Build.js: belangrijke arrays/constants

| Constant              | Doel                                              |
| --------------------- | ------------------------------------------------- |
| `FEED_COMPONENTS`     | Welke bundles geladen op feed-pagina              |
| `DETAIL_COMPONENTS`   | Welke bundles geladen op detail-pagina            |
| `ALL_COMPONENTS`      | Union — wat gebundled moet worden                 |
| `LAYOUT_TPL`          | `_layout.html` content (geladen bij init)         |
| `FEED_TPL`            | `feed.html`                                       |
| `FEED_EMPTY_TPL`      | `feed-empty.html`                                 |
| `DETAIL_TPL`          | `detail.html`                                     |

### Template engine syntax

| Syntax                            | Wat het doet                              |
| --------------------------------- | ----------------------------------------- |
| `{{path}}`                        | Escaped lookup                            |
| `{{{path}}}`                      | Raw lookup (alleen voor trusted HTML)     |
| `{{a.b.c}}`                       | Dotted lookup                             |
| `{{#each items}} … {{/each}}`     | Loop over array                           |
| `{{this}}` (binnen each)          | Het huidige item                          |
| `{{prop}}` (binnen each)          | Prop van het huidige object-item          |

## Veelgemaakte fouten

- **Datastar-attributes in shadow DOM**: werkt niet. Verplaats naar slotted
  light-DOM kinderen.
- **Backticks in CSS-comments**: NVT meer (CSS staat in `.css` files, niet
  in template literals). Was vroeger een steeds-terugkerende fout.
- **`box-sizing` vergeten in shadow CSS**: shadow DOM heeft geen toegang
  tot het `* { box-sizing: border-box; }` reset uit `style.css`. Voeg toe
  aan elke component CSS als je `padding` en `width` mengt.
- **Vergeten `bundleComponent` te triggeren**: gebeurt automatisch via
  `ALL_COMPONENTS` in `build.js`'s build-stap, maar alleen als je de
  component aan een van de arrays (`FEED_COMPONENTS` / `DETAIL_COMPONENTS`)
  hebt toegevoegd.
- **`closest('a')` van binnen shadow DOM**: vindt niets als de `<a>` ook
  in een ander shadow root zit. Slot het `<a>` in light DOM als je naar
  ancestors moet kijken.
- **`:host { max-width + margin: 0 auto }` voor centering**: werkt NIET
  zolang `src/style.css` een `* { margin: 0 }` reset bevat. Light-DOM CSS
  reikt tot het host-element van een custom element (omdat de host zélf
  in light DOM staat) én heeft hogere cascade-prioriteit dan `:host`
  styles (document-author origin > shadow-tree origin). De `* { margin: 0
  }` overruled dus `:host { margin: 0 auto }` en de host centreert niet.
  Fix: zet `max-width` + `margin: 0 auto` (en eventueel `border-bottom`,
  background, etc.) op een **inner element binnen de shadow root** in
  plaats van op `:host`. Light-DOM CSS bereikt de inner shadow content
  niet, dus daar werkt centering normaal. Voor sticky-componenten: laat
  `:host` de full-width sticky container zijn (background matched body)
  en centreer de visuele frame op het inner element. Zie
  `vig-nav-top.css`, `vig-stories-bar.css`, en `vig-view-toggle.css` voor
  het patroon.

## Ontwikkelen

Tijdens `npm run dev`:

- `serve.js` watch'd `src/` recursief — edits aan `.html`, `.css`, `.js`
  in `src/` triggeren automatisch een rebuild.
- Browser cache'd component-bundles. Hard refresh (Cmd-Shift-R) na een
  edit aan een component file.
- `VIG_DEBUG=1 npm run dev` logt elke ffmpeg-call.

## Wanneer een nieuw bestand aan de drie toevoegen?

Soms heb je extra fragmenten nodig (bijv. een sub-template binnen een
component dat zelf geen leaf-component verdient). Conventie:

```
vig-something/
├── vig-something.html       ← hoofdtemplate
├── vig-something.css
├── vig-something.js
└── _item.html               ← prefix met _ voor interne fragmenten
```

`build.js` leest dat `_item.html` apart in via een eigen `readFile`-call
in de render-functie. De `bundleComponent` regex matcht alleen de drie
"officiële" files dus interne fragments blijven server-side only.

(Op het moment hebben we hier geen voorbeelden van — vig-stories-bar's
items leven als eigen `vig-story` component. Pas wanneer een gedeelde
fragment niet het waard is om een echte leaf-component te zijn.)
