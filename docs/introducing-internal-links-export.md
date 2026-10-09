---
title: I Built an Open-Source Internal Link Visualization Tool That Exports Your Link Graph as CSV, GEXF, or GraphML
published: false
tags: seo, opensource, javascript, webdev
---

Every site owner eventually asks the same question: *which pages on my site actually link to which other pages?* Not what your CMS template says it does, not what the navigation menu claims — what the rendered HTML of every single page really contains. The answer is the difference between an SEO audit and a guess.

I open-sourced a tool that answers it end to end: [**internal-links-export**](https://github.com/partick33/internal-links-export) (the Link Topology Explorer). It crawls any website, builds the complete internal link graph, renders it as an interactive single-file report, and exports it in every format a human, a spreadsheet, or an LLM would want — including an **edge list CSV**, **GEXF**, and **GraphML**.

```bash
git clone https://github.com/partick33/internal-links-export.git
cd internal-links-export

node link-topology.mjs https://example.com --out ./out   # crawl + analyze
node render-html.mjs --dir ./out                          # compile the report
open ./out/topology.html                                  # everything is inlined
```

No `npm install`. Node ≥ 22, zero dependencies, MIT license.

## What "complete" means here

Most link checkers sample. This tool enumerates:

- **Discovery**: reads `/sitemap.xml` and sitemap indexes recursively; if a site has no sitemap at all, it falls back to BFS crawling from the root page, following internal `<a href>` links only (with trailing-slash retry for pretty-URL static sites).
- **Extraction**: anchor-scope links only — `src`, canonicals, external links and asset extensions are ignored; fragments, query strings and trailing slashes are normalized.
- **Navigation filtering**: this is the part most homegrown scripts get wrong. Headers, footers and menus appear on *every* page, so raw link counts are dominated by them. The tool detects these "chrome" edges **from the data itself**: any target linked from ≥ 90% of crawled pages (threshold configurable) is treated as site-wide navigation, separated from content links, and excluded from degree metrics. No per-site hardcoded nav lists.
- **Analysis**: per-page in/out degree, orphan pages, zero-outlink dead ends, top-linked pages, cross-cluster flows, and a faithful `fetchFailures` list — if a page couldn't be crawled, the report says so instead of silently dropping it.

## The interactive report: one HTML file, works offline

`render-html.mjs` compiles the crawl into a single `topology.html` — Cytoscape.js and the fCoSE layout engine are inlined at build time, so the artifact opens from disk with no server and no network. Three coordinated views:

- **Cluster view** — the whole site's clusters as cards with cross-cluster in/out counts.
- **Page view** — the page-level graph with clusters as compound boxes, ghost nodes for non-sitemap pages, and click-through to any page's full in/out link lists.
- **Data view** — sortable tables for top in-degree pages, cross-cluster edges, orphans, dead ends and crawl failures.

## Big sites are where it gets interesting

Flat e-commerce catalogs break naive link visualizers. The site I built this for has **3,931 product pages at `/products/{slug}`** — no category in the URL, no path structure to group by. Rendered as one graph it's a hairball; rendered as a table it's meaningless.

The tool recovers the category structure **from the link graph itself**: every non-hub page is grouped under its strongest content in-link source — the category page that links to it most. On that site this reconstructs **268 category groups covering 92% of products**, each small enough to read as a graph (≤ 99 pages).

Above roughly 1,500 pages the page view switches to a bounded drill-down model — *cluster → category directory → category group graph* — and the directory exists on **both sides**: the 3,931-page products cluster gets a directory of all 268 groups, and the `dog` / `cat` / `fish` category clusters each get their own directory of the groups they anchor. Wherever you enter, the same two gestures apply: double-click a category page to open its group graph, double-click an aggregate block to jump to that cluster. Dense category trees (a 104-node cluster with 1,930 breadcrumb links) automatically switch to a deterministic grid layout and render in ~265 ms.

## Export internal links as an edge list (the part LLMs care about)

The export menu produces `link-topology-<domain>-<date>.*` files:

| Format | Contents | Best for |
|---|---|---|
| **Edge list CSV** | one row per link: `from,to,count,type` | AI analysis, spreadsheets |
| Pages CSV | path, cluster, degrees, orphan / dead-end flags | audits, crawl diffing |
| Clusters CSV | per-cluster pages, internal and cross links | silo overviews |
| **GEXF** | directed graph + cluster colors + degree attributes | Gephi |
| **GraphML** | typed attributes, standard schema | Cytoscape, yEd, NetworkX |
| JSON | the crawl verbatim | custom tooling |
| PNG | current view or full layout | docs and decks |

The edge list is the quiet workhorse. "Export internal links as an edge list" sounds trivial until you try to get one: most tools give you a rendered report or a proprietary database, not the raw `from → to` pairs. A flat CSV is the easiest format in the world for an LLM to reason over — paste it (or a slice of it) into a chat, ask "which hub pages should link to this orphan?", and you get an answer grounded in your actual site. The CSVs carry a UTF-8 BOM, so Excel opens them without the encoding dance.

For real graph work, GEXF keeps the visual encoding (nodes carry their cluster color and size by in-degree) so Gephi shows your site's silo structure immediately on import; GraphML covers Cytoscape desktop, yEd and NetworkX if that's your stack.

## Honest limitations

- Sites behind interactive challenges (Cloudflare etc.) can't be fetched by Node — TLS fingerprint mismatch; even a valid `cf_clearance` cookie doesn't help. The supported path is passing the challenge in a real browser and injecting that page's `fetch` into the collector: `collectTopology({ fetchImpl })`. On the reference site this recovered 930/931 sitemap pages; the one failure was a login-only member page, recorded in `fetchFailures`.
- The report UI's chrome text (buttons, labels) is currently Simplified Chinese — paths, graphs and data are language-neutral, and an English UI is on the roadmap. PRs welcome.

## Try it

The repo is [partick33/internal-links-export](https://github.com/partick33/internal-links-export) — 12 unit and end-to-end tests (`npm test`, `fetch` injectable, no network needed), MIT licensed, and generic across sites: point it at any URL and it adapts, because nothing in it knows anything about any particular site.

If you audit internal linking, feed link data to AI pipelines, or just want your site's link graph in Gephi — this is your one-command pipeline.
