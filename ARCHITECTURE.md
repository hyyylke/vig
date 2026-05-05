# vig — architectuur

Dit document beschrijft hoe `vig` is opgebouwd. Voor de praktische "hoe maak
ik een nieuwe component" gids: zie [COMPONENTS.md](COMPONENTS.md).

## Wat vig is

Een statische site-generator voor een persoonlijke video-galerij. Wijst naar
een folder met `.mp4`/`.mov`/`.webm`/`.m4v` files en produceert een
browseable site met TikTok-style cycling previews, deep-linkable shots, een
watch-heatmap, en een in-place clip-marking player.

Geen framework. Geen runtime npm-dependencies in de browser (behalve Datastar
via CDN voor de view-toggle en de externe `<vig-player>` web component). De
hele site is statisch genereerd; de dev-server is alleen voor development +
de shots/heat API.

## Folder layout

```
vig/
├── src/
│   ├── style.css                ← light-DOM utilities (~140 regels)
│   ├── lib/
│   │   └── template.js          ← engine: {{var}}, {{{raw}}}, {{#each}}
│   ├── components/              ← 9 componenten × 3 files
│   │   ├── vig-card/
│   │   │   ├── vig-card.html
│   │   │   ├── vig-card.css
│   │   │   └── vig-card.js
│   │   ├── vig-hot-shots/
│   │   ├── vig-stories-bar/
│   │   ├── vig-story/
│   │   ├── vig-view-toggle/
│   │   ├── vig-detail/
│   │   ├── vig-nav-top/
│   │   ├── vig-nav-bottom/
│   │   └── vig-gallery-grid/
│   └── pages/
│       ├── _layout.html          ← <html>/<head>/<body> wrapper
│       ├── feed.html             ← gallery body
│       ├── feed-empty.html       ← empty-state body
│       └── detail.html           ← detail page body
├── build.js                       ← orchestrator (geen markup, geen CSS)
├── serve.js                       ← dev server + shots/heat API + watcher
├── cli.js                         ← bootstrap-CLI (vig command)
├── vig.sh                         ← shell-bootstrap (curl … | sh)
└── vig-player.js                  ← extern web component (eigen project)
```

Build output: `_site/` (volledig wegooibaar; alle artifacts) + `.vig/meta/`
(persistent user data: shots.json, heat.json).

## Build pipeline

`build.js` is de orchestrator. Hij doet, in deze volgorde:

1. **Walk** — recursief videofiles vinden onder `VIG_VIDEOS`.
2. **Slug + post-objects** maken (uniek per file).
3. **Sidecars laden** (shots.json, heat.json) per post.
4. **Output dirs aanmaken** + opruimen van legacy folders.
5. **Hardlink** elke source-video naar z'n `_site/post/<slug>/video.<ext>`.
6. **Genereer thumbnails + previews** via ffmpeg (3 fasen: parallel
   state-gather, parallel fresh-cleanup, sequential stale-encode).
7. **Per-post `meta.json` schrijven** (zelfbeschrijvend post-object).
8. **`vig-player.js` linken** naar `_site/`.
9. **`style.css` kopiëren** (`src/style.css` → `_site/style.css`).
10. **Componenten bundlen** — voor elke entry in `ALL_COMPONENTS`,
    produceer een ESM-bundle in `_site/components/<name>.js`.
11. **`index.html` schrijven** (feed page).
12. **Detail-pagina's schrijven** — één per post.
13. **Orphan posts opruimen** — folders in `_site/post/` zonder bijbehorende
    valid slug.

Caching: `.build-meta.json` per post stelt herhaalde builds vrijwel gratis te
zijn (mtime-fast-path → size-fallback → re-encode met metadata-cache). Een
content-aware encoder kiest CRF/preset/tune op basis van bits-per-pixel-per-
seconde van de source.

## Het component-systeem

Elke component is een folder onder `src/components/<name>/` met **drie
bestanden**:

```
vig-card/
├── vig-card.html      ← shadow-DOM markup met {{var}} placeholders
├── vig-card.css       ← scoped styles (alleen binnen :host's shadow)
└── vig-card.js        ← class extends HTMLElement, customElements.define
```

Bij elke build doet `build.js` voor elke component twee dingen:

1. **Server-side render via Declarative Shadow DOM.** De `renderVigX(...)`
   functies in `build.js` produceren statische HTML die er zo uitziet:
   ```html
   <vig-card>
     <template shadowrootmode="open">
       <style>/* component CSS */</style>
       /* component HTML */
     </template>
     /* eventuele slotted light-DOM kinderen */
   </vig-card>
   ```
   De browser parsereert de Declarative Shadow DOM tijdens HTML-parsing —
   geen JS nodig voor de eerste paint.

