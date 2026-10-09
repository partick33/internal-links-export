#!/usr/bin/env node
/**
 * Link Topology Explorer 编译器：把 link-topology.mjs 的 topology.json 编译成
 * 单文件交互式产品 UI（不再使用 mermaid——画布交互基于 Cytoscape.js + fCoSE）。
 *
 * 产物 topology.html：顶栏（集群/页面/数据视图 + 搜索 + 过滤器）、左侧栏（概览/
 * 集群导航/问题清单）、中央力导向图画布（缩放/拖拽/邻域高亮/双击下钻）、右侧详情面板。
 * 构建时把 cytoscape 与 cytoscape-fcose 内联进 HTML（缓存于 <out>/vendor/），产物
 * 离线可开；内联失败时回退 CDN <script>（打开需联网）。
 *
 * 用法：node render-html.mjs [--dir <输出目录>]（默认 node_modules/.cache/link-topology）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// 顺序敏感：cytoscape → layout-base → cose-base → fcose（UMD 全局链 window.layoutBase
// → window.coseBase → fcose 注册到 cytoscape；缺任何一环 fcose 静默失败、布局回退 cose）
const VENDORS = [
  { name: 'cytoscape.min.js', url: 'https://cdn.jsdelivr.net/npm/cytoscape@3.30.4/dist/cytoscape.min.js' },
  { name: 'layout-base.min.js', url: 'https://cdn.jsdelivr.net/npm/layout-base@2.0.1/layout-base.min.js' },
  { name: 'cose-base.min.js', url: 'https://cdn.jsdelivr.net/npm/cose-base@2.2.0/cose-base.min.js' },
  { name: 'cytoscape-fcose.min.js', url: 'https://cdn.jsdelivr.net/npm/cytoscape-fcose@2.2.0/cytoscape-fcose.min.js' },
];

function parseArgs(argv) {
  const args = { dir: join('node_modules', '.cache', 'link-topology') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return args;
}

const escapeHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** payload / vendor 内联进 <script> 前转义 </script，防止标签截断（JS 字符串内等价）。 */
const inlineSafe = (code) => String(code).replace(/<\/script/gi, '<\\/script');

async function loadVendor({ name, url }, cacheDir) {
  const cachePath = join(cacheDir, name);
  if (existsSync(cachePath)) return readFileSync(cachePath, 'utf8');
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const code = await res.text();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, code);
  return code;
}

async function render({ dir }) {
  const jsonPath = join(dir, 'topology.json');
  if (!existsSync(jsonPath)) {
    console.error(`[render-html] 找不到 ${jsonPath} — 先运行 link-topology.mjs 生成产物`);
    process.exitCode = 1;
    return;
  }
  const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const { meta } = report;
  const chromeEdgeCount = report.edges.filter((edge) => edge.chrome).length;

  const appCss = readFileSync(join(HERE, 'report-ui', 'app.css'), 'utf8');
  const appJs = readFileSync(join(HERE, 'report-ui', 'app.js'), 'utf8');

  // 交互数据：全部边（含 chrome 标记，供「导航边」开关）；mmd 文件不再使用
  const payload = {
    meta: {
      baseUrl: meta.baseUrl,
      generatedAt: meta.generatedAt,
      mode: meta.mode,
      discoveredPageCount: meta.discoveredPageCount,
      fetchedPageCount: meta.fetchedPageCount,
      chromeThreshold: meta.chromeThreshold,
      clusterDepth: meta.clusterDepth,
    },
    nodes: report.nodes,
    edges: report.edges,
    orphans: report.orphans,
    topInDegree: report.topInDegree,
    crossClusterEdges: report.crossClusterEdges,
    fetchFailures: report.fetchFailures,
  };

  const vendorTags = [];
  let vendorNotes = [];
  for (const vendor of VENDORS) {
    try {
      const code = await loadVendor(vendor, join(dir, 'vendor'));
      vendorTags.push(`<script>${inlineSafe(code)}</script>`);
      vendorNotes.push(`${vendor.name}（内联）`);
    } catch {
      vendorTags.push(`<script src="${vendor.url}"></script>`);
      vendorNotes.push(`${vendor.name}（CDN 回退，打开需联网）`);
    }
  }
  vendorNotes = vendorNotes.join(' · ');

  const favicon =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="8" cy="16" r="5" fill="#2563eb"/><circle cx="24" cy="8" r="4" fill="#e8590c"/><circle cx="24" cy="24" r="4" fill="#12b886"/><path d="M12 14l8-4M12 18l8 4" stroke="#5c6a7d" stroke-width="2"/></svg>',
    );

  const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link Topology Explorer — ${escapeHtml(meta.baseUrl)}</title>
