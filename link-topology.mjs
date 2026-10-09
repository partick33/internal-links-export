#!/usr/bin/env node
/**
 * 通用站点内链拓扑工具（零仓库耦合，可对任意站点运行）：
 * 以 sitemap（/sitemap.xml 或 /sitemap-index.xml → 子表）发现页面清单；站点无 sitemap
 * 时退化为从根页面沿站内 <a> 链接 BFS 抓取。逐页抓取 HTML、抽取站内锚点链接，构建
 * 页面→页面邻接拓扑，输出 JSON 邻接表 + 集群级 Mermaid 图，并给出摘要（全站导航边、
 * 孤儿页、入度榜、跨集群边）。集群按 URL 路径前 N 段聚合，不依赖任何站点特定约定。
 *
 * 用法：node link-topology.mjs <base-url> [options]
 *   --sitemap <url>          显式 sitemap 地址（默认依次探测 /sitemap.xml、/sitemap-index.xml）
 *   --out <dir>              输出目录（默认 node_modules/.cache/link-topology）
 *   --concurrency <n>        并发抓取数（默认 6）
 *   --timeout-ms <n>         单请求超时毫秒（默认 15000，失败重试 1 次）
 *   --chrome-threshold <f>   全站导航边判定：目标被 ≥ 该比例的已抓页面链接（默认 0.9）
 *   --cluster-depth <n>      集群聚合的路径段数（默认 1）
 *   --max-pages <n>          BFS 兜底模式的页数上限（默认 500）
 *   --full                   额外输出页级 Mermaid 图 topology-full.mmd
 *   --include-chrome         Mermaid 中保留全站导航边（虚线）；默认剔除
 *   --help                   显示用法
 *
 * 示例：node link-topology.mjs https://example.com
 *       node link-topology.mjs http://localhost:4321 --out ./topology --full
 *
 * 退出码：抓取失败导致数据不全时为 1；拓扑分析结果本身不设失败门槛。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOC_RE = /<loc>([^<]+)<\/loc>/g;
const IS_SITEMAP_INDEX_RE = /<\s*sitemapindex[\s>]/;
// 只收锚点作用域的 href（含单引号形态）；src / <link canonical> 等不构成页面拓扑边。
const ANCHOR_HREF_RE = /<a\b[^>]*?\bhref\s*=\s*["']([^"']*)["']/g;
// 资产/二进制扩展名：既不进 BFS 队列，也不作为拓扑节点（.html/.htm/.md/.php 等页面形态保留）。
const ASSET_EXT_RE =
 /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|css|js|mjs|cjs|map|json|xml|txt|pdf|zip|gz|tar|woff2?|ttf|eot|otf|mp3|mp4|webm|mov|csv)$/i;
const MAX_SITEMAPS = 20;

export function parseSitemap(xml) {
  const urls = [];
  for (const match of xml.matchAll(LOC_RE)) urls.push(match[1].trim());
  return { kind: IS_SITEMAP_INDEX_RE.test(xml) ? 'index' : 'urlset', urls };
}

/** URL → 站内路径：去 fragment/query、统一尾斜杠；跨域或非 http(s) 返回 null。 */
export function normalizeUrl(href, pageUrl, host) {
  if (!href) return null;
  let url;
  try {
    url = new URL(href, pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.host !== host) return null;
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

export function extractInternalLinks(html, pageUrl, host) {
  const links = new Set();
  for (const match of html.matchAll(ANCHOR_HREF_RE)) {
    const path = normalizeUrl(match[1], pageUrl, host);
    if (path && !ASSET_EXT_RE.test(path)) links.add(path);
  }
  return links;
}

export function clusterOf(path, depth = 1) {
  const segments = path.split('/').filter(Boolean).slice(0, depth);
  return segments.length > 0 ? segments.join('/') : '(root)';
}

function urlToPath(rawUrl) {
  const url = new URL(rawUrl);
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

/** nodes: Map<path, {inSitemap}>；edges: [{from, to, count}]（自环剔除，count 去重计数）。 */
export function buildGraph(pageUrls, linksByPage) {
  const nodes = new Map();
  for (const rawUrl of pageUrls) nodes.set(urlToPath(rawUrl), { inSitemap: true });
  const edges = new Map();
  for (const [from, links] of Object.entries(linksByPage)) {
    for (const to of links) {
      if (!nodes.has(to)) nodes.set(to, { inSitemap: false });
      if (from === to) continue;
      const key = `${from}\u0000${to}`;
      const edge = edges.get(key) ?? { from, to, count: 0 };
      edge.count += 1;
      edges.set(key, edge);
    }
  }
  return { nodes, edges: [...edges.values()] };
}

/** 全站导航目标：被 ≥ threshold 比例的已抓页面链接的目标（数据驱动，无需硬编码导航清单）。 */
export function detectChromeTargets(edges, fetchedPageCount, threshold = 0.9) {
  const sourcesPerTarget = new Map();
  for (const edge of edges) {
    if (!sourcesPerTarget.has(edge.to)) sourcesPerTarget.set(edge.to, new Set());
    sourcesPerTarget.get(edge.to).add(edge.from);
  }
  const chrome = new Set();
  for (const [target, sources] of sourcesPerTarget) {
    if (fetchedPageCount > 0 && sources.size / fetchedPageCount >= threshold) chrome.add(target);
  }
  return chrome;
}

/** 度数/孤儿/入度榜/跨集群边均只统计非 chrome 边（chrome 会淹没真实内容拓扑）。 */
export function analyze(graph, chromeTargets, clusterDepth = 1) {
  const nodes = [...graph.nodes.entries()].map(([path, info]) => ({
    path,
    cluster: clusterOf(path, clusterDepth),
    inSitemap: info.inSitemap,
    chrome: chromeTargets.has(path),
    inDegree: 0,
    outDegree: 0,
  }));
  const byPath = new Map(nodes.map((node) => [node.path, node]));
  const edges = graph.edges.map((edge) => ({ ...edge, chrome: chromeTargets.has(edge.to) }));
  for (const edge of edges) {
    if (edge.chrome) continue;
    byPath.get(edge.to).inDegree += edge.count;
    byPath.get(edge.from).outDegree += edge.count;
  }
  const orphans = nodes
    .filter((node) => node.inSitemap && !node.chrome && node.inDegree === 0)
    .map((node) => node.path)
    .sort();
  const topInDegree = nodes
    .filter((node) => !node.chrome && node.inDegree > 0)
    .sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path))
    .slice(0, 10)
    .map((node) => ({ path: node.path, inDegree: node.inDegree }));
  const clusterByPath = new Map(nodes.map((node) => [node.path, node.cluster]));
  const crossPairs = new Map();
  for (const edge of edges) {
    if (edge.chrome) continue;
    const fromCluster = clusterByPath.get(edge.from);
    const toCluster = clusterByPath.get(edge.to);
    if (fromCluster === toCluster) continue;
    const key = `${fromCluster}\u0000${toCluster}`;
    const record = crossPairs.get(key) ?? { from: fromCluster, to: toCluster, count: 0 };
    record.count += edge.count;
    crossPairs.set(key, record);
  }
  return { nodes, edges, orphans, topInDegree, crossClusterEdges: [...crossPairs.values()] };
}

function mmdId(prefix, key) {
  return `${prefix}_${key.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

function mmdLabel(text) {
  return `"${String(text).replace(/"/g, "'")}"`;
}