2. **Bundlen tot een ESM-module.** `bundleComponent(name)` leest de drie
   files, inlinet de `template.js` helper, vervangt de `"__TEMPLATE__"` en
   `"__STYLES__"` sentinels met de echte content (JSON-stringified), en
   schrijft een self-contained ESM naar `_site/components/<name>.js`. De
   feed/detail pages laden alleen de bundles die ze nodig hebben — gestuurd
   door `FEED_COMPONENTS` en `DETAIL_COMPONENTS` arrays in build.js.

Bij client-side hydration (de browser parst HTML, ziet `<vig-card>`,
upgrade'd het tot de geregistreerde class):

- Als `this.shadowRoot` al bestaat (Declarative Shadow DOM was emit'd), doet
  `connectedCallback` niets — de pagina is al volledig gerenderd.
- Als er geen shadow root is (bv. element via JS aangemaakt), valt de class
  terug op client-side rendering met dezelfde template-engine.

### Markup-only vs. stateful componenten

Twee soorten componenten ontstaan vanzelf:

- **Markup-only**: vig-card, vig-stories-bar, vig-story, vig-view-toggle,
  vig-detail, vig-nav-top, vig-nav-bottom, vig-gallery-grid. JS doet niets
  meer dan `customElements.define()` plus een client-side fallback render.
- **Stateful**: vig-hot-shots. Class met lifecycle (connectedCallback,
  disconnectedCallback), shared IntersectionObserver, event handlers,
  href-syncing.

Beide passen in dezelfde drie-files-structuur. Geen architecturale
discriminatie tussen "containers" en "presentation" — het hangt puur af van
wat de component nodig heeft.

## Page templates

Niet alles wat je hergebruikt is een component. **Page templates** zijn
markup-only `.html` bestanden onder `src/pages/`. Ze hebben geen shadow DOM,
geen lifecycle, geen JS — alleen `{{var}}` / `{{{raw}}}` / `{{#each}}`
placeholders die `build.js` invult.

| Template            | Doel                                               |
| ------------------- | -------------------------------------------------- |
| `_layout.html`      | `<html>`/`<head>`/`<body>` skelet, gemeenschappelijk |
| `feed.html`         | Body van de feed-pagina (met cards + gallery)       |
| `feed-empty.html`   | Body wanneer er 0 video's zijn                      |
| `detail.html`       | Body van een detail-pagina                          |

Waarom geen `<vig-feed-page>`-component? Omdat een feed-pagina-component
alléén een leeg shadow root met een grote `<slot>` zou bevatten — geen
encapsulation, alleen overhead. Datastar's `data-show`/`data-signals`
attributes moeten in light DOM blijven (Datastar's MutationObserver scant
geen shadow roots), dus alle reactieve markup moet sowieso buiten een
component.

**Vuistregel**: gebruik een component als er encapsulation, scoped styling,
of behavior is. Gebruik een page template als het alleen markup is met
variabelen.

## De template engine

`src/lib/template.js`, ~30 regels:

```
{{path}}                       → escaped value
{{{path}}}                     → raw value (alleen voor trusted HTML)
{{a.b.c}}                      → dotted lookup
{{#each items}} … {{/each}}    → loop; binnenin: {{this}}, {{prop}}, {{this.x}}
```

Bewust geen conditionals, geen nested loops. Voor branchy markup: pre-render
in JS, geef door als `{{{slot}}}`. De engine wordt server-side gebruikt voor
SSR + page templates, en wordt inline meegebundeld in elke component voor
client-side fallback rendering.

## Belangrijke design-keuzes en hun waarom

### Geen framework, geen bundler-runtime

vig heeft 0 npm-dependencies in productie. Datastar (CDN) en `<vig-player>`
(eigen package) zijn de enige browser-runtime imports. Voordeel: 1-second
cold-start, geen toolchain rot, geen package-vulnerabilities. Trade-off:
geen TypeScript types in IDE zonder JSDoc-routes, en de mini-template-engine
heeft minder features dan Mustache/Handlebars.

### Declarative Shadow DOM voor SSR

Componenten worden server-side gerenderd in `<template shadowrootmode="open">`
elementen. De browser parsereert deze direct tijdens HTML-parsing en de
shadow DOM is "operational" zónder dat JS ooit hoeft te draaien. Eerste
paint is dus instant en complete. JS hydrateert alleen voor lifecycle/
behavior — de visuele kant is al "klaar".

### Componenten encapsuleren behavior, niet de hele pagina

Datastar bindings (`data-on-click`, `data-class-active`, `data-show`) werken
alleen op elementen in de **light DOM**, omdat Datastar's MutationObserver
niet door shadow boundaries heen kijkt. Componenten met interactieve buttons
(zoals `vig-view-toggle`) houden de buttons in **slotted light-DOM kinderen**
en gebruiken shadow DOM alleen voor de layout-wrapper. Op die manier krijgen
we én scoped styling én reactieve attributes die werken.

### Pure SSR — JS draait alleen voor lifecycle

De gerenderde HTML is functioneel volledig zonder dat de component-bundles
laden. Loaden de bundles? De browser upgrade'd de elementen naar hun class,
maar `connectedCallback` ziet `this.shadowRoot` al en doet niks. Alleen
`vig-hot-shots` heeft echte side-effects (IntersectionObserver registreren,
event handlers, video-lifecycle).

### Hardlinks in plaats van kopieën

Source-video's worden ge-hardlinked naar `_site/post/<slug>/video.<ext>` in
plaats van gekopieerd. Zelfde inode → 0 disk overhead → instant builds.
Hardlinks gedragen zich als gewone files voor de static server (in
tegenstelling tot symlinks, die `serve.js` weigert wanneer ze buiten de
root wijzen).

### Een mini-bundler in plaats van esbuild

`bundleComponent(name)` is ~25 regels code: imports strippen, exports
strippen, sentinels vervangen, write naar `_site/components/`. Dat is
"genoeg voor 9 componenten". Bij ~20+ componenten of als we tree-shaking
nodig hebben, esbuild voor de browser-bundle is een natuurlijke volgende
stap. Voor nu: geen toolchain, geen build-cache, geen versies om bij te
houden.

### Per-post folder layout

Elk post heeft een complete self-contained folder:

```
_site/post/<slug>/
├── index.html
├── meta.json
├── poster.jpg
├── preview.mp4
└── video.<ext>
```

Verplaats die hele folder naar een andere server: nog steeds een werkende
detail-pagina (de feed-link werkt natuurlijk niet meer, maar de pagina
zelf werkt). Geen verborgen state in databases, geen relatieve paden naar
buiten de folder.

### Persistente data los van build artifacts

`.vig/meta/<slug>/{shots.json,heat.json}` blijft staan zelfs als je
`_site/` wist voor een full rebuild. shots zijn user-bewerkte data, heat is
geaccumuleerd over tijd — beide hoort *niet* tot het build-output dat je
zonder zorgen mag wegooien.

## Wat bewust níet gedaan is

- **TypeScript** — geen build-stap is een feature. JSDoc kan typed editing
  geven zonder runtime kosten, maar voorlopig: niet nodig.
- **Tests** — geen tests behalve handmatige verificatie van builds. Bij de
  huidige scope (één gebruiker, één persoonlijk project) is de cost/benefit
  niet positief. Logische volgende stap als we ooit op `previewPlan` of
  `qualityTier` willen refactoren zonder twijfel.
- **Multi-library support** — vig draait per-folder. Cross-folder queries
  (welke clip heb ik vorige week het meest bekeken) zou een SQLite-DB
  vereisen. Nu niet de moeite waard.
- **Service workers / PWA / offline** — desktop usage, geen mobile-app vibe
  nodig. Toegevoegd complexity zonder duidelijke meerwaarde.
- **Een UI-framework** — Datastar (CDN) + 200 regels JS in `videoPlayerScript`
  doet alles wat we willen.
- **Bundler voor browser** — esbuild ja, runtime nee. We hebben *geen*
  Vite/webpack. De bundling die we doen is custom in build.js (~25 regels).

## Files dat niet meer in build.js leven

Voor historische context: bij de start van het project zat *alles* in
`build.js` — een 1955-regel god-file met inline markup, inline CSS, en
inline browser-JS als template literals. Stand vandaag:

| Was inline in build.js                  | Woont nu in                                |
| --------------------------------------- | ------------------------------------------ |
| Card markup (`feedCard`)                | `src/components/vig-card/`                 |
| Hot-shots markup + cycle JS             | `src/components/vig-hot-shots/`            |
| Stories bar markup                      | `src/components/vig-stories-bar/`          |
| Story-item markup                       | `src/components/vig-story/`                |
| View toggle markup + Datastar bindings  | `src/components/vig-view-toggle/`          |
| Detail-page wrapper                     | `src/components/vig-detail/`               |
| Top nav                                 | `src/components/vig-nav-top/`              |
| Bottom nav                              | `src/components/vig-nav-bottom/`           |
| Gallery grid container                  | `src/components/vig-gallery-grid/`         |
| Page shells (shell, feedPage, detailPage) | `src/pages/*.html` + render-functies     |
| Hele CSS template literal               | `src/style.css`                            |
| Cycling JS in `videoPlayerScript`       | `vig-hot-shots.js`                         |

Wat nog wel in build.js woont: `videoPlayerScript()` (heat tracking + audio
persistence + vig-player wiring) — laatste inline browser-JS. Logische
volgende migratie: `src/runtime/detail.js` als statisch bestand.