<meta name="description" content="交互式站点内链拓扑：集群总览、页面级下钻、入出链审计">
<link rel="icon" href="${favicon}">
<style>${appCss}</style>
</head>
<body>
<header id="topbar">
  <button id="sidebar-toggle" class="icon-btn" aria-label="切换侧栏" title="切换侧栏">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 4h12M2 8h12M2 12h12"/></svg>
  </button>
  <div class="brand">
    <div class="logo"><svg viewBox="0 0 32 32" fill="none"><circle cx="8" cy="16" r="5" fill="#3465d4"/><circle cx="24" cy="8" r="4" fill="#e8590c"/><circle cx="24" cy="24" r="4" fill="#12b886"/><path d="M12 14l8-4M12 18l8 4" stroke="#5c6a7d" stroke-width="2"/></svg></div>
    <div class="t"><b>Link Topology Explorer</b><span id="site-host">${escapeHtml(meta.baseUrl)}</span></div>
  </div>
  <nav class="seg" aria-label="视图">
    <button data-view="cluster" class="active">集群</button>
    <button data-view="page">页面</button>
    <button data-view="data">数据</button>
  </nav>
  <div class="search">
    <div class="box">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
      <input id="search" type="text" placeholder="搜索页面路径或集群…" autocomplete="off" spellcheck="false">
      <kbd>/</kbd>
    </div>
    <div id="search-drop" hidden></div>
  </div>
  <div class="export">
    <button id="export-btn" aria-haspopup="menu" aria-expanded="false" title="导出图像或数据">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2v7.6M4.7 6.7L8 10l3.3-3.3M2.6 11.4v1.2a1.2 1.2 0 0 0 1.2 1.2h8.4a1.2 1.2 0 0 0 1.2-1.2v-1.2"/></svg>
      导出
    </button>
    <div id="export-menu" role="menu" hidden>
      <div class="ex-h">图像</div>
      <button class="ex-item" role="menuitem" data-export="png-view">
        <svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.8" width="12" height="10.4" rx="2"/><circle cx="5.7" cy="6.3" r="1.05" fill="currentColor" stroke="none"/><path d="M2.7 11.6l3.1-2.9 2.5 2.2 2.3-2 2.7 2.3"/></svg>
        <span class="t">当前视图 PNG<span class="sub">当前画布所见即所得 · 含缩放 / 过滤 / 高亮状态</span></span>
      </button>
      <button class="ex-item" role="menuitem" data-export="png-full">
        <svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5H3.8a1.3 1.3 0 0 0-1.3 1.3V6M10 2.5h2.2a1.3 1.3 0 0 1 1.3 1.3V6M6 13.5H3.8a1.3 1.3 0 0 1-1.3-1.3V10M10 13.5h2.2a1.3 1.3 0 0 0 1.3-1.3V10"/><circle cx="8" cy="8" r="1.5"/></svg>
        <span class="t">整图 PNG<span class="sub">完整布局 · 分辨率自适应 · 附署名页脚</span></span>
      </button>
      <div class="ex-h">数据</div>
      <button class="ex-item" role="menuitem" data-export="csv-pages">
        <svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.8"/><path d="M2 6.7h12M6.6 6.7V13"/></svg>
        <span class="t">页面清单 CSV<span class="sub">路径 · 集群 · 入出度 · 孤儿 / 零出链标记</span></span>
      </button>
      <button class="ex-item" role="menuitem" data-export="csv-edges">
        <svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="3.5" cy="8" r="1.7"/><circle cx="12.5" cy="8" r="1.7"/><path d="M5.6 8h4.8"/></svg>
        <span class="t">链接边表 CSV<span class="sub">from → to · 次数 · 内容 / 导航类型</span></span>
      </button>
      <button class="ex-item" role="menuitem" data-export="csv-clusters">
        <svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 2.4l5.8 2.8L8 8 2.2 5.2z"/><path d="M2.2 8.8L8 11.6l5.8-2.8M2.2 11.6L8 14.4l5.8-2.8"/></svg>
        <span class="t">集群汇总 CSV<span class="sub">页面数 · 内部链接 · 跨集群出入向</span></span>
      </button>
      <button class="ex-item" role="menuitem" data-export="json">
        <svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6.3 2.6c-1.9 0-1.4 2.7-3 3.4 1.6.7 1.1 3.4 3 3.4M9.7 2.6c1.9 0 1.4 2.7 3 3.4-1.6.7-1.1 3.4-3 3.4"/><path d="M5.7 12.2c.7.8 1.4 1.2 2.3 1.2s1.6-.4 2.3-1.2"/></svg>
        <span class="t">原始数据 JSON<span class="sub">与 topology.json 完全一致 · 可二次分析</span></span>
      </button>
      <button class="ex-item" role="menuitem" data-export="gexf">
        <svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="3.4" r="1.7"/><circle cx="3.4" cy="12" r="1.7"/><circle cx="12.6" cy="12" r="1.7"/><path d="M7 4.9L4.3 10.4M9 4.9l2.7 5.5M5.1 12h5.8"/></svg>
        <span class="t">GEXF<span class="sub">Gephi 原生 · 带集群配色与度数属性</span></span>
      </button>
      <button class="ex-item" role="menuitem" data-export="graphml">
        <svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="3.2" r="1.6"/><circle cx="3.2" cy="8" r="1.6"/><circle cx="12.8" cy="8" r="1.6"/><circle cx="5.6" cy="12.8" r="1.6"/><circle cx="10.4" cy="12.8" r="1.6"/><path d="M6.9 4.3L4.3 6.9M9.1 4.3l2.6 2.6M4 9.5l1.2 1.8M12 9.5l-1.2 1.8M7.2 12.8h1.6"/></svg>
        <span class="t">GraphML<span class="sub">Cytoscape / yEd / NetworkX 通用</span></span>
      </button>
      <div class="ex-note">文件名 <code>link-topology-&lt;域名&gt;-&lt;日期&gt;.*</code><br>CSV 带 UTF-8 BOM，Excel 直接打开；GEXF / GraphML 可导入 Gephi 等图分析工具</div>
    </div>
  </div>
