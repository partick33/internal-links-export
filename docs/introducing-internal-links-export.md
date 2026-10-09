---
title: My AI-Built Site's Internal Links Were Unmanageable — So I Mapped the Whole Graph Before Touching Anything
published: false
tags: seo, ai, opensource, webdev
---

My site is built largely by AI now — code and content. It's fast, and I'm not going back. But a few months in I noticed something nobody warns you about: **internal linking is the one lever AI never managed**, because it's site-wide state, not page state.

Every page was generated in isolation, with local context only. Each one *looks* well-linked — sensible related links, breadcrumbs, a nav menu. Nobody, me or the model, was keeping a ledger of the whole graph. Multiply that by hundreds of pages and you get what I got:

- pages competing for the same queries, each hoarding a slice of the in-links that should have gone to one canonical page;
- orphans with zero content in-links, invisible to ranking and to me;
- dead ends that link nowhere, wasting their equity;
- and no way to answer the basic question: *which page should I strengthen, and where would those links even come from?*

I'm planning a round of link consolidation — merging near-duplicate pages and re-pointing links toward the pages that already rank. Before editing anything, I wanted to see the actual graph: every `from → to`, from rendered HTML, not from what the templates claim they do.

## Why the obvious tools didn't fit

I looked for an internal link visualization tool I could just point at a site. Commercial crawlers give you a report about your links; I wanted the *raw graph* — the kind you can diff after a change, join against Search Console data, or hand to an LLM. Homegrown scripts got one thing consistently wrong: navigation. Header/footer links appear on every page, so raw counts say "everything links to everything" and hide the ~5% of links that actually carry meaning.

So I built the instrument I needed, and open-sourced it: [internal-links-export](https://github.com/partick33/internal-links-export). It crawls a site (sitemap or BFS fallback), separates site-wide navigation from content links using a data-driven rule (any target linked from ≥ 90% of crawled pages is treated as chrome — no hardcoded nav lists), and compiles everything into a single offline HTML report plus exports. Zero dependencies, MIT. That's the whole pitch; the rest of this post is what the graph actually told me, because that's the part that transfers to your site.

## What the graph showed

My own site — [petguidecalc.com](https://petguidecalc.com/), an English pet-care guide and calculator site, 231 pages, AI-built like the rest — produced a sobering but manageable picture: the orphans, the topic twins splitting in-links, the uniform hubs. But I didn't want an instrument that only works at that scale, so I stress-tested it against a deliberately hostile target I don't own: a large third-party e-commerce site whose link graph resolves to **4,868 pages, 3,931 of them flat product URLs** at `/products/{slug}` — no category in the path, nothing to group by. As one graph: hairball. As a table: meaningless.

The tool recovered the de-facto taxonomy from the link structure itself: every non-hub page grouped under its **strongest content in-link source** — whichever category page links to it most. That reconstructed **268 category groups covering 92% of products**, each small enough to actually read. This was the moment the tool became useful: the site's real information architecture exists in its links, even when it exists nowhere else.

Three views carry most of the diagnostic weight:

- **In-degree distribution** — which pages hoard equity (hubs linking in from everywhere) and which are starved. My orphans and near-orphans fell out of this list immediately.
- **The category group graph** — double-click into any group and see the category page, its member pages, and exactly which members link back. The missing back-links are the cheapest wins in the whole audit.
- **Cross-cluster flows** — where topic silos accidentally link to each other, and where they never do.

## The consolidation plan this produces

With the graph exported (pages CSV + edge list CSV), the workflow I'm running is:

1. **Join pages against Search Console** — impressions and average position per URL. This splits every page into "earns traffic" / "exists but starved" / "competes with a sibling".
2. **Find merge candidates** — same-topic pages whose in-links are split between them. Merge the weaker one in, redirect it, and re-point every inbound link to the survivor. The edge list makes this mechanical: filter `to == weak-page`, and you have the exact edit list.
3. **Re-point links toward the pages that rank** — for each strong page, look at its topic neighborhood in the graph and find pages that link generically (nav-only) or to the wrong sibling. Specific links from relevant pages, not more links from everywhere.
4. **Fix the floor first** — every orphan gets at least one content in-link from its topic hub; every dead end links out to its siblings. These are one-line edits each, and they're the ones nothing else was going to catch.
5. **Re-crawl and diff** — run the crawler again after changes and diff the edge list CSV. The graph becomes a regression test for information architecture: consolidation should show in-links concentrating on fewer, stronger pages.

Step 5 is why I cared so much about exports rather than a pretty report. A graph you can't diff is a screenshot; a graph you can diff is an instrument.

## Where AI comes back into it

The irony isn't lost on me: the mess came from page-level generation with no global view, and the cleanup is now AI-assisted too — but this time the model gets to *see the whole graph*. Export internal links as an edge list (one row per `from, to, count, type`), hand it to an LLM with the Search Console table, and ask for merge candidates and re-pointing proposals. It's the same trick as the generation failure, reversed: global state supplied as context. GEXF and GraphML exports are there for the days I want to look at it in Gephi instead.

## Notes from the trenches

- Sites behind Cloudflare-style challenges can't be fetched from Node (TLS fingerprint mismatch — a valid `cf_clearance` cookie doesn't help). The working path: pass the challenge in a real browser, then inject that page's `fetch` into the collector. That recovered 930/931 sitemap pages on the test site; the one failure was a login-only page, recorded honestly in the crawl output.
- Dense category trees (one 104-node cluster had 1,930 breadcrumb links) need a deterministic layout, not force-directed — force layouts collapse them into a ball. The tool switches automatically and renders that cluster in ~265 ms.
- The report UI's chrome text is currently Simplified Chinese; paths and graphs are language-neutral. An English UI is on the roadmap — PRs welcome.

The repo is [partick33/internal-links-export](https://github.com/partick33/internal-links-export) — crawler, single-file report, CSV/GEXF/GraphML/JSON exports, 12 tests, MIT. It's a means, not a product: the point was never the tool, it was getting the graph on the table before restructuring a site that grew faster than its linking could keep up.
