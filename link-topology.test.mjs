// link-topology.mjs 单元 + 端到端测试：sitemap 解析、链接归一化/抽取、图构建、
// chrome 边检测、Mermaid 渲染、CLI 解析，以及本地 http 服务上的 sitemap 模式与
// BFS 兜底模式端到端抓取。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  parseSitemap,
  normalizeUrl,
  extractInternalLinks,
  clusterOf,
  buildGraph,
  detectChromeTargets,
  analyze,
  toClusterMermaid,
  toPageMermaid,
  collectTopology,
  parseArgs,
} from './link-topology.mjs';

test('parseSitemap：urlset 与 sitemapindex 两种形态', () => {
  const urlset = parseSitemap(
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://x.example/a/</loc></url><url><loc>https://x.example/b/</loc></url></urlset>',
  );
  assert.equal(urlset.kind, 'urlset');
  assert.deepEqual(urlset.urls, ['https://x.example/a/', 'https://x.example/b/']);

  const index = parseSitemap(
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://x.example/sitemap-0.xml</loc></sitemap></sitemapindex>',
  );
  assert.equal(index.kind, 'index');
  assert.deepEqual(index.urls, ['https://x.example/sitemap-0.xml']);
});

test('normalizeUrl：归一化与跨域/协议过滤', () => {
  const host = 'x.example';
  assert.equal(normalizeUrl('/b/', 'https://x.example/a/', host), '/b');
  assert.equal(normalizeUrl('/', 'https://x.example/a/', host), '/');
  assert.equal(normalizeUrl('https://x.example/b?u=1#frag', 'https://x.example/', host), '/b');
  assert.equal(normalizeUrl('c', 'https://x.example/a/b', host), '/a/c');
  assert.equal(normalizeUrl('https://other.example/b', 'https://x.example/', host), null);
  assert.equal(normalizeUrl('mailto:a@b.example', 'https://x.example/', host), null);
  assert.equal(normalizeUrl('javascript:void(0)', 'https://x.example/', host), null);
  assert.equal(normalizeUrl('', 'https://x.example/', host), null);
});

test('extractInternalLinks：只收锚点 href，忽略 src/canonical/外链/资产扩展名', () => {
  const html = `<!doctype html><html><head>
    <link rel="canonical" href="https://x.example/a/">
    <link rel="stylesheet" href="/styles.css">
  </head><body>
    <a href="/b/">双引号</a>
    <a href='/c/'>单引号</a>
    <a href="https://x.example/d?utm=1#top">绝对同域</a>
    <a href="https://elsewhere.example/x">外链</a>
    <a href="/docs/file.pdf">资产扩展名</a>
    <a href="mailto:support@x.example">邮件</a>
    <img src="/logo.png" alt="">
  </body></html>`;
  assert.deepEqual(
    extractInternalLinks(html, 'https://x.example/a/', 'x.example'),
    new Set(['/b', '/c', '/d']),
  );
});

test('clusterOf：按路径段聚合，根页面单独成组', () => {
  assert.equal(clusterOf('/reptile/uvb-calculator/', 1), 'reptile');
  assert.equal(clusterOf('/reptile/uvb-calculator/', 2), 'reptile/uvb-calculator');
  assert.equal(clusterOf('/', 1), '(root)');
  assert.equal(clusterOf('/about', 1), 'about');
});

test('buildGraph：自环剔除、计数累加、站外目标标记 inSitemap=false', () => {
  const graph = buildGraph(['https://x.example/a/'], {
    '/a': ['/a', '/b', '/b', '/c'],
  });
  assert.deepEqual([...graph.nodes.entries()].sort(), [
    ['/a', { inSitemap: true }],
    ['/b', { inSitemap: false }],
    ['/c', { inSitemap: false }],
  ]);
  assert.deepEqual(graph.edges, [
    { from: '/a', to: '/b', count: 2 },
    { from: '/a', to: '/c', count: 1 },
  ]);
});

test('detectChromeTargets：按已抓页面占比判定', () => {
  const edges = [
    { from: '/a', to: '/tools', count: 1 },
    { from: '/b', to: '/tools', count: 2 },
    { from: '/a', to: '/b', count: 1 },
  ];
  assert.deepEqual([...detectChromeTargets(edges, 2, 0.9)], ['/tools']);
  // 抓了 3 页但只有 2 页链到 /tools：2/3 < 0.9，不再判定为全站导航。
  assert.equal(detectChromeTargets(edges, 3, 0.9).size, 0);
});

test('analyze：chrome 边不计入度数，孤儿/入度榜/跨集群边只看内容边', () => {
  const graph = buildGraph(['https://x.example/a/', 'https://x.example/b/', 'https://x.example/island/'], {
    '/a': ['/b', '/tools'],
    '/b': ['/a', '/tools'],
    // /island 也链到 /tools（3/3 达到阈值）；出链不影响它作为孤儿（无非 chrome 入边）。
    '/island': ['/tools'],
  });
  const chrome = detectChromeTargets(graph.edges, 3, 0.9);
  const analyzed = analyze(graph, chrome, 1);
  assert.ok(chrome.has('/tools'));
  const byPath = new Map(analyzed.nodes.map((node) => [node.path, node]));
  assert.equal(byPath.get('/tools').inDegree, 0);
  assert.equal(byPath.get('/a').inDegree, 1);
  assert.equal(byPath.get('/b').inDegree, 1);
  assert.deepEqual(analyzed.orphans, ['/island']);
  assert.deepEqual(analyzed.topInDegree, [
    { path: '/a', inDegree: 1 },
    { path: '/b', inDegree: 1 },
  ]);
});