/** 集群级聚合图：节点=集群（标注页面数），边=聚合次数；chrome 边默认剔除，保留时虚线。 */
export function toClusterMermaid(analyzed, { includeChrome = false } = {}) {
  const clusterPageCounts = new Map();
  for (const node of analyzed.nodes) {
    clusterPageCounts.set(node.cluster, (clusterPageCounts.get(node.cluster) ?? 0) + 1);
  }
  const lines = ['graph LR'];
  for (const [cluster, pages] of [...clusterPageCounts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${mmdId('cl', cluster)}[${mmdLabel(`${cluster} (${pages}p)`)}]`);
  }
  const clusterByPath = new Map(analyzed.nodes.map((node) => [node.path, node.cluster]));
  const aggregated = new Map();
  for (const edge of analyzed.edges) {
    if (edge.chrome && !includeChrome) continue;
    const from = clusterByPath.get(edge.from);
    const to = clusterByPath.get(edge.to);
    const key = `${from}\u0000${to}`;
    const record = aggregated.get(key) ?? { from, to, count: 0, chrome: edge.chrome };
    record.count += edge.count;
    aggregated.set(key, record);
  }
  for (const { from, to, count, chrome } of aggregated.values()) {
    const arrow = chrome ? '-.->' : '-->';
    lines.push(`  ${mmdId('cl', from)} ${arrow}|${count}| ${mmdId('cl', to)}`);
  }
  return lines.join('\n');
}

/** 页级全量图（--full）：集群 subgraph 分组；页面多时图会很大，仅供深入排查。 */
export function toPageMermaid(analyzed, { includeChrome = false } = {}) {
  const byCluster = new Map();
  for (const node of analyzed.nodes) {
    if (!byCluster.has(node.cluster)) byCluster.set(node.cluster, []);
    byCluster.get(node.cluster).push(node);
  }
  const lines = ['graph LR'];
  for (const [cluster, nodes] of byCluster) {
    lines.push(`  subgraph ${mmdId('sg', cluster)}[${mmdLabel(cluster)}]`);
    for (const node of nodes) lines.push(`    ${mmdId('p', node.path)}[${mmdLabel(node.path)}]`);
    lines.push('  end');
  }
  for (const edge of analyzed.edges) {
    if (edge.chrome && !includeChrome) continue;
    const arrow = edge.chrome ? '-.->' : '-->';
    lines.push(`  ${mmdId('p', edge.from)} ${arrow}|${edge.count}| ${mmdId('p', edge.to)}`);
  }
  return lines.join('\n');
}

async function fetchText(url, fetchImpl, timeoutMs) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 递归加载 sitemap（index → 子表，子表仍为 index 时继续展开），返回绝对 URL 列表。 */
async function loadSitemapUrls(sitemapUrl, fetchTextFn, visited = new Set()) {
  if (visited.size >= MAX_SITEMAPS || visited.has(sitemapUrl)) return { pageUrls: [], sitemaps: [] };
  visited.add(sitemapUrl);
  const { kind, urls } = parseSitemap(await fetchTextFn(sitemapUrl));
  if (kind === 'urlset') return { pageUrls: urls, sitemaps: [sitemapUrl] };
  const pageUrls = [];
  for (const child of urls) {
    const nested = await loadSitemapUrls(child, fetchTextFn, visited);
    pageUrls.push(...nested.pageUrls);
  }
  return { pageUrls, sitemaps: [sitemapUrl] };
}

async function discoverViaSitemap(baseUrl, fetchTextFn) {
  for (const candidate of ['sitemap.xml', 'sitemap-index.xml']) {
    const url = new URL(candidate, baseUrl).href;
    try {
      return await loadSitemapUrls(url, fetchTextFn);
    } catch {
      // 探测失败继续尝试下一个候选路径；全部失败由调用方退化为 BFS。
    }
  }
  return null;
}

/** 归一化后的无尾斜杠路径在很多静态站上 404（pretty URL 只认带斜杠形式），失败时补斜杠重试一次。 */
async function crawlFetchPage(path, baseUrl, fetchTextFn) {
  try {
    return await fetchTextFn(new URL(path, baseUrl).href);
  } catch (error) {
    if (path === '/') throw error;
    return fetchTextFn(new URL(`${path}/`, baseUrl).href);
  }
}

/** BFS 兜底：无 sitemap 时从根页面沿站内锚点逐波抓取。 */
async function crawlFromRoot(baseUrl, host, fetchTextFn, { concurrency, maxPages }) {
  const seen = new Set(['/']);
  const linksByPage = {};
  const fetchFailures = [];
  let frontier = ['/'];
  while (frontier.length > 0 && seen.size < maxPages) {
    const batch = frontier.splice(0, concurrency * 3);
    await mapPool(batch, concurrency, async (path) => {
      try {
        const html = await crawlFetchPage(path, baseUrl, fetchTextFn);
        const pageUrl = new URL(path, baseUrl).href;
        linksByPage[path] = [...extractInternalLinks(html, pageUrl, host)];
      } catch (error) {
        fetchFailures.push({ url: new URL(path, baseUrl).href, error: String(error.message ?? error) });
      }
    });
    for (const path of batch) {
      for (const link of linksByPage[path] ?? []) {
        if (!seen.has(link) && seen.size < maxPages) {
          seen.add(link);
          frontier.push(link);
        }
      }
    }
  }
  return {
    pageUrls: [...seen].map((path) => new URL(path, baseUrl).href),
    linksByPage,
    fetchFailures,
  };
}

/**
 * 抓取管线（fetchImpl 可注入，供测试）。返回：
 * { mode, sitemaps, pageUrls(绝对), linksByPage(路径→站内链接数组), fetchFailures }
 */
export async function collectTopology({
  baseUrl,
  sitemapUrl,
  fetchImpl = fetch,
  concurrency = 6,
  timeoutMs = 15000,
  maxPages = 500,
}) {
  const base = new URL(baseUrl);
  const host = base.host;
  const fetchTextFn = (url) => fetchText(url, fetchImpl, timeoutMs);
  if (sitemapUrl) {
    const { pageUrls, sitemaps } = await loadSitemapUrls(sitemapUrl, fetchTextFn);
    return finishSitemapMode(pageUrls, sitemaps, { base, host, fetchTextFn, concurrency });
  }
  const discovered = await discoverViaSitemap(base.href, fetchTextFn);
  if (discovered) {
    return finishSitemapMode(discovered.pageUrls, discovered.sitemaps, {
      base,
      host,
      fetchTextFn,
      concurrency,
    });
  }
  const crawled = await crawlFromRoot(base.href, host, fetchTextFn, { concurrency, maxPages });
  return { mode: 'crawl', sitemaps: [], ...crawled };
}

async function finishSitemapMode(pageUrls, sitemaps, { base, host, fetchTextFn, concurrency }) {
  const uniqueUrls = [...new Set(pageUrls)];
  const linksByPage = {};
  const fetchFailures = [];
  await mapPool(uniqueUrls, concurrency, async (url) => {
    try {
      linksByPage[urlToPath(url)] = [...extractInternalLinks(await fetchTextFn(url), url, host)];
    } catch (error) {
      fetchFailures.push({ url, error: String(error.message ?? error) });
    }
  });
  return { mode: 'sitemap', sitemaps, pageUrls: uniqueUrls, linksByPage, fetchFailures };
}

const USAGE = `用法：node link-topology.mjs <base-url> [options]
  --sitemap <url>          显式 sitemap 地址（默认探测 /sitemap.xml、/sitemap-index.xml）
  --out <dir>              输出目录（默认 node_modules/.cache/link-topology）
  --concurrency <n>        并发抓取数（默认 6）
  --timeout-ms <n>         单请求超时毫秒（默认 15000）
  --chrome-threshold <f>   全站导航边判定阈值（默认 0.9）
  --cluster-depth <n>      集群聚合路径段数（默认 1）
  --max-pages <n>          BFS 兜底模式页数上限（默认 500）
  --full                   额外输出页级 topology-full.mmd
  --include-chrome         Mermaid 保留全站导航边（虚线）
  --help                   显示用法`;

export function parseArgs(argv) {
  const args = {
    baseUrl: null,
    sitemap: null,
    out: null,
    concurrency: 6,
    timeoutMs: 15000,
    chromeThreshold: 0.9,
    clusterDepth: 1,
    maxPages: 500,
    full: false,
    includeChrome: false,
    help: false,
  };
  const numberFlag = (name, raw) => {
    const value = Number(raw);
    if (raw === undefined || !Number.isFinite(value)) {
      throw new Error(`${name} 需要一个数字，得到：${raw}`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--full') args.full = true;
    else if (arg === '--include-chrome') args.includeChrome = true;
    else if (arg === '--sitemap') args.sitemap = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--concurrency') args.concurrency = numberFlag('--concurrency', argv[++i]);
    else if (arg === '--timeout-ms') args.timeoutMs = numberFlag('--timeout-ms', argv[++i]);
    else if (arg === '--chrome-threshold') {
      args.chromeThreshold = numberFlag('--chrome-threshold', argv[++i]);
    } else if (arg === '--cluster-depth') args.clusterDepth = numberFlag('--cluster-depth', argv[++i]);
    else if (arg === '--max-pages') args.maxPages = numberFlag('--max-pages', argv[++i]);
    else if (!arg.startsWith('--') && args.baseUrl === null) args.baseUrl = arg;
    else throw new Error(`未知参数：${arg}`);
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[topology:links] ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.baseUrl) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const collected = await collectTopology(args);
  const graph = buildGraph(collected.pageUrls, collected.linksByPage);
  const fetchedPageCount = Object.keys(collected.linksByPage).length;
  const chromeTargets = detectChromeTargets(graph.edges, fetchedPageCount, args.chromeThreshold);
  const analyzed = analyze(graph, chromeTargets, args.clusterDepth);
  const chromeEdgeCount = analyzed.edges.filter((edge) => edge.chrome).length;

  const outDir = args.out ?? join('node_modules', '.cache', 'link-topology');
  mkdirSync(outDir, { recursive: true });
  const report = {
    meta: {
      baseUrl: args.baseUrl,
      mode: collected.mode,
      sitemaps: collected.sitemaps,
      generatedAt: new Date().toISOString(),
      discoveredPageCount: collected.pageUrls.length,
      fetchedPageCount,
      fetchFailureCount: collected.fetchFailures.length,
      chromeThreshold: args.chromeThreshold,
      clusterDepth: args.clusterDepth,
    },
    nodes: analyzed.nodes,
    edges: analyzed.edges,
    orphans: analyzed.orphans,
    topInDegree: analyzed.topInDegree,
    crossClusterEdges: analyzed.crossClusterEdges,
    fetchFailures: collected.fetchFailures,
  };
  writeFileSync(join(outDir, 'topology.json'), `${JSON.stringify(report, null, 2)}\n`);
  const mermaid = toClusterMermaid(analyzed, { includeChrome: args.includeChrome });
  writeFileSync(join(outDir, 'topology.mmd'), `${mermaid}\n`);
  if (args.full) {
    writeFileSync(
      join(outDir, 'topology-full.mmd'),
      `${toPageMermaid(analyzed, { includeChrome: args.includeChrome })}\n`,
    );
  }

  const clusterCount = new Set(analyzed.nodes.map((node) => node.cluster)).size;
  console.log(
    `[topology:links] 模式 ${collected.mode} · 发现 ${collected.pageUrls.length} 页 · 抓取成功 ${fetchedPageCount} · 失败 ${collected.fetchFailures.length}`,
  );
  console.log(
    `[topology:links] 集群 ${clusterCount} · 边 ${analyzed.edges.length}（其中全站导航边 ${chromeEdgeCount}，Mermaid 已${args.includeChrome ? '虚线保留' : '剔除'}） · 孤儿页 ${analyzed.orphans.length} · 跨集群边 ${analyzed.crossClusterEdges.length}`,
  );
  if (chromeTargets.size > 0) {
    console.log(
      `[topology:links] 全站导航目标：${[...chromeTargets].sort().join(' ')}`,
    );
  }
  if (analyzed.orphans.length > 0) {
    console.log(`[topology:links] 孤儿页（无非导航入边）：${analyzed.orphans.join(' ')}`);
  }
  for (const { path, inDegree } of analyzed.topInDegree.slice(0, 5)) {
    console.log(`[topology:links] 入度 ${inDegree}\t${path}`);
  }
  console.log(`[topology:links] 输出 ${join(outDir, 'topology.json')} · ${join(outDir, 'topology.mmd')}`);
  console.log('```mermaid');
  console.log(mermaid);
  console.log('```');
  if (collected.fetchFailures.length > 0) {
    for (const failure of collected.fetchFailures) {
      console.error(`  - ${failure.url} — ${failure.error}`);
    }
    console.error(`[topology:links] FAILED — ${collected.fetchFailures.length} 个页面抓取失败，数据不全`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[topology:links] ${error.message ?? error}`);
    process.exitCode = 1;
  });
}