</header>
<div id="main">
  <aside id="sidebar">
    <div class="card">
      <h3>概览</h3>
      <div class="stat-grid">
        <div class="stat"><b id="stat-pages">–</b><span>页面</span></div>
        <div class="stat"><b id="stat-edges">–</b><span>内容边（导航边剔除）</span></div>
        <div class="stat"><b id="stat-clusters">–</b><span>集群</span></div>
        <div class="stat clickable" id="stat-orphans-wrap" title="点击查看孤儿页清单"><b id="stat-orphans">–</b><span>孤儿页 →</span></div>
      </div>
    </div>
    <div class="card">
      <h3>集群</h3>
      <div id="cl-list"></div>
    </div>
    <div class="card">
      <h3>问题</h3>
      <h4 class="sec">孤儿页（无入链）</h4><div id="issue-orphans"></div>
      <h4 class="sec">零出链页面</h4><div id="issue-zeroout"></div>
      <h4 class="sec">抓取失败</h4><div id="issue-failures"></div>
    </div>
  </aside>
  <div id="stage">
    <div id="cy"></div>
    <div id="group-labels"></div>
    <div id="page-empty" hidden>
      <div class="pe-card">
        <div class="pe-title">页面视图 · 按集群下钻</div>
        <p>该站点共 <b class="pe-num-pages">–</b> 个页面、<b class="pe-num-clusters">–</b> 个集群——全站平铺不可读也不可拖。选择一个集群查看其页面级结构：</p>
        <div class="pe-quick" id="pe-quick"></div>
        <p class="pe-hint">大集群与其类目来源集群进入即「类目目录」（组列表 → 组图）· 图中类目页/聚合集群块双击直达 · 左侧集群列表可搜索定位 · 全量页面见「数据」视图与导出</p>
      </div>
    </div>
    <div id="scope-panel" hidden></div>
    <div id="data-view" hidden></div>
    <div id="breadcrumb" hidden><span class="t" id="crumb-text"></span><button id="crumb-back" aria-label="退出聚焦" title="退出聚焦，返回全站页面视图">✕</button></div>
    <div id="legend">
      <div class="lg-h">图例</div>
      <div class="lg-grid">
        <span class="lg-item"><span class="sw sw-node"></span>节点大小 = 入度</span>
        <span class="lg-item"><span class="sw sw-frame"></span>圆角框 = 集群分组</span>
        <span class="lg-item"><span class="sw sw-ghost"></span>虚线节点 = 非 sitemap</span>
        <span class="lg-item"><span class="sw sw-edge"></span>边宽 = 链接次数</span>
        <span class="lg-item"><span class="sw sw-ecol"></span>边色 = 源集群</span>
        <span class="lg-item"><span class="sw sw-taxi"></span>直角边 = 跨集群链路</span>
      </div>
      <div class="lg-tips">单击：详情 + 邻域高亮 · 双击：集群下钻 / 打开原页面<br>滚轮缩放（放大浮现页面名）· <b>/</b> 搜索 · 空白处点击取消</div>
      <button class="lg-close" aria-label="收起图例" title="收起图例">✕</button>
    </div>
    <button id="legend-open" hidden>图例</button>
    <div id="canvas-controls">
      <button id="zoom-out" title="缩小">−</button>
      <button id="zoom-fit" title="适应画布">⤢</button>
      <button id="zoom-in" title="放大">+</button>
      <span class="cc-sep"></span>
      <label title="全站导航边默认剔除；开启后以淡虚线并入"><input type="checkbox" id="chrome-toggle">含全站导航</label>
      <span class="cc-sep"></span>
      <label>边权重 ≥ <select id="min-count"><option value="1" selected>1</option><option value="2">2</option><option value="3">3</option><option value="5">5</option></select></label>
    </div>
    <div id="loading" hidden><div class="spin"></div><p>正在计算布局…</p></div>
    <aside id="inspector" hidden><button id="insp-close" aria-label="关闭详情">✕</button><div id="insp-body"></div></aside>
  </div>
</div>
<div id="tooltip" hidden></div>
<div id="toast" role="status"><span class="tick"><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1.6 5.3l2.3 2.3L8.4 2.9"/></svg></span><span class="txt" id="toast-text"></span></div>
${vendorTags.join('\n')}
<script>window.__TOPO__ = ${inlineSafe(JSON.stringify(payload))};</script>
<script>${inlineSafe(appJs)}</script>
</body>
</html>
`;

  const outPath = join(dir, 'topology.html');
  writeFileSync(outPath, html);
  console.log(`[render-html] 输出 ${outPath}`);
  console.log(`[render-html] 引擎：${vendorNotes} · 内容边 ${report.edges.length - chromeEdgeCount} / 导航边 ${chromeEdgeCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await render(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`[render-html] ${error.message ?? error}`);
    process.exitCode = 1;
  }
}