test('toClusterMermaid：集群聚合 + chrome 边默认剔除、includeChrome 时虚线', () => {
  const graph = buildGraph(['https://x.example/reptile/a/', 'https://x.example/aquarium/b/'], {
    '/reptile/a': ['/aquarium/b', '/tools'],
    '/aquarium/b': ['/tools'],
  });
  const chrome = detectChromeTargets(graph.edges, 2, 0.9);
  const analyzed = analyze(graph, chrome, 1);
  const mermaid = toClusterMermaid(analyzed);
  assert.ok(mermaid.startsWith('graph LR'));
  assert.ok(mermaid.includes('cl_reptile['));
  assert.ok(mermaid.includes('cl_aquarium['));
  assert.ok(mermaid.includes('cl_reptile -->|1| cl_aquarium'));
  // chrome 目标的集群节点框仍存在（它是已发现节点），但没有任何边指向它。
  assert.ok(!mermaid.includes('| cl_tools'));
  const withChrome = toClusterMermaid(analyzed, { includeChrome: true });
  // chrome 边按集群对聚合：两个源集群各有一条 |1| 虚线边指向 tools。
  assert.ok(withChrome.includes('cl_reptile -.->|1| cl_tools'));
  assert.ok(withChrome.includes('cl_aquarium -.->|1| cl_tools'));
});

test('toPageMermaid：页级图带集群 subgraph', () => {
  const graph = buildGraph(['https://x.example/reptile/a/'], {
    '/reptile/a': ['/reptile/b'],
  });
  const analyzed = analyze(graph, new Set(), 1);
  const mermaid = toPageMermaid(analyzed);
  assert.ok(mermaid.includes('subgraph sg_reptile['));
  assert.ok(mermaid.includes('p__reptile_a['));
  assert.ok(mermaid.includes('-->|1|'));
});

test('parseArgs：位置参数 + 数字旗标校验 + 未知参数报错', () => {
  const args = parseArgs(['https://x.example', '--concurrency', '8', '--full', '--out', '/tmp/t']);
  assert.equal(args.baseUrl, 'https://x.example');
  assert.equal(args.concurrency, 8);
  assert.equal(args.full, true);
  assert.equal(args.out, '/tmp/t');
  assert.equal(args.chromeThreshold, 0.9);
  assert.throws(() => parseArgs(['--concurrency']), /需要一个数字/);
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
});

function listen(handler) {
  return new Promise((resolveReady) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolveReady(server));
  });
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolveClosed) => server.close(resolveClosed));
}

const PAGE_A = `<!doctype html><html><head><link rel="canonical" href="/a/"></head><body>
  <a href="/b/">B</a><a href="/tools/">Tools</a>
  <a href="https://elsewhere.example/x">外链</a><a href="/docs/file.pdf">pdf</a>
  <img src="/logo.png" alt=""></body></html>`;
const PAGE_B = `<!doctype html><html><body>
  <a href='/a/'>A</a><a href="/tools/">Tools</a></body></html>`;
const PAGE_C = `<!doctype html><html><body>
  <a href="/tools/">T</a><a href="/b/">B</a><a href="/a/?utm=1#frag">A</a></body></html>`;

test('collectTopology（sitemap 模式，本地 http 端到端）：index→子表→逐页抓取', async () => {
  let server;
  server = await listen((req, res) => {
    const port = server.address().port;
    const routes = {
      '/sitemap.xml': `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>http://127.0.0.1:${port}/sitemap-0.xml</loc></sitemap></sitemapindex>`,
      '/sitemap-0.xml': `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://127.0.0.1:${port}/a/</loc></url><url><loc>http://127.0.0.1:${port}/b/</loc></url><url><loc>http://127.0.0.1:${port}/c/</loc></url></urlset>`,
      '/a/': PAGE_A,
      '/b/': PAGE_B,
      '/c/': PAGE_C,
    };
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const result = await collectTopology({ baseUrl, concurrency: 2, timeoutMs: 3000 });
    assert.equal(result.mode, 'sitemap');
    assert.deepEqual(
      [...result.pageUrls].sort(),
      [`${baseUrl}/a/`, `${baseUrl}/b/`, `${baseUrl}/c/`].sort(),
    );
    assert.deepEqual(new Set(result.linksByPage['/a']), new Set(['/b', '/tools']));
    assert.deepEqual(new Set(result.linksByPage['/c']), new Set(['/tools', '/b', '/a']));
    assert.deepEqual(result.fetchFailures, []);

    const graph = buildGraph(result.pageUrls, result.linksByPage);
    const chrome = detectChromeTargets(graph.edges, 3, 0.9);
    assert.ok(chrome.has('/tools'));
    assert.ok(!chrome.has('/b'));
  } finally {
    await closeServer(server);
  }
});

test('collectTopology（BFS 兜底，本地 http 端到端）：无 sitemap 时从根页面爬取', async () => {
  let server;
  server = await listen((req, res) => {
    const routes = {
      '/': `<!doctype html><html><body><a href="/about/">About</a><a href="/logo.png">logo</a></body></html>`,
      '/about/': `<!doctype html><html><body><a href="/">Home</a></body></html>`,
    };
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const result = await collectTopology({ baseUrl, concurrency: 2, timeoutMs: 3000, maxPages: 10 });
    assert.equal(result.mode, 'crawl');
    assert.deepEqual([...result.pageUrls].sort(), [`${baseUrl}/`, `${baseUrl}/about`]);
    assert.deepEqual(result.linksByPage['/'], ['/about']);
    assert.deepEqual(result.linksByPage['/about'], ['/']);
    assert.deepEqual(result.fetchFailures, []);
  } finally {
    await closeServer(server);
  }
});
