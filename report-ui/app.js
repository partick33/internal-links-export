/* Link Topology Explorer — 交互逻辑（由 render-html.mjs 内联；数据来自 window.__TOPO__） */
(() => {
  const T = window.__TOPO__;
  const fatal = (msg) => {
    document.body.innerHTML = '<div class="fatal"><div>' + msg + '</div></div>';
    throw new Error(msg);
  };
  if (!T || !T.meta) fatal('缺少拓扑数据（window.__TOPO__ 未注入）');
  if (typeof cytoscape === 'undefined') fatal('图表引擎 cytoscape 未加载：生成报告时未能内联且当前环境离线');

  /* ================= 派生数据 ================= */
  const BASE = String(T.meta.baseUrl || '').replace(/\/+$/, '');
  const urlOf = (p) => BASE + p;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pages = T.nodes || [];
  if (!pages.length) fatal('拓扑数据中没有页面');
  const byPath = new Map(pages.map((p) => [p.path, p]));

  const clusterMap = new Map(); // name -> { name, pages[], internal, out Map, in Map, color, border }
  for (const p of pages) {
    let c = clusterMap.get(p.cluster);
    if (!c) { c = { name: p.cluster, pages: [], internal: 0, out: new Map(), in: new Map() }; clusterMap.set(p.cluster, c); }
    c.pages.push(p);
  }
  const clusterList = [...clusterMap.values()].sort((a, b) => b.pages.length - a.pages.length || a.name.localeCompare(b.name));
  // 低饱和产品级色板（Tableau 风格）：[填充, 深描边]；高对比色在前（大集群优先分到），黄橙垫底并压低饱和以均衡视觉重量
  const PALETTE = [
    ['#4f7fbf', '#33567e'], ['#5c9e53', '#3c6e35'], ['#4d9d96', '#336b66'], ['#9274b3', '#664e82'],
    ['#c9666b', '#96474b'], ['#6f9fc9', '#4d7297'], ['#7fae6c', '#587c49'], ['#bd8ab0', '#8b6180'],
    ['#c99268', '#96674a'], ['#bfa764', '#8f7a3f'], ['#7f93a8', '#5a6d81'], ['#a6a0bd', '#77719a'],
  ];
  clusterList.forEach((c, i) => {
    const pair = c.name === '(root)' ? ['#8a95a5', '#5f6a7a'] : PALETTE[i % PALETTE.length];
    c.color = pair[0]; c.border = pair[1];
  });
  const clusterColor = (name) => (clusterMap.get(name) || {}).color || '#8a95a5';
  const sum = (m) => { let s = 0; m.forEach((v) => { s += v; }); return s; };

  const allEdges = T.edges || [];
  const contentEdgeCount = allEdges.filter((e) => !e.chrome).length;
  const aggContent = new Map();
  const aggChrome = new Map();
  for (const e of allEdges) {
    const f = byPath.get(e.from); const t = byPath.get(e.to);
    if (!f || !t || f.cluster === t.cluster) continue;
    const m = e.chrome ? aggChrome : aggContent;
    const key = f.cluster + '\u0000' + t.cluster;
    m.set(key, (m.get(key) || 0) + e.count);
  }
  aggContent.forEach((count, key) => {
    const [a, b] = key.split('\u0000');
    clusterMap.get(a).out.set(b, (clusterMap.get(a).out.get(b) || 0) + count);
    clusterMap.get(b).in.set(a, (clusterMap.get(b).in.get(a) || 0) + count);
  });
  for (const e of allEdges) {
    if (e.chrome) continue;
    const f = byPath.get(e.from); const t = byPath.get(e.to);
    if (f && t && f.cluster === t.cluster) clusterMap.get(f.cluster).internal += e.count;
  }

  // 注意不能用 Math.max(...arr) 展开：边表可达十几万条，超出引擎参数上限（RangeError）
  const maxIn = pages.reduce((m, p) => (p.inDegree > m ? p.inDegree : m), 1);
  const maxPages = clusterList.reduce((m, c) => (c.pages.length > m ? c.pages.length : m), 1);
  const maxEdgeCount = allEdges.reduce((m, e) => (e.count > m ? e.count : m), 1);
  // 大站长尾折叠：集群数过多时把 ≤2 页的小集群折成一张聚合卡。
  // 伪集群名用 \u0001：URL 路径段里控制字符必被百分号编码，不会与真实集群名冲突，
  // 也不能用 \u0000——那是跨集群聚合边的 key 分隔符，会把自己 split 错位
  const TAIL = '\u0001tail';
  const tailName = (name) => (name === TAIL ? '长尾集群' : name);
  let tailInfo = null;
  if (clusterList.length > 60) {
    const small = clusterList.filter((c) => c.pages.length <= 2);
    if (small.length > 12) {
      const smallSet = new Set(small.map((c) => c.name));
      const tailPages = [];
      small.forEach((c) => { tailPages.push(...c.pages); });
      const tc = { name: TAIL, pages: tailPages, internal: 0, out: new Map(), in: new Map(), color: '#8a95a5', border: '#5f6a7a' };
      small.forEach((c) => {
        tc.internal += c.internal;
        c.out.forEach((v, k) => { if (!smallSet.has(k)) tc.out.set(k, (tc.out.get(k) || 0) + v); });
        c.in.forEach((v, k) => { if (!smallSet.has(k)) tc.in.set(k, (tc.in.get(k) || 0) + v); });
      });
      clusterMap.set(TAIL, tc);
      tailInfo = { members: small, cluster: tc };
    }
  }

  // 大集群隐式结构发现：扁平目录（如电商 /products/{slug}）没有可用的路径分段，
  // 但「类目页 → 单品页」的星形入链真实存在——按每个非枢纽页的最强内容入链来源
  // 分组即可还原类目结构（确定性：计数降序、来源路径升序决胜；随过滤器无关，只算一次）
  const skeletonCache = new Map();
  function clusterSkeleton(name) {
    const hit = skeletonCache.get(name);
    if (hit) return hit;
    const c = clusterMap.get(name) || { name, pages: [] };
    const memberSet = new Set(c.pages.map((p) => p.path));
    const hubs = c.pages.filter((p) => p.inDegree >= HUB_IN_MIN)
      .sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path));
    const hubSet = new Set(hubs.map((p) => p.path));
    const best = new Map(); // 非枢纽成员路径 → 最强内容入链来源路径
    for (const e of allEdges) {
      if (e.chrome || e.from === e.to || !memberSet.has(e.to) || hubSet.has(e.to)) continue;
      const cur = best.get(e.to);
      if (!cur || e.count > cur.count || (e.count === cur.count && e.from.localeCompare(cur.from) < 0)) best.set(e.to, e.from);
    }
    const groups = new Map();
    const groupOf = new Map();
    const unlinked = [];
    for (const p of c.pages) {
      if (hubSet.has(p.path)) continue;
      const src = best.get(p.path);
      if (!src || !byPath.has(src)) { unlinked.push(p); continue; }
      let g = groups.get(src);
      if (!g) { g = { key: src, src: byPath.get(src), members: [] }; groups.set(src, g); }
      g.members.push(p);
      groupOf.set(p.path, src);
    }
    const all = [...groups.values()].sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key));
    const big = all.filter((g) => g.members.length >= GROUP_MIN);
    const foldedMembers = [];
    all.filter((g) => g.members.length < GROUP_MIN).forEach((g) => { foldedMembers.push(...g.members); });
    const nonHub = c.pages.length - hubs.length;
    const cover = big.reduce((s, g) => s + g.members.length, 0);
    const sk = {
      cluster: c, hubs, big, groupOf, unlinked, foldedMembers,
      usable: big.length >= 6 && cover >= Math.max(30, Math.round(nonHub * 0.3)),
      byKey: new Map(big.map((g) => [g.key, g])),
    };
    skeletonCache.set(name, sk);
    return sk;
  }

  // 类目来源集群的目录：dog/cat/... 这类集群自身页面不多（一屏成图没问题），但它们的
  // 页面是大集群类目组的来源锚点——同样给出「类目目录」面板（组列表 → 组图），与目标
  // 大集群的目录形成对称双入口：从任一侧进入都是同一条「集群 → 类目目录 → 组图」路径。
  // 阈值 3 组与全量目录的分区门槛一致（品牌微集群 1-2 组不值得独立面板，在全量目录可达）。
  const srcPanelCache = new Map();
  function srcPanel(name) {
    if (srcPanelCache.has(name)) return srcPanelCache.get(name);
    let best = null;
    for (const cObj of clusterMap.values()) {
      if (cObj.pages.length <= FOCUS_MEMBER_LIMIT) continue; // 只有超限成图的大集群才有目录骨架
      const sk = clusterSkeleton(cObj.name);
      if (!sk.usable) continue;
      const gs = sk.big.filter((g) => g.src && g.src.cluster === name);
      if (gs.length >= 3 && (!best || gs.length > best.groups.length)) {
        best = { target: cObj.name, groups: gs.slice().sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key)) };
      }
    }
    srcPanelCache.set(name, best);
    return best;
  }
  // 任意页面 → 它作为来源锚点拥有的类目组（节点双击进组图 / inspector 按钮共用；小站无骨架）
  const anchorGroupCache = new Map();
  function groupAnchorOf(path) {
    if (!bigSite) return null;
    if (anchorGroupCache.has(path)) return anchorGroupCache.get(path);
    let hit = null;
    for (const cObj of clusterMap.values()) {
      if (cObj.pages.length <= FOCUS_MEMBER_LIMIT) continue;
      const g = clusterSkeleton(cObj.name).byKey.get(path);
      if (g && (!hit || g.members.length > hit.size)) hit = { cluster: cObj.name, size: g.members.length };
    }
    anchorGroupCache.set(path, hit);
    return hit;
  }
  // 目录面板判定：超限且骨架可用的集群 → 全量目录；不超限但是 ≥3 组的来源集群 → 来源目录
  function scopePanelInfo(sc) {
    if (!sc || !bigSite || sc.group || sc.hot) return null;
    const c = clusterMap.get(sc.cluster);
    if (!c) return null;
    if (c.pages.length > FOCUS_MEMBER_LIMIT) return clusterSkeleton(sc.cluster).usable ? { mode: 'own' } : null;
    const sp = srcPanel(sc.cluster);
    return sp ? { mode: 'src', sp } : null;
  }

  // 页面节点标签：短名（路径末段）+ 分级浮现——入度头部页中等缩放即可读，其余放大后浮现
  const shortLabel = (path) => { const segs = path.split('/').filter(Boolean); return segs.length ? segs[segs.length - 1] : '(root)'; };
  const sortedIns = pages.map((p) => p.inDegree).sort((a, b) => b - a);
  const hubMin = Math.max(20, sortedIns[Math.min(10, sortedIns.length - 1)] || 0);
  const maxAgg = Math.max(1, ...[...aggContent.values(), ...aggChrome.values()]);
  const orphans = T.orphans || [];
  const orphanSet = new Set(orphans);
  const zeroOut = pages.filter((p) => p.outDegree === 0).map((p) => p.path).sort();
  const failures = T.fetchFailures || [];

  /* ================= 状态 ================= */
  // scope：null=全站（大站为引导态）| { cluster, group?, hot? }
  //   group=类目组来源页路径（大集群下钻第二级；TAIL=长尾组合集）；hot=热门 Top N 总览
  // pin：热门图强制置入并选中的页面路径（搜索定位长尾页用）
  const state = { view: 'cluster', scope: null, chrome: false, minCount: 1, pin: null };
  // 大站防护：任何一次页面视图渲染都有界——集群 ≤600 直接成图；更大的集群走
  // 类目目录面板 → 类目组图（组天然百级以内）；组/池超限则热门 Top N + 长尾聚合
  const PAGE_RENDER_LIMIT = 1500;
  const FOCUS_MEMBER_LIMIT = 600;
  const RANKFOLD_LIMIT = 250;
  const GROUP_MIN = 5;
  const HUB_IN_MIN = 20;
  const bigSite = pages.length > PAGE_RENDER_LIMIT;
  const normScope = (s) => (!s ? null
    : typeof s === 'string' ? { cluster: s, group: null, hot: false }
      : { cluster: s.cluster, group: s.group || null, hot: !!s.hot });

  /* ================= DOM ================= */
  const $ = (s) => document.querySelector(s);
  const el = {
    cy: $('#cy'), sidebar: $('#sidebar'), dataView: $('#data-view'), labels: $('#group-labels'), stage: $('#stage'),
    insp: $('#inspector'), inspBody: $('#insp-body'), inspClose: $('#insp-close'),
    breadcrumb: $('#breadcrumb'), crumbText: $('#crumb-text'), crumbBack: $('#crumb-back'),
    loading: $('#loading'), legend: $('#legend'), legendOpen: $('#legend-open'), tooltip: $('#tooltip'),
    search: $('#search'), searchDrop: $('#search-drop'),
    chromeToggle: $('#chrome-toggle'), minCountSel: $('#min-count'),
    sidebarToggle: $('#sidebar-toggle'), canvasControls: $('#canvas-controls'),
    segButtons: [...document.querySelectorAll('.seg button')],
  };
  el.inspClose.addEventListener('click', () => { closeInspector(); clearSelection(); });
  // 逐级返回：类目组/热门 → 集群目录 → 全站引导态
  el.crumbBack.addEventListener('click', () => {
    const sc = normScope(state.scope);
    if (sc && (sc.group || sc.hot)) setScope({ cluster: sc.cluster });
    else setScope(null);
  });
  el.sidebarToggle.addEventListener('click', () => el.sidebar.classList.toggle('collapsed'));
  // 图例：9 秒无交互自动收起为 ? 按钮；悬停视为在阅读，取消本次收起
  let legendOpen = true;
  let legendTimer = null;
  function setLegend(open) {
    legendOpen = open;
    el.legend.hidden = !open;
    el.legendOpen.hidden = open;
  }
  function armLegendTimer(ms) { clearTimeout(legendTimer); legendTimer = setTimeout(() => setLegend(false), ms); }
  document.querySelector('#legend .lg-close').addEventListener('click', () => { clearTimeout(legendTimer); setLegend(false); });
  el.legendOpen.addEventListener('click', () => { clearTimeout(legendTimer); setLegend(true); armLegendTimer(9000); });
  el.legend.addEventListener('mouseenter', () => clearTimeout(legendTimer));
  el.legend.addEventListener('mouseleave', () => armLegendTimer(6000));
  armLegendTimer(9000);

  /* ================= 图构建 ================= */
  let cy = null;
  let renderSeq = 0;

  /* ================= 覆盖层：屏幕空间恒定的集群标题 + 头部页名胶囊 =================
     画布内文字随缩放缩小，总览时不可读；这些标注用 HTML 绝对定位，任何缩放大小一致。 */
  let overlayRaf = 0;
  function scheduleOverlay() {
    if (overlayRaf) return;
    overlayRaf = requestAnimationFrame(() => { overlayRaf = 0; syncOverlay(); });
  }
  function syncOverlay() {
    if (!cy || state.view !== 'page') { el.labels.innerHTML = ''; return; }
    const zoom = cy.zoom();
    const vw = el.cy.clientWidth; const vh = el.cy.clientHeight;
    const placed = [];
    let html = '';
    const groups = cy.nodes('[kind = "group"]');
    const manyGroups = groups.length > 60; // 大站：小集群标签总览时隐藏，放大后浮现，避免「胶囊海洋」
    groups.forEach((g) => {
      const d = g.data();
      const bb = g.renderedBoundingBox();
      if (bb.x2 < -30 || bb.x1 > vw + 30 || bb.y2 < -30 || bb.y1 > vh + 30) return; // 框不在视口内
      const mini = bb.w < 96;
      if (mini && manyGroups && d.pages < 5 && zoom < 0.45) return;
      const estW = Math.min(mini ? 110 : 240, d.name.length * (mini ? 6 : 7.4) + (mini ? 16 : 52));
      // 大框标签锚在左上角；迷你小框标签水平居中压在框上，读作「图钉」而非游离文本
      const ax = mini ? (bb.x1 + bb.x2) / 2 - estW / 2 : bb.x1 + 4;
      let x = Math.min(Math.max(ax, 8), Math.max(8, vw - estW - 8));
      let y = Math.min(Math.max(bb.y1 + 4, 8), vh - 24);
      for (let k = 0; k < 10; k += 1) { // 与已放置标签碰撞则下移
        const hit = placed.find((r) => Math.min(r.x2, x + estW) - Math.max(r.x1, x) > 4 && Math.min(r.y2, y + 20) - Math.max(r.y1, y) > 4);
        if (!hit) break;
        y = hit.y2 + 3;
      }
      placed.push({ x1: x, y1: y, x2: x + estW, y2: y + 20 });
      html += '<div class="g-label' + (mini ? ' mini' : '') + '" style="left:' + Math.round(x) + 'px;top:' + Math.round(y)
        + 'px;color:' + d.border + '">' + esc(d.name) + (mini ? '' : '<span class="n">' + d.pages + ' 页</span>') + '</div>';
    });
    if (zoom < (pageMode === 'rankfold' ? 1.3 : 0.55)) { // 概览缩放下标出入口页；放大后交给画布内标签（热门图画布标签 1.5 起浮现，胶囊门槛相应抬高，避免并存/断档）
      cy.nodes('[hub = "yes"]').forEach((n) => {
        const p = n.renderedPosition();
        if (p.x < -20 || p.x > vw + 20 || p.y < -20 || p.y > vh + 20) return;
        const label = shortLabel(n.data('path'));
        const cw = Math.min(180, label.length * 6.2 + 16);
        const x = Math.min(Math.max(p.x, cw / 2 + 8), vw - cw / 2 - 8);
        let y = Math.min(Math.max(p.y + n.renderedOuterHeight() / 2 + 7, 16), vh - 14);
        let chip = { x1: x - cw / 2, y1: y, x2: x + cw / 2, y2: y + 17 };
        for (let k = 0; k < 3; k += 1) { // 与标签/其他胶囊碰撞：下移让位，仍冲突则放弃（避免堆叠成串）
          const hit = placed.find((r) => Math.min(r.x2, chip.x2) - Math.max(r.x1, chip.x1) > 2 && Math.min(r.y2, chip.y2) - Math.max(r.y1, chip.y1) > 2);
          if (!hit) break;
          y = hit.y2 + 3;
          chip = { x1: x - cw / 2, y1: y, x2: x + cw / 2, y2: y + 17 };
          if (k === 2) return;
        }
        placed.push(chip);
        html += '<div class="hub-chip" style="left:' + Math.round(x) + 'px;top:' + Math.round(y) + 'px;">' + esc(label) + '</div>';
      });
    }
    el.labels.innerHTML = html;
  }

  const STYLE = [
    // 页面节点：集群色椭圆，大小=入度；标签短名，按数据分级浮现（data(font)/data(minFont)）
    { selector: 'node', style: {
      'background-color': 'data(color)', 'border-width': 1.5, 'border-color': 'data(border)',
      width: 'data(size)', height: 'data(size)',
      label: 'data(label)', color: '#55637a', 'font-size': 'data(font)',
      'text-valign': 'bottom', 'text-halign': 'center', 'text-max-width': 110, 'text-wrap': 'wrap',
      'min-zoomed-font-size': 'data(minFont)', 'text-margin-y': 5,
      'text-background-color': '#f5f6f8', 'text-background-opacity': 1,
      'text-background-padding': 3, 'text-background-shape': 'roundrectangle',
      'transition-property': 'opacity background-color border-color text-opacity', 'transition-duration': 0.18,
    } },
    // 集群节点：统一「淡色填充 + 集群色描边 + 集群色文字」卡（与页面视图分组框同一视觉语言）
    { selector: 'node[kind = "cluster"]', style: {
      shape: 'round-rectangle', 'corner-radius': 10,
      'background-color': 'data(color)', 'background-opacity': 0.14,
      'border-color': 'data(border)', 'border-width': 1.5, 'border-opacity': 0.9,
      width: 'data(w)', height: 'data(h)',
      label: 'data(label)', color: 'data(border)', 'font-size': 12, 'font-weight': 650,
      'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': 'data(w)',
      'min-zoomed-font-size': 0, 'text-margin-y': 0, 'text-background-opacity': 0,
    } },
    // 页面视图的集群分组框（compound 父节点）：淡色填充 + 集群色描边，页面收纳其中
    // 标题交给 HTML 覆盖层（#group-labels）——屏幕空间恒定，任何缩放都可读
    { selector: 'node[kind = "group"]', style: {
      shape: 'round-rectangle', 'corner-radius': 10,
      'background-color': 'data(color)', 'background-opacity': 0.08,
      'border-color': 'data(border)', 'border-width': 1.5, 'border-opacity': 0.75,
      padding: 26,
      label: '',
      'min-zoomed-font-size': 0, 'text-background-opacity': 0,
    } },
    // 悬停微反馈：描边加重（侧栏联动 spot 共用更高一档）
    { selector: 'node.hov', style: { 'border-width': 3, 'border-opacity': 1 } },
    // 长尾聚合卡：虚线描边区分「折叠出来的组」与真实集群
    { selector: 'node.tail', style: { 'border-style': 'dashed', 'border-width': 2, 'background-opacity': 0.1 } },
    // 热门图的长尾聚合节点：灰系虚线大节点，读作「折叠的质量」而非页面
    { selector: 'node.fold', style: { 'border-style': 'dashed', 'border-width': 2, 'background-opacity': 0.22 } },
    // 类目组锚点（来源类目页）：加粗描边 + 常显标签，读作「组的入口」
    { selector: 'node.anchor', style: { 'border-width': 3, 'font-size': 13, 'font-weight': 650, 'min-zoomed-font-size': 6, 'text-opacity': 0.95 } },
    { selector: 'node.gsrc', style: { 'border-width': 2.5 } }, // 类目来源页（双击进组图）
    // 集群聚合块（外部关联）：比逐页 ghost 更实一些，标签常显（权重 ↗/↘ 就是它的信息量；minFont 走 data）
    { selector: 'node.ghostc', style: { opacity: 0.92, 'background-opacity': 0.7, 'text-opacity': 0.95, 'font-weight': 600 } },
    // 侧栏集群悬停：画布内对应分组框/卡片描边加强
    { selector: 'node.spot', style: { 'border-width': 2.6, 'border-opacity': 1 } },
    { selector: 'node[kind = "group"].spot', style: { 'background-opacity': 0.16 } },
    // 非 sitemap 页 / 聚焦视图里的外部关联页：小、淡、标签需放大才显示
    { selector: 'node[ghost = "yes"]', style: {
      'border-style': 'dashed', 'background-opacity': 0.35, opacity: 0.5,
      'text-opacity': 0.6, 'min-zoomed-font-size': 14,
    } },
    // 边：源集群着色，粗细=链接次数；导航边淡虚线；走线方式 data(curve)（集群视图 bezier，页面视图 taxi 直角）
    { selector: 'edge', style: {
      'curve-style': 'data(curve)', 'taxi-turn': '42%', 'taxi-turn-min-distance': 16, 'taxi-radius': 8,
      width: 'data(width)', 'line-color': 'data(color)',
      'line-opacity': 'data(op)',
      'target-arrow-shape': 'triangle', 'arrow-scale': 0.6, 'arrow-color': 'data(color)',
      'transition-property': 'line-opacity opacity width', 'transition-duration': 0.18,
    } },
    { selector: 'edge.chrome', style: { 'line-style': 'dashed', 'line-opacity': 0.15 } },
    // 选中：邻域边提亮加粗；非焦点节点整体灰化（比低透明度更像"有意弱化"而非残影）
    { selector: 'edge.hl', style: { 'line-opacity': 0.95, width: 'data(hlw)' } },
    { selector: 'node.dimmed', style: {
      'background-color': '#c9d2dd', 'border-color': '#bfcad8', 'text-opacity': 0, opacity: 0.22,
    } },
    { selector: 'edge.dimmed', style: { 'line-opacity': 0.05, opacity: 0.06 } },
    { selector: ':selected', style: {
      'border-width': 3, 'border-color': '#1c2b3a',
      'overlay-color': '#3465d4', 'overlay-opacity': 0.16, 'overlay-padding': 7,
    } },
  ];

  function pageEdgeEls(e, faint, soft) {
    const f = byPath.get(e.from); const t = byPath.get(e.to);
    const fromCluster = f ? f.cluster : '';
    const sameCluster = f && t && f.cluster === t.cluster;
    const col = clusterColor(fromCluster);
    const base = 1 + 2.8 * (e.count / maxEdgeCount);
    return {
      data: {
        id: 'e:' + e.from + '|' + e.to + (e.chrome ? ':c' : ''),
        source: 'p:' + e.from, target: 'p:' + e.to, count: e.count, chrome: !!e.chrome,
        color: col,
        curve: soft || sameCluster ? 'bezier' : 'taxi', // 框内弧线（密集区柔），跨框直角（长程有序）；soft=组视图强制弧线
        width: base, hlw: base * 1.35,
        // 框内边是「纹理层」（更淡），跨框边是「结构层」（保持可读）
        op: faint ? 0.14 : (e.chrome ? 0.15 : sameCluster ? 0.13 + 0.1 * (e.count / maxEdgeCount) : 0.18 + 0.18 * (e.count / maxEdgeCount)),
      },
      classes: e.chrome ? 'chrome' : '',
    };
  }

  function buildElements() {
    const nodes = []; const edges = [];
    if (state.view === 'cluster') {
      const cards = tailInfo ? clusterList.filter((c) => c.pages.length > 2) : clusterList;
      for (const c of cards) {
        const small = c.pages.length <= 2;
        const w = small
          ? Math.max(74, 30 + c.name.length * 7.2)
          : 74 + 92 * Math.sqrt(c.pages.length / maxPages) + Math.min(26, c.name.length * 2.4);
        nodes.push({ data: {
          id: 'c:' + c.name, name: c.name,
          label: small ? c.name : c.name + '\n' + c.pages.length + ' 页',
          kind: 'cluster', small: small ? 'yes' : 'no',
          w: Math.round(w), h: Math.round(small ? 30 : 40 + 30 * Math.sqrt(c.pages.length / maxPages)),
          size: 40, font: 12, minFont: 0, color: c.color, border: c.border,
        } });
      }
      if (tailInfo) {
        const n = tailInfo.cluster.pages.length;
        nodes.push({ data: {
          id: 'c:' + TAIL, name: TAIL,
          label: '长尾集群\n' + tailInfo.members.length + ' 个小集群 · ' + n + ' 页',
          kind: 'cluster', small: 'no',
          w: Math.round(74 + 92 * Math.sqrt(n / maxPages) + 30), h: Math.round(40 + 30 * Math.sqrt(n / maxPages)),
          size: 40, font: 12, minFont: 0, color: tailInfo.cluster.color, border: tailInfo.cluster.border,
        }, classes: 'tail' });
      }
      // 大站：小集群的边并入长尾聚合卡（先过滤阈值再折叠，聚合对计数求和；长尾互链不画）
      const smallSet = tailInfo ? new Set(tailInfo.members.map((c) => c.name)) : null;
      const push = (map, chrome) => {
        const agg = new Map();
        map.forEach((count, key) => {
          if (count < state.minCount) return;
          let [a, b] = key.split('\u0000');
          if (smallSet) { if (smallSet.has(a)) a = TAIL; if (smallSet.has(b)) b = TAIL; }
          if (a === b) return;
          const k = a + '\u0000' + b;
          agg.set(k, (agg.get(k) || 0) + count);
        });
        agg.forEach((count, key) => {
          const [a, b] = key.split('\u0000');
          edges.push({
            data: {
              id: (chrome ? 'cx:' : 'ce:') + a + '|' + b,
              source: 'c:' + a, target: 'c:' + b, count, chrome,
              color: clusterColor(a), curve: 'bezier', width: 1.2 + 3.6 * (count / maxAgg), hlw: (1.2 + 3.6 * (count / maxAgg)) * 1.35,
              op: chrome ? 0.16 : 0.34 + 0.3 * (count / maxAgg),
            },
            classes: chrome ? 'chrome' : '',
          });
        });
      };
      push(aggContent, false);
      if (state.chrome) push(aggChrome, true);
      return { nodes, edges };
    }

    // 页面视图：聚焦渲染路由（全站平铺只保留给小站——大站在 renderGraph 分流为引导/面板/聚焦）
    const sc = normScope(state.scope);
    if (!sc) {
      pageMode = null;
      for (const c of clusterList) {
        nodes.push(groupNode(c));
        for (const p of c.pages) nodes.push(pageNode(p, !p.inSitemap, 'g:' + c.name));
      }
      const es = allEdges.filter((e) => (state.chrome || !e.chrome) && e.count >= state.minCount);
      for (const e of es) edges.push(pageEdgeEls(e, false));
      return { nodes, edges };
    }
    const cObj = clusterMap.get(sc.cluster);
    if (!cObj) return { nodes, edges };
    // 聚焦成员池：小集群=整集群；大集群=类目组 / 长尾组 / 热门池（目录面板态不会到达）
    let pool = cObj.pages;
    let anchor = null;
    if (bigSite && cObj.pages.length > FOCUS_MEMBER_LIMIT) {
      const sk = clusterSkeleton(sc.cluster);
      if (sc.group === TAIL) pool = sk.foldedMembers.concat(sk.unlinked);
      else if (sc.group) {
        const g = sk.byKey.get(sc.group);
        pool = g ? g.members : [];
        anchor = g ? g.src : null;
      } else pool = sc.hot || !sk.usable ? cObj.pages : [];
    }
    if (pool.length + (anchor ? 1 : 0) > FOCUS_MEMBER_LIMIT) return rankFoldEls(cObj, pool, anchor);
    return focusEls(cObj, pool, anchor);
  }

  // 页面节点元素：集群色椭圆，大小=入度，标签分级浮现（hub=入度头部页）
  const pageNode = (p, ghost, parent) => ({ data: {
    id: 'p:' + p.path, kind: 'page', path: p.path, parent: parent || undefined,
    label: shortLabel(p.path), ghost: ghost ? 'yes' : 'no',
    size: (ghost ? 15 : 20) + (ghost ? 14 : 30) * (p.inDegree / maxIn),
    color: clusterColor(p.cluster), border: (clusterMap.get(p.cluster) || {}).border || '#5f6a7a',
    cluster: p.cluster, inD: p.inDegree, outD: p.outDegree,
    hub: p.inDegree >= hubMin ? 'yes' : 'no',
    font: p.inDegree >= hubMin ? 12 : 10,
    minFont: p.inDegree >= hubMin ? 7 : 9.5,
  } });
  // 页面视图的集群分组框（compound 父节点）；n=框内实际渲染页数（截断/折叠时与集群总页数不同）
  const groupNode = (c, n) => ({ data: {
    id: 'g:' + c.name, kind: 'group', name: c.name, pages: n || c.pages.length,
    label: c.name + ' · ' + (n || c.pages.length) + ' 页', size: 40, font: 11, minFont: 0,
    color: c.color, border: c.border,
  } });

    // 聚焦图：成员入集群分组框 + 外部关联；大站外部按集群聚合（见 pushAggGhost），小站逐页 ghost
  function focusEls(cObj, pool, anchor) {
    const nodes = []; const edges = [];
    // 小型类目组视图（≤60 成员）：这是主阅读视图，标签常显 + fit 后钳制缩放，落地即可读
    pageMode = anchor && pool.length <= 60 ? 'group' : 'focus';
    const es = allEdges.filter((e) => (state.chrome || !e.chrome) && e.count >= state.minCount);
    let members = pool;
    if (members.length > FOCUS_MEMBER_LIMIT) {
      members = members.slice().sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path)).slice(0, FOCUS_MEMBER_LIMIT);
    }
    const member = new Set(members.map((p) => p.path));
    if (anchor) member.add(anchor.path);
    const kept = [];
    for (const e of es) {
      const fIn = member.has(e.from); const tIn = member.has(e.to);
      if (!fIn && !tIn) continue;
      kept.push({ e, faint: !(fIn && tIn) });
    }
    // 聚焦视图的边常是目录页互链/目录→单品的星形（可上万条），大站统一按权重截断为纹理层上限
    let final = kept;
    if (bigSite) final = kept.slice().sort((a, b) => b.e.count - a.e.count).slice(0, 2500);
    nodes.push(groupNode(cObj, members.length));
    for (const p of members) {
      const n = pageNode(p, !p.inSitemap, 'g:' + cObj.name);
      if (pageMode === 'group') n.data.minFont = 8.5;
      if (groupAnchorOf(p.path)) n.classes = 'gsrc'; // 类目来源页：粗描边提示可双击进组图
      nodes.push(n);
    }
    if (anchor) { const a = pageNode(anchor, false); a.classes = 'anchor'; nodes.push(a); } // 来源类目页：组的锚点
    if (bigSite) {
      const inOut = [];
      for (const k of final) { if (k.faint) inOut.push(k.e); else edges.push(pageEdgeEls(k.e, false, true)); } // 组视图内边统一弧线（含锚点星形，直角总线会毁掉星形可读性）
      pushAggGhost(nodes, edges, cObj, inOut, (path) => member.has(path));
      return { nodes, edges };
    }
    for (const k of final) edges.push(pageEdgeEls(k.e, k.faint));
    const outside = new Map();
    for (const k of final) {
      if (!member.has(k.e.from) && !outside.has(k.e.from)) outside.set(k.e.from, byPath.get(k.e.from));
      if (!member.has(k.e.to) && !outside.has(k.e.to)) outside.set(k.e.to, byPath.get(k.e.to));
    }
    for (const p of outside.values()) nodes.push(pageNode(p, true));
    return { nodes, edges };
  }

  // 外部关联按集群聚合为「集群质量块」：电商单品页的面包屑会指向上百个类目页，
  // 逐页 ghost 会淹没主体；聚合后每集群一个节点 + 组框↔集群各一条合计边（单击看集群、双击聚焦）
  // maxCl：聚焦组视图保留多些；热门总览只留头部（其余块的边会汇成毛发球）
  function pushAggGhost(nodes, edges, cObj, outerEdges, isMember, maxCl, minFont) {
    const agg = new Map();
    for (const e of outerEdges) {
      const other = isMember(e.from) ? byPath.get(e.to) : byPath.get(e.from);
      if (!other) continue;
      let a = agg.get(other.cluster);
      if (!a) { a = { cluster: other.cluster, out: 0, in: 0, pages: new Set() }; agg.set(other.cluster, a); }
      if (isMember(e.from)) a.out += e.count; else a.in += e.count;
      a.pages.add(other.path);
    }
    const list = [...agg.values()].sort((x, y) => (y.out + y.in) - (x.out + x.in) || x.cluster.localeCompare(y.cluster)).slice(0, maxCl || 24);
    const maxW = list.reduce((m, a) => Math.max(m, a.out + a.in), 1);
    for (const a of list) {
      const cc = clusterMap.get(a.cluster) || { color: '#8a95a5', border: '#5f6a7a' };
      nodes.push({ data: {
        id: 'gc:' + a.cluster, kind: 'ghostc', name: a.cluster,
        label: tailName(a.cluster) + '\n' + (a.out ? '↗' + a.out : '') + (a.out && a.in ? ' · ' : '') + (a.in ? '↘' + a.in : ''),
        ghost: 'yes',
        size: 28 + 24 * ((a.out + a.in) / maxW), color: cc.color, border: cc.border,
        cluster: a.cluster, inD: 0, outD: 0, hub: 'no', font: 12, minFont: minFont || 8,
        gout: a.out, gin: a.in,
      }, classes: 'ghostc' });
      const w = Math.min(8, 1.6 + 4.2 * ((a.out + a.in) / maxW));
      if (a.out) edges.push({ data: {
        id: 'ag:o|' + a.cluster, source: 'g:' + cObj.name, target: 'gc:' + a.cluster, count: a.out, chrome: false,
        color: cObj.color, curve: 'bezier', width: w, hlw: w * 1.3, op: 0.42,
      } });
      if (a.in) edges.push({ data: {
        id: 'ag:i|' + a.cluster, source: 'gc:' + a.cluster, target: 'g:' + cObj.name, count: a.in, chrome: false,
        color: cc.color, curve: 'bezier', width: w, hlw: w * 1.3, op: 0.42,
      } });
    }
  }

  // 热门+长尾聚合图：入度 Top N 真实节点 + 长尾聚合节点（每页一条合计边）+ 外部集群聚合块。
  // 概览级 LOD：页面/聚合块画布标签默认隐藏（minFont 抬高），页名交给 HTML hub-chips（缩放<1.3 常显）
  let lastFold = null; // 当前热门图的长尾清单（聚合节点详情用）
  let pageMode = null; // 'rankfold' | 'focus' —— 覆盖层胶囊的缩放门槛随模式变化
  function rankFoldEls(cObj, pool, anchor) {
    const nodes = []; const edges = [];
    const es = allEdges.filter((e) => (state.chrome || !e.chrome) && e.count >= state.minCount);
    const ranked = pool.slice().sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path));
    const shownSet = new Set(ranked.slice(0, RANKFOLD_LIMIT).map((p) => p.path));
    if (anchor) shownSet.add(anchor.path); // 来源页与 pin 页始终可见
    if (state.pin) { const pp = byPath.get(state.pin); if (pp && pool.includes(pp)) shownSet.add(state.pin); }
    const shownPages = pool.filter((p) => shownSet.has(p.path));
    const tailPages = pool.filter((p) => !shownSet.has(p.path));
    lastFold = { cluster: cObj.name, tailPages };
    pageMode = 'rankfold';
    const tailSet = new Set(tailPages.map((p) => p.path));
    nodes.push(groupNode(cObj, shownPages.length));
    // hub 标记按视图内排名取头部（全局阈值在扁平集群里会高到无人达标），
    // 概览级页名由 HTML hub-chips 承担，画布标签放大才浮现
    const hubTop = new Set(ranked.slice(0, 20).map((p) => p.path));
    const viewMaxIn = Math.max(1, ranked.length ? ranked[0].inDegree : 1);
    for (const p of shownPages) {
      const n = pageNode(p, !p.inSitemap, 'g:' + cObj.name);
      n.data.size = 20 + 30 * (p.inDegree / viewMaxIn); // 大小编码按视图内头部缩放——全局分母会把扁平集群压成同尺寸
      n.data.minFont = 15; // 网格密排下概览级标签会互相碾压，放大（≥1.5）才浮现
      if (hubTop.has(p.path)) { n.data.hub = 'yes'; n.data.font = 12; }
      if (groupAnchorOf(p.path)) n.classes = 'gsrc';
      nodes.push(n);
    }
    if (anchor) { const a = pageNode(anchor, false); a.classes = 'anchor'; nodes.push(a); }
    if (tailPages.length) nodes.push({ data: {
      id: 'p:' + TAIL, kind: 'fold', path: TAIL,
      label: '长尾 · ' + tailPages.length + ' 页', ghost: 'no',
      size: 58, color: '#b9c4d2', border: '#6b7787', cluster: cObj.name, inD: 0, outD: 0,
      hub: 'no', font: 13, minFont: 8,
    }, classes: 'fold' });
    const inner = []; const outer = []; const toTail = new Map(); const fromTail = new Map();
    for (const e of es) {
      const fS = shownSet.has(e.from); const tS = shownSet.has(e.to);
      if (fS && tS) { inner.push(e); continue; }
      const fT = !fS && tailSet.has(e.from); const tT = !tS && tailSet.has(e.to);
      if (fT || tT) { // 长尾边按页聚合成一条（次数求和）
        if (fS) toTail.set(e.from, (toTail.get(e.from) || 0) + e.count);
        if (tS) fromTail.set(e.to, (fromTail.get(e.to) || 0) + e.count);
        continue;
      }
      if (fS || tS) outer.push(e);
    }
    inner.sort((a, b) => b.count - a.count);
    inner.slice(0, 2000).forEach((e) => edges.push(pageEdgeEls(e, false)));
    const wMax = inner.length ? inner[0].count : 1;
    const foldEdge = (suffix, src, dst, count) => {
      if (!count || !tailPages.length) return;
      const w = Math.min(9, 1.6 + 4.4 * Math.sqrt(count / wMax));
      edges.push({ data: {
        id: 'ef:' + suffix, source: src, target: dst, count, chrome: false,
        color: clusterColor(cObj.name), curve: 'bezier', width: w, hlw: w * 1.3, op: 0.42,
      } });
    };
    shownSet.forEach((path) => {
      foldEdge('t|' + path, 'p:' + path, 'p:' + TAIL, toTail.get(path) || 0);
      foldEdge('f|' + path, 'p:' + TAIL, 'p:' + path, fromTail.get(path) || 0);
    });
    // 外部关联按集群聚合（同聚焦视图）：热门图主体是 Top N + 长尾，只留头部集群块
    pushAggGhost(nodes, edges, cObj, outer, (path) => shownSet.has(path), 8, 14);
    return { nodes, edges };
  }

  function layoutConf() {
    if (state.view === 'cluster') return { name: 'fcose', nodeSeparation: 155, idealEdgeLength: 190, gravity: 0.45, gravityRange: 3.2, packComponents: true };
    // 大站聚焦用 draft 档：fCoSE 求解器默认档在百节点复合图上要秒级，draft 配合后置去重叠足够
    if (state.scope) return { name: 'fcose', quality: bigSite ? 'draft' : 'default', numIter: bigSite ? 900 : 2500, nodeSeparation: 95, idealEdgeLength: 125, gravity: 0.35, gravityRange: 3, packComponents: true };
    return { name: 'fcose', nodeSeparation: 50, idealEdgeLength: 82, gravity: 0.5, gravityRange: 3.6, packComponents: true };
  }

  // fcose 允许少量节点重叠；布局后迭代推开相交单元。复合父节点整体平移其子节点（父框随子自动伸缩）。
  function unitOf(n) {
    if (n.isParent()) {
      const kids = n.descendants();
      return { box: () => n.boundingBox(), shift: (dx, dy) => kids.shift({ x: dx, y: dy }) };
    }
    return { box: () => n.boundingBox({ includeLabels: true }), shift: (dx, dy) => n.shift({ x: dx, y: dy }) };
  }
  function deoverlapUnits(units, padding, rounds) {
    for (let r = 0; r < rounds; r += 1) {
      let moved = false;
      const boxes = units.map((u) => {
        const b = u.box();
        return { u, x1: b.x1 - padding, y1: b.y1 - padding, x2: b.x2 + padding, y2: b.y2 + padding, cx: (b.x1 + b.x2) / 2, cy: (b.y1 + b.y2) / 2 };
      });
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i]; const b = boxes[j];
          const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
          const oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          const dx = (b.cx - a.cx) || 0.5;
          const dy = (b.cy - a.cy) || 0.5;
          // 沿最小穿透轴分离，且单轮推力设上限：大复合分组框的重叠可达数千像素，
          // 无上限的正比推力会在多轮迭代中把整张图撑到视口外（发散）
          if (ox <= oy) {
            const step = (Math.min(ox / 2 + 2, 80)) * Math.sign(dx);
            a.u.shift(-step, 0);
            b.u.shift(step, 0);
          } else {
            const step = (Math.min(oy / 2 + 2, 80)) * Math.sign(dy);
            a.u.shift(0, -step);
            b.u.shift(0, step);
          }
        }
      }
      if (!moved) break;
    }
  }

  // 大站替代方案：顶层单元过多时去重叠迭代会发散（每单元每轮被多个邻居叠加推动），
  // 改用确定性的 shelf 装箱——按高降序逐行摆放，结果有界且整齐
  function packUnitsShelf(units, gap) {
    const items = units
      .map((u) => { const b = u.box(); return { u, w: b.w, h: b.h, x: b.x1, y: b.y1 }; })
      .sort((a, b) => b.h - a.h || b.w - a.w);
    const totalArea = items.reduce((s, it) => s + it.w * it.h, 0);
    const targetW = Math.max(1200, Math.sqrt(totalArea) * 1.5);
    let x = 0; let y = 0; let rowH = 0;
    for (const it of items) {
      if (x > 0 && x + it.w + gap > targetW) { x = 0; y += rowH + gap; rowH = 0; }
      it.u.shift(x - it.x, y - it.y);
      x += it.w + gap;
      rowH = Math.max(rowH, it.h);
    }
  }

  // 大站页面视图的确定性布局：力导向在数百复合组 + 上万边的规模下会把布局摊到十万像素级，
  // 这里改为「组内按入度网格（头部页靠左上）+ 组间 shelf 装箱」，规模有界且秒级完成
  function layoutBigPage(cy) {
    const gap = 46; const pad = 60;
    const groups = cy.nodes('[kind = "group"]');
    const items = [];
    groups.forEach((g) => {
      const kids = g.children()
        .toArray()
        .sort((a, b) => (b.data('inD') || 0) - (a.data('inD') || 0) || String(a.data('path')).localeCompare(String(b.data('path'))));
      const cols = Math.max(1, Math.ceil(Math.sqrt(kids.length)));
      items.push({ kids, cols, w: cols * gap, h: Math.ceil(kids.length / cols) * gap });
    });
    const ghosts = cy.nodes().orphans().filter((n) => !n.isParent()).toArray();
    if (ghosts.length) {
      const cols = Math.max(1, Math.ceil(Math.sqrt(ghosts.length)));
      items.push({ kids: ghosts, cols, w: cols * gap, h: Math.ceil(ghosts.length / cols) * gap });
    }
    items.sort((a, b) => b.h - a.h || b.w - a.w);
    const totalArea = items.reduce((s, it) => s + it.w * it.h, 0);
    const targetW = Math.max(1400, Math.sqrt(totalArea) * 1.6);
    const positions = [];
    let x = 0; let y = 0; let rowH = 0;
    for (const it of items) {
      if (x > 0 && x + it.w + pad > targetW) { x = 0; y += rowH + pad; rowH = 0; }
      it.kids.forEach((n, i) => {
        positions.push([n, { x: x + (i % it.cols) * gap, y: y + Math.floor(i / it.cols) * gap }]);
      });
      x += it.w + pad;
      rowH = Math.max(rowH, it.h);
    }
    cy.batch(() => { positions.forEach(([n, p]) => { n.position(p); }); });
  }

  function renderGraph() {
    const seq = ++renderSeq;
    // 大站：页面视图按集群下钻——全站平铺（数百分组框 + 上万边）既不可读也拖不动，
    // 总览职责交给集群视图（含长尾折叠），这里给出引导态与快捷入口
    if (state.view === 'page' && bigSite && !state.scope) {
      if (cy) { try { cy.destroy(); } catch { /* ignore */ } cy = null; }
      closeInspector();
      el.labels.innerHTML = '';
      el.loading.hidden = true;
      el.legend.hidden = true;
      el.canvasControls.hidden = true;
      hideScopePanel(); // 从类目目录面板逐级返回时，两层浮层必须互斥
      showPageEmpty();
      return;
    }
    hidePageEmpty();
    // 目录面板态（大站）：超限大集群的全量目录，或类目来源集群的来源目录——
    // 两侧入口统一为「集群 → 类目目录 → 组图」，面板为 HTML 零渲染成本
    const sc0 = normScope(state.scope);
    const pinfo = scopePanelInfo(sc0);
    if (state.view === 'page' && pinfo) {
      if (cy) { try { cy.destroy(); } catch { /* ignore */ } cy = null; }
      closeInspector();
      el.labels.innerHTML = '';
      el.loading.hidden = true;
      el.legend.hidden = true;
      el.canvasControls.hidden = true;
      showScopePanel(sc0, pinfo);
      return;
    }
    hideScopePanel();
    const { nodes, edges } = buildElements();
    // 「集群页面图」（小集群全量成图）是类目树 + 面包屑近团：力导向会在上千条互链边上
    // 塌成中心毛球，超过边密度阈值同样交给确定性网格；页边透明度同步压一档防叠实
    const denseHot = state.view === 'page' && bigSite && sc0 && sc0.hot && !sc0.group;
    if (denseHot && edges.length > 1200) {
      for (const e of edges) if (String(e.data.id).startsWith('e:')) e.data.op = Math.min(e.data.op, 0.09);
    }
    if (cy) { try { cy.destroy(); } catch { /* ignore */ } }
    cy = cytoscape({
      container: el.cy, elements: nodes.concat(edges), style: STYLE,
      wheelSensitivity: 0.22, minZoom: 0.08, maxZoom: 2.4,
      // 交互期间不重绘边、以纹理快照平移缩放——大图（万级边）拖拽跟手的关键
      hideEdgesOnViewport: true,
      textureOnViewport: true,
    });
    bindGraphEvents();
    cy.on('render', scheduleOverlay);
    closeInspector();
    el.loading.hidden = false;
    // 大站页面视图：确定性布局替代力导向（有界、快；边密集时同样适用），加载态延迟一帧再算
    // 阈值 250：热门总览（Top250+聚合块）走网格；密集集群页面图（denseHot）超过 1200 边同走网格
    if (state.view === 'page' && (nodes.length > 250 || edges.length > 3000 || (denseHot && edges.length > 1200))) {
      const bigSeq = seq;
      setTimeout(() => {
        if (bigSeq !== renderSeq) return;
        try {
          layoutBigPage(cy);
          cy.fit(48);
        } catch { /* ignore */ }
        el.loading.hidden = true;
        scheduleOverlay();
      }, 30);
      setTimeout(() => { if (bigSeq === renderSeq) el.loading.hidden = true; }, 5000);
      return;
    }
    const finish = () => {
      if (seq !== renderSeq) return;
      el.loading.hidden = true;
      try {
        if (state.view === 'cluster') {
          deoverlapUnits(cy.nodes('[kind = "cluster"]').map(unitOf), 14, 30);
        } else {
          const groups = cy.nodes('[kind = "group"]');
          if (groups.length) {
            if (groups.length > 100) {
              // 大站：顶层分组框过多，去重叠会发散——shelf 装箱 + 组内去重叠
              packUnitsShelf(cy.nodes().orphans().map(unitOf), 26);
              groups.forEach((g) => deoverlapUnits(g.children().map(unitOf), 7, 14));
            } else {
              deoverlapUnits(cy.nodes().orphans().map(unitOf), 18, 26); // 集群框/顶层单元之间
              groups.forEach((g) => deoverlapUnits(g.children().map(unitOf), 7, 14)); // 框内页面
              deoverlapUnits(cy.nodes().orphans().map(unitOf), 22, 16); // 框被撑开后再补一轮分离
            }
          } else {
            deoverlapUnits(cy.nodes().map(unitOf), 8, 20);
          }
        }
        cy.fit(state.view === 'cluster' ? 64 : 40);
        // 小组视图落地即可读：fit 后缩放钳到 ≥0.95（成员名 10px 级、minFont 8.5 已浮现）
        if (pageMode === 'group' && cy.zoom() < 0.95) cy.zoom(0.95);
      } catch { /* ignore */ }
    };
    try {
      // 大站聚焦布局不做位移动画：fCoSE 求解 + 去重叠后直接 fit，省掉 420ms 动画帧
      const anim = !(state.view === 'page' && bigSite);
      cy.layout(Object.assign(layoutConf(), { animate: anim, animationDuration: anim ? 420 : 0, stop: finish })).run();
    } catch {
      try { cy.layout({ name: 'cose', animate: true, stop: finish }).run(); }
      catch { cy.layout({ name: 'grid', rows: Math.ceil(Math.sqrt(nodes.length)), stop: finish }).run(); }
    }
    setTimeout(() => { if (seq === renderSeq) finish(); }, bigSite ? 45000 : 20000);
  }

  /* ================= 图交互 ================= */
  function bindGraphEvents() {
    cy.on('select', 'node', (evt) => {
      const d = evt.target.data();
      dimOthers(evt.target);
      if (d.kind === 'page') showPage(d.path);
      else if (d.kind === 'fold') showFold();
      else showCluster(d.name);
    });
    cy.on('unselect', () => { if (cy.$(':selected').length === 0) clearDim(); });
    cy.on('dbltap', 'node', (evt) => {
      const d = evt.target.data();
      if (d.kind === 'page') {
        // 类目来源页双击直达其组图（与目录面板 chip 同一目的地），其余页面打开原页面；
        // 聚合集群块双击进入该集群默认形态（有目录则面板，否则成图）——全图统一手势
        const ga = groupAnchorOf(d.path);
        if (ga) return setScope({ cluster: ga.cluster, group: d.path });
        window.open(urlOf(d.path), '_blank', 'noopener');
      } else if (d.kind === 'fold') showFold();
      else setScope(d.name);
    });
    cy.on('mouseover', 'node', (evt) => { evt.target.addClass('hov'); showTip(nodeTip(evt.target)); });
    cy.on('mouseover', 'edge', (evt) => showTip(edgeTip(evt.target)));
    cy.on('mouseout', (evt) => {
      hideTip();
      if (evt.target && evt.target.isNode && evt.target.isNode()) evt.target.removeClass('hov');
    });
    cy.on('pan zoom', hideTip); // 平移/缩放时 tooltip 跟随会漂移，直接隐藏
    cy.on('tap', (evt) => {
      if (evt.target === cy) { clearSelection(); closeInspector(); }
    });
  }

  // 选中页面：保留其邻域；选中分组框：保留框内全部页面及其出入边。分组框永不灰化（保持结构稳定）。
  function dimOthers(node) {
    clearDim();
    let keep;
    if (node.isParent()) {
      const kids = node.descendants();
      keep = kids.union(kids.connectedEdges()).union(node);
    } else {
      keep = node.closedNeighborhood();
    }
    cy.elements().difference(keep).filter((ele) => !ele.isParent()).addClass('dimmed');
    keep.edges().addClass('hl');
  }
  function clearDim() { if (cy) cy.elements().removeClass('dimmed hl'); }
  function clearSelection() { if (cy) { cy.elements().unselect(); } clearDim(); hideTip(); }

  const idToKey = (id) => String(id).slice(2);
  const idLabel = (k) => (k === TAIL ? '长尾聚合' : k);
  function nodeTip(n) {
    const d = n.data();
    if (d.kind === 'fold') {
      return tt('#8a95a5', '<div class="tt-path">长尾聚合 · ' + (lastFold ? lastFold.tailPages.length : 0) + ' 页</div><div class="tt-sub">'
        + esc(tailName(d.cluster)) + ' 集群 · 未进入热门 Top ' + RANKFOLD_LIMIT + ' 的页面</div><div class="tt-sub">单击查看长尾清单</div>');
    }
    if (d.kind === 'ghostc') {
      const c = clusterMap.get(d.name) || {};
      return tt(c.border || '#8a95a5', '<div class="tt-path">' + esc(tailName(d.name)) + ' 集群关联</div><div class="tt-sub">'
        + '出向 ' + (d.gout || 0) + ' 次 / 入向 ' + (d.gin || 0) + ' 次</div><div class="tt-sub">单击查看集群 · 双击聚焦该集群</div>');
    }
    if (d.kind === 'group' || d.kind === 'cluster') {
      const c = clusterMap.get(d.name) || {};
      const head = d.name === TAIL
        ? '长尾集群 · ' + (tailInfo ? tailInfo.members.length : 0) + ' 个小集群（≤2 页）'
        : esc(d.name);
      const cnt = d.kind === 'group' && d.pages !== c.pages.length
        ? d.pages + ' / ' + c.pages.length + ' 页（渲染/集群）'
        : (c.pages || []).length + ' 页';
      return tt(c.border, '<div class="tt-path">' + head + '</div><div class="tt-sub">'
        + cnt + ' · 内部链接 ' + (c.internal || 0) + ' · 出向 ' + sum(c.out || new Map())
        + ' / 入向 ' + sum(c.in || new Map()) + '</div><div class="tt-sub">' + (d.name === TAIL ? '单击查看小集群清单' : '双击聚焦集群子图') + '</div>');
    }
    const p = byPath.get(d.path) || {};
    const cc = clusterMap.get(p.cluster) || {};
    const ga = groupAnchorOf(d.path);
    return tt(cc.border, '<div class="tt-path">' + esc(p.path || d.path) + '</div><div class="tt-sub">'
      + esc(p.cluster || '') + ' · 入度 ' + (p.inDegree ?? '-') + ' · 出度 ' + (p.outDegree ?? '-')
      + '</div><div class="tt-sub">' + (ga ? '类目来源 · 双击进入其类目组（' + ga.size + ' 页）' : '双击打开原页面') + '</div>');
  }
  function edgeTip(e) {
    const d = e.data();
    const p = byPath.get(idToKey(d.source));
    const col = p ? (clusterMap.get(p.cluster) || {}).border : '#c6cfda';
    const isFold = d.source === 'p:' + TAIL || d.target === 'p:' + TAIL;
    return tt(col, '<div class="tt-path">' + esc(idLabel(idToKey(d.source))) + ' → ' + esc(idLabel(idToKey(d.target)))
      + '</div><div class="tt-sub">链接 ' + d.count + ' 次' + (isFold ? '（长尾合计）' : '') + (d.chrome ? ' · 全站导航边' : '') + '</div>');
  }
  const tt = (color, inner) => { el.tooltip.style.setProperty('--tt', color || '#c6cfda'); return inner; };

  let mouseXY = { x: 0, y: 0 };
  el.cy.addEventListener('mousemove', (ev) => { mouseXY = { x: ev.clientX, y: ev.clientY }; if (!el.tooltip.hidden) placeTip(); });
  function placeTip() {
    const pad = 14; const r = el.tooltip.getBoundingClientRect();
    let x = mouseXY.x + pad; let y = mouseXY.y + pad;
    if (x + r.width > innerWidth - 8) x = Math.max(8, mouseXY.x - r.width - pad);
    if (y + r.height > innerHeight - 8) y = Math.max(8, mouseXY.y - r.height - pad);
    el.tooltip.style.left = x + 'px'; el.tooltip.style.top = y + 'px';
  }
  function showTip(html) { el.tooltip.innerHTML = html; el.tooltip.hidden = false; placeTip(); }
  function hideTip() { el.tooltip.hidden = true; }

  /* ================= 画布控制条 ================= */
  $('#zoom-in').addEventListener('click', () => cy && cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }));
  $('#zoom-out').addEventListener('click', () => cy && cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }));
  $('#zoom-fit').addEventListener('click', () => cy && cy.fit(36));

  /* ================= 视图切换 ================= */
  function syncSeg(v) {
    el.segButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  }
  function showCanvas() {
    el.dataView.hidden = true; el.cy.style.display = '';
    el.legend.hidden = !legendOpen;
    el.canvasControls.hidden = false;
  }
  // 大站页面视图引导态：全站平铺不可读，给出头部集群快捷入口（点击即聚焦）
  function showPageEmpty() {
    const box = $('#page-empty');
    box.querySelector('.pe-num-pages').textContent = pages.length;
    box.querySelector('.pe-num-clusters').textContent = clusterList.length;
    const quick = $('#pe-quick');
    if (!quick.childElementCount) {
      const items = clusterList.filter((c) => c.pages.length > 2).slice(0, 10)
        .map((c) => ({ name: c.name, n: c.pages.length, color: c.color, label: c.name }));
      if (tailInfo) items.push({ name: TAIL, n: tailInfo.cluster.pages.length, color: '#8a95a5', label: '长尾集群' });
      quick.innerHTML = items.map((it) =>
        '<button data-cluster="' + esc(it.name) + '"><span class="dot" style="background:' + it.color + '"></span>'
        + '<span>' + esc(it.label) + '</span><i>' + it.n + ' 页</i></button>').join('');
    }
    box.hidden = false;
  }
  function hidePageEmpty() { $('#page-empty').hidden = true; }
  $('#pe-quick').addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('[data-cluster]');
    if (b) setScope(b.getAttribute('data-cluster'));
  });

  // 大集群类目目录面板：按「来源页所在集群」分节列出类目组（HTML，零渲染成本），
  // 类目组点击进入真实图；热门枢纽 pin 进热门总览图；长尾组同样可成图
  function showScopePanel(sc, info) {
    const c = clusterMap.get(sc.cluster);
    if (!c) return;
    info = info || scopePanelInfo(sc) || { mode: 'own' };
    const box = $('#scope-panel');
    const chip = (g, target) => '<button class="sp-chip" data-group="' + esc(g.key) + '"'
      + (target ? ' data-cl="' + esc(target) + '"' : '')
      + ' title="' + esc(g.key) + ' → ' + g.members.length + ' 个内容页">'
      + esc(shortLabel(g.key)) + '<i>' + g.members.length + '</i></button>';
    if (info.mode === 'src') {
      // 来源目录：本集群页面是大集群类目组的锚点——同一套「目录 → 组图」路径的对称入口
      const sp = info.sp;
      const gp = sp.groups.reduce((s, g) => s + g.members.length, 0);
      const tc = clusterMap.get(sp.target) || {};
      box.innerHTML = '<div class="sp-card">'
        + '<div class="sp-title"><span class="dot" style="background:' + c.color + '"></span>' + esc(tailName(sc.cluster))
        + '<i>' + c.pages.length + ' 页</i></div>'
        + '<p class="sp-sub">本集群是 <b>' + esc(tailName(sp.target)) + '</b> 的类目来源：' + sp.groups.length
        + ' 个类目组 · 共 ' + gp + ' 个内容页（按「最强内容入链来源」归组还原）。点击类目进入组图。</p>'
        + '<div class="sp-actions">'
        + '<button class="sp-act primary" data-graph>集群页面图 · ' + c.pages.length + ' 页</button>'
        + '</div>'
        + '<div class="sp-sec"><h4><span class="dot" style="background:' + tc.color + '"></span>' + esc(tailName(sp.target)) + ' 类目'
        + '<i>' + sp.groups.length + ' 组 · ' + gp + ' 页</i>'
        + '<button class="sp-go" data-cluster="' + esc(sp.target) + '">进入 ' + esc(tailName(sp.target)) + ' 目录 ↗</button></h4>'
        + '<div class="sp-chips">' + sp.groups.map((g) => chip(g, sp.target)).join('') + '</div></div>'
        + '<p class="sp-hint">点击类目进入该组页面图（来源类目页 + 内容页及其链接）· 集群页面图里类目页双击同样直达其组图 · 搜索任意路径直达</p></div>';
      box.hidden = false;
      return;
    }
    const sk = clusterSkeleton(sc.cluster);
    const secs = new Map();
    for (const g of sk.big) {
      const cn = g.src && g.src.cluster ? g.src.cluster : '(未知)';
      let s = secs.get(cn);
      if (!s) { s = { groups: [], pages: 0 }; secs.set(cn, s); }
      s.groups.push(g);
      s.pages += g.members.length;
    }
    const secAll = [...secs.entries()].sort((a, b) => b[1].pages - a[1].pages || a[0].localeCompare(b[0]));
    // 来源集群同样是长尾分布（品牌微集群各带 1-2 个类目）：≥3 组的来源单列成节，其余合并
    const secList = secAll.filter(([, s]) => s.groups.length >= 3);
    const minor = secAll.filter(([, s]) => s.groups.length < 3);
    const minorGroups = [];
    minor.forEach(([, s]) => { minorGroups.push(...s.groups); });
    minorGroups.sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key));
    const nonHub = c.pages.length - sk.hubs.length;
    const cover = sk.big.reduce((s, g) => s + g.members.length, 0);
    const tailN = sk.foldedMembers.length + sk.unlinked.length;
    let html = '<div class="sp-card">'
      + '<div class="sp-title"><span class="dot" style="background:' + c.color + '"></span>' + esc(tailName(sc.cluster))
      + '<i>' + c.pages.length + ' 页</i></div>'
      + '<p class="sp-sub">规模超过整集群成图上限（' + FOCUS_MEMBER_LIMIT + ' 页）。按「最强内容入链来源」还原类目结构：'
      + sk.big.length + ' 个类目组覆盖 ' + Math.round((cover / Math.max(1, nonHub)) * 100) + '% 非枢纽页'
      + ' · 枢纽页 ' + sk.hubs.length + '（入度 ≥ ' + HUB_IN_MIN + '）· 长尾 ' + tailN + ' 页</p>'
      + '<div class="sp-actions">'
      + '<button class="sp-act primary" data-hot>热门 Top ' + RANKFOLD_LIMIT + ' 总览图</button>'
      + '<button class="sp-act" data-tail>长尾 ' + tailN + ' 页成图</button>'
      + '</div>';
    if (sk.hubs.length) {
      html += '<div class="sp-sec"><h4>热门枢纽页（入度 Top ' + Math.min(20, sk.hubs.length) + '）</h4><div class="sp-chips">'
        + sk.hubs.slice(0, 20).map((p) => '<button class="sp-chip" data-pin="' + esc(p.path) + '" title="' + esc(p.path) + ' · 入度 ' + p.inDegree + '">'
          + esc(shortLabel(p.path)) + '<i>' + p.inDegree + '</i></button>').join('')
        + '</div></div>';
    }
    for (const [cn, s] of secList) {
      const cc = clusterMap.get(cn) || { color: '#8a95a5' };
      html += '<div class="sp-sec"><h4><span class="dot" style="background:' + cc.color + '"></span>' + esc(tailName(cn)) + ' 类目'
        + '<i>' + s.groups.length + ' 组 · ' + s.pages + ' 页</i>'
        + (cn !== sc.cluster ? '<button class="sp-go" data-cluster="' + esc(cn) + '">进入 ' + esc(tailName(cn)) + ' ↗</button>' : '')
        + '</h4><div class="sp-chips">' + s.groups.map((g) => chip(g)).join('') + '</div></div>';
    }
    if (minorGroups.length) {
      const minorPages = minorGroups.reduce((s, g) => s + g.members.length, 0);
      html += '<div class="sp-sec"><h4><span class="dot" style="background:#a8b3c2"></span>其他来源'
        + '<i>' + minor.length + ' 个来源集群 · ' + minorGroups.length + ' 组 · ' + minorPages + ' 页</i></h4><div class="sp-chips">'
        + minorGroups.map((g) => chip(g)).join('')
        + '</div></div>';
    }
    html += '<p class="sp-hint">点击类目进入该组页面图（来源类目页 + 单品及其链接）· 分区头可跳到该来源集群自己的类目目录 · 热门总览含长尾聚合节点 · 搜索任意路径直达其所在类目组</p></div>';
    box.innerHTML = html;
    box.hidden = false;
  }
  function hideScopePanel() {
    const b = $('#scope-panel');
    if (b) { b.hidden = true; b.innerHTML = ''; }
  }
  $('#scope-panel').addEventListener('click', (ev) => {
    const sc = normScope(state.scope);
    if (!sc) return;
    const pin = ev.target.closest && ev.target.closest('[data-pin]');
    if (pin) return setScope({ cluster: sc.cluster, hot: true }, pin.getAttribute('data-pin'));
    const graph = ev.target.closest && ev.target.closest('[data-graph]');
    if (graph) return setScope({ cluster: sc.cluster, hot: true }); // 来源目录 → 集群页面图（小集群全量成图）
    const cl = ev.target.closest && ev.target.closest('button[data-cluster]');
    if (cl) return focusCluster(cl.getAttribute('data-cluster')); // 分区头互链 → 来源集群自己的目录
    const hot = ev.target.closest && ev.target.closest('[data-hot]');
    if (hot) return setScope({ cluster: sc.cluster, hot: true });
    const tail = ev.target.closest && ev.target.closest('[data-tail]');
    if (tail) return setScope({ cluster: sc.cluster, group: TAIL });
    const g = ev.target.closest && ev.target.closest('[data-group]');
    if (g) return setScope({ cluster: g.getAttribute('data-cl') || sc.cluster, group: g.getAttribute('data-group') });
  });

  // 热门图长尾聚合节点的详情：按入度列出长尾页（点击定位＝pin 进热门图）
  function showFold() {
    if (!lastFold) return;
    const c = clusterMap.get(lastFold.cluster) || {};
    const top = lastFold.tailPages.slice().sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path));
    const items = top.slice(0, 80).map((p) => ({ path: p.path, extra: '入度 ' + p.inDegree }));
    openInspector('<div class="insp-head"><h2>长尾 · ' + lastFold.tailPages.length + ' 页</h2></div><div class="insp-chips">'
      + '<span class="chip" style="border-color:' + (c.border || '#8a95a5') + ';color:' + (c.border || '#8a95a5') + '">' + esc(tailName(lastFold.cluster)) + '</span>'
      + '<span class="chip">入度排名 ' + (RANKFOLD_LIMIT + 1) + ' 之后</span></div>'
      + '<h4 class="sec">长尾页面（按入度，前 80）</h4>' + linkList(items, 80)
      + '<p class="more-line">搜索任意路径可直接定位（自动置入热门图并选中）</p>');
  }
  function setView(v) {
    state.view = v;
    syncSeg(v);
    if (v === 'data') {
      el.dataView.hidden = false; el.cy.style.display = 'none'; el.labels.innerHTML = '';
      el.legend.hidden = true; el.canvasControls.hidden = true;
      hideScopePanel();
      el.breadcrumb.hidden = true;
      renderDataTab();
      if (cy) { try { cy.destroy(); } catch { /* ignore */ } cy = null; }
      return;
    }
    showCanvas();
    renderGraph();
    syncCrumb();
  }
  // scope 变更统一入口：pin 为热门图强制置入并选中的页面（搜索定位长尾页）
  function setScope(s, pin) {
    state.scope = normScope(s);
    const pp = pin && byPath.get(pin);
    state.pin = pp ? pp.path : null;
    renderClusterList();
    if (state.view !== 'page') { state.view = 'page'; syncSeg('page'); }
    showCanvas();
    renderGraph();
    syncCrumb();
  }
  function syncCrumb() {
    const sc = normScope(state.scope);
    el.breadcrumb.hidden = !sc;
    if (!sc) { el.crumbText.textContent = '页面视图 · 全站'; return; }
    const c = clusterMap.get(sc.cluster);
    if (!c) { el.breadcrumb.hidden = true; return; }
    if (bigSite && c.pages.length > FOCUS_MEMBER_LIMIT) {
      const sk = clusterSkeleton(sc.cluster);
      if (sc.group === TAIL) {
        el.crumbText.textContent = tailName(sc.cluster) + ' / 长尾组 · ' + (sk.foldedMembers.length + sk.unlinked.length) + ' 页';
      } else if (sc.group) {
        const g = sk.byKey.get(sc.group);
        el.crumbText.textContent = tailName(sc.cluster) + ' / ' + shortLabel(sc.group) + ' · ' + (g ? g.members.length : 0) + ' 页 + 来源类目页';
      } else if (sc.hot || !sk.usable) {
        el.crumbText.textContent = tailName(sc.cluster) + ' · 热门 Top ' + RANKFOLD_LIMIT + ' + 长尾聚合';
      } else {
        el.crumbText.textContent = tailName(sc.cluster) + ' · ' + c.pages.length + ' 页 · 类目目录';
      }
      return;
    }
    const sp = bigSite ? srcPanel(sc.cluster) : null;
    if (sp) {
      el.crumbText.textContent = sc.hot
        ? tailName(sc.cluster) + ' · 集群页面图 · ' + c.pages.length + ' 页'
        : tailName(sc.cluster) + ' · 类目目录 · ' + sp.groups.length + ' 组 → '
          + sp.groups.reduce((s, g) => s + g.members.length, 0) + ' 页';
      return;
    }
    const capNote = c.pages.length > FOCUS_MEMBER_LIMIT ? '，按入度截取前 ' + FOCUS_MEMBER_LIMIT : '';
    el.crumbText.textContent = '集群聚焦 · ' + tailName(sc.cluster) + '（' + c.pages.length + ' 页' + capNote + ' + 外部关联页）';
  }

  /* ================= 详情面板 ================= */
  function closeInspector() { el.insp.hidden = true; el.stage.classList.remove('insp-open'); }
  function openInspector(html) {
    el.inspBody.innerHTML = html; el.insp.hidden = false; el.insp.scrollTop = 0;
    el.stage.classList.add('insp-open'); // 面板盖住右下角时把控制条左移
  }

  function linkList(items, cap) {
    cap = cap || 60;
    if (!items.length) return '<p class="empty">（无）</p>';
    let html = '<ul class="lnk-list">';
    items.slice(0, cap).forEach((it) => {
      const p = byPath.get(it.path);
      const cl = p ? clusterMap.get(p.cluster) : null;
      const ratio = p ? Math.max(0.06, p.inDegree / maxIn) : 0.06;
      html += '<li data-goto="' + esc(it.path) + '" title="' + esc(it.path) + '">'
        + '<span class="bar" style="width:' + Math.round(ratio * 100) + '%;background:' + (cl ? cl.color : '#999') + '"></span>'
        + '<span class="dot" style="background:' + (cl ? cl.color : '#999') + '"></span>'
        + '<span class="p">' + esc(it.path) + '</span>'
        + (it.extra ? '<span class="pill">' + esc(it.extra) + '</span>' : '') + '</li>';
    });
    html += '</ul>';
    if (items.length > cap) html += '<p class="more-line">…还有 ' + (items.length - cap) + ' 条未显示</p>';
    return html;
  }

  function showPage(path) {
    const p = byPath.get(path); if (!p) return;
    const outs = []; const ins = [];
    for (const e of allEdges) {
      if (!state.chrome && e.chrome) continue;
      if (e.from === path) outs.push({ path: e.to, extra: e.count > 1 ? '×' + e.count : '' });
      if (e.to === path) ins.push({ path: e.from, extra: e.count > 1 ? '×' + e.count : '' });
    }
    const c = clusterMap.get(p.cluster) || {};
    const ga = groupAnchorOf(path);
    let html = '<div class="insp-head"><h2>' + esc(path) + '</h2></div><div class="insp-chips">'
      + '<span class="chip" style="border-color:' + c.border + ';color:' + c.border + '">' + esc(p.cluster) + '</span>'
      + (orphanSet.has(path) ? '<span class="chip warn">孤儿页</span>' : '')
      + (p.inSitemap ? '' : '<span class="chip warn">不在 sitemap</span>')
      + '</div>'
      + '<div class="mrow"><div class="m"><b>' + p.inDegree + '</b><span>入度</span></div><div class="m"><b>' + p.outDegree + '</b><span>出度</span></div></div>'
      + '<div class="insp-actions"><a class="btn primary" href="' + esc(urlOf(path)) + '" target="_blank" rel="noopener">打开原页面 ↗</a>'
      + (ga ? '<button class="btn" data-act="group" data-arg="' + esc(path) + '">查看其类目组 · ' + ga.size + ' 页</button>' : '')
      + '</div>'
      + '<h4 class="sec">出链 ' + outs.length + '</h4>' + linkList(outs)
      + '<h4 class="sec">入链 ' + ins.length + '</h4>' + linkList(ins);
    openInspector(html);
  }

  function showCluster(name) {
    const c = clusterMap.get(name); if (!c) return;
    let html = '<div class="insp-head"><h2>' + esc(tailName(name)) + '</h2></div><div class="insp-chips">'
      + '<span class="chip" style="border-color:' + c.border + ';color:' + c.border + '">' + c.pages.length + ' 页</span>'
      + (name === TAIL ? '<span class="chip">' + tailInfo.members.length + ' 个小集群</span>' : '') + '</div>'
      + '<div class="mrow"><div class="m"><b>' + c.internal + '</b><span>内部链接</span></div><div class="m"><b>' + sum(c.out) + '</b><span>出向跨集群</span></div><div class="m"><b>' + sum(c.in) + '</b><span>入向跨集群</span></div></div>'
      + '<div class="insp-actions">'
      + '<button class="btn primary" data-act="scope" data-arg="' + esc(name) + '">'
      + (scopePanelInfo({ cluster: name, group: null, hot: false }) ? '浏览类目目录' : '聚焦集群子图') + '</button>'
      + '<button class="btn" data-act="locate" data-arg="' + esc(name) + '">到集群视图总览</button></div>';
    if (name === TAIL) {
      html += '<h4 class="sec">包含的小集群 ' + tailInfo.members.length + '</h4><ul class="lnk-list">';
      tailInfo.members.slice(0, 80).forEach((m) => {
        html += '<li class="cl" data-cluster="' + esc(m.name) + '" title="' + esc(m.name) + '">'
          + '<span class="dot" style="background:' + m.color + '"></span><span class="p">' + esc(m.name) + '</span>'
          + '<span class="pill">' + m.pages.length + ' 页</span></li>';
      });
      html += '</ul>';
      if (tailInfo.members.length > 80) html += '<p class="more-line">…还有 ' + (tailInfo.members.length - 80) + ' 个未显示（侧栏集群列表可搜索定位）</p>';
    }
    const top = c.pages.slice().sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path)).slice(0, 8);
    html += '<h4 class="sec">主要页面（按入度）</h4><ul class="lnk-list">';
    top.forEach((p) => {
      html += '<li data-goto="' + esc(p.path) + '" title="' + esc(p.path) + '">'
        + '<span class="bar" style="width:' + Math.round(Math.max(0.06, p.inDegree / maxIn) * 100) + '%;background:' + c.color + '"></span>'
        + '<span class="p">' + esc(p.path) + '</span><span class="pill">入度 ' + p.inDegree + '</span></li>';
    });
    html += '</ul>';
    const rows = (m, title) => {
      if (!m.size) return '';
      const maxC = Math.max(1, ...m.values());
      let h = '<h4 class="sec">' + title + '</h4><ul class="lnk-list">';
      [...m.entries()].sort((a, b) => b[1] - a[1]).forEach(([n, cnt]) => {
        h += '<li class="cl" data-cluster="' + esc(n) + '">'
          + '<span class="bar" style="width:' + Math.round(Math.max(0.08, cnt / maxC) * 100) + '%;background:' + clusterColor(n) + '"></span>'
          + '<span class="dot" style="background:' + clusterColor(n) + '"></span><span class="p">' + esc(n) + '</span><span class="pill">' + cnt + '</span></li>';
      });
      return h + '</ul>';
    };
    html += rows(c.out, '出向跨集群') + rows(c.in, '入向跨集群');
    openInspector(html);
  }

  el.inspBody.addEventListener('click', (ev) => {
    const t = ev.target;
    const li = t.closest && t.closest('li[data-goto]');
    if (li) return focusPage(li.getAttribute('data-goto'));
    const cl = t.closest && t.closest('[data-cluster]');
    if (cl) return focusCluster(cl.getAttribute('data-cluster'));
    const act = t.closest && t.closest('[data-act]');
    if (!act) return;
    const arg = act.getAttribute('data-arg');
    if (act.getAttribute('data-act') === 'scope') setScope(arg);
    else if (act.getAttribute('data-act') === 'group') {
      const ga = groupAnchorOf(arg);
      if (ga) setScope({ cluster: ga.cluster, group: arg });
    }
    else locateInClusterView(arg);
  });

  /* ================= 定位 ================= */
  function focusPage(path) {
    const p = byPath.get(path);
    if (!p) { if (path === TAIL) showFold(); return; }
    if (bigSite) {
      // 大站路由：当前图已有 → 所在类目组 → 热门图（pin 置入）；引导态/目录面板同样直达
      let node = cy && cy.getElementById('p:' + path);
      if (node && node.length > 0) {
        state.pin = null; // 已在当前图中：旧 pin 失去意义，避免下次重渲染带入无关页
      } else {
        const cObj = clusterMap.get(p.cluster);
        if (!cObj || cObj.pages.length <= FOCUS_MEMBER_LIMIT) {
          // 小集群页：类目来源页直达其组图（与节点双击/目录 chip 同一目的地）；
          // 有来源目录的集群其余页进「集群页面图」定位（回退方向=该集群目录），无目录的照旧聚焦
          const ga = groupAnchorOf(path);
          if (ga) setScope({ cluster: ga.cluster, group: path });
          else if (srcPanel(p.cluster)) setScope({ cluster: p.cluster, hot: true });
          else setScope(p.cluster);
        } else {
          const sk = clusterSkeleton(p.cluster);
          const gk = sk.groupOf.get(path);
          if (gk && sk.byKey.has(gk)) setScope({ cluster: p.cluster, group: gk });
          else setScope({ cluster: p.cluster, hot: true }, path); // 枢纽/长尾/未挂靠 → 热门图置入
        }
        node = cy && cy.getElementById('p:' + path);
      }
      if (!node || node.length === 0) return showPage(path); // 兜底：至少给详情面板
      clearSelection();
      node.select();
      return;
    }
    // 小站：全站图存在，直接定位；集群聚焦下缺失则先回全站
    if (state.view !== 'page') setScope(null);
    let node = cy && cy.getElementById('p:' + path);
    if ((!node || node.length === 0) && state.scope) { setScope(null); node = cy && cy.getElementById('p:' + path); }
    if (!node || node.length === 0) return showPage(path);
    clearSelection();
    node.select();
    // 定位到可读级别（≥1.15 时普通页面短名也已浮现）
    cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1.15) }, { duration: 350 });
  }
  // 强制切到集群视图并选中卡片（详情面板「到集群视图总览」用，不走大站下钻路由）
  function locateInClusterView(name) {
    if (state.view !== 'cluster' || state.scope) {
      state.scope = null; state.pin = null; state.view = 'cluster'; syncSeg('cluster');
      showCanvas(); renderGraph(); renderClusterList();
    }
    const node = cy && cy.getElementById('c:' + name);
    if (!node || node.length === 0) return showCluster(name);
    clearSelection();
    node.select();
    cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 0.8) }, { duration: 350 });
  }
  function focusCluster(name) {
    // 页面视图里点集群：直接定位该集群分组框，不打断当前视图
    if (state.view === 'page') {
      if (bigSite) return setScope(name); // 大站：页面视图即聚焦视图
      if (state.scope) setScope(null);
      const g = cy && cy.getElementById('g:' + name);
      if (g && g.length) {
        clearSelection();
        g.select();
        showCluster(name);
        cy.animate({ center: { eles: g }, zoom: Math.max(cy.zoom(), 0.5) }, { duration: 350 });
        return;
      }
    }
    locateInClusterView(name);
  }

  /* ================= 搜索 ================= */
  let searchRows = []; let activeRow = -1;
  function runSearch(q) {
    q = q.trim().toLowerCase();
    if (!q) { searchRows = []; return; }
    const out = [];
    for (const c of clusterList) if (c.name.toLowerCase().includes(q)) out.push({ type: 'cluster', key: c.name });
    for (const p of pages) if (p.path.toLowerCase().includes(q)) out.push({ type: 'page', key: p.path });
    searchRows = out.slice(0, 14);
  }
  function renderDrop() {
    if (!searchRows.length) {
      el.searchDrop.innerHTML = el.search.value.trim() ? '<div class="sr-empty">没有匹配的页面或集群</div>' : '';
      el.searchDrop.hidden = !el.search.value.trim();
      return;
    }
    activeRow = Math.min(Math.max(activeRow, 0), searchRows.length - 1);
    let html = '';
    searchRows.forEach((r, i) => {
      const dot = '<span class="dot" style="background:' + (r.type === 'cluster' ? clusterColor(r.key) : clusterColor(byPath.get(r.key) ? byPath.get(r.key).cluster : '')) + '"></span>';
      const tag = r.type === 'cluster' ? '<span class="tag">集群</span>' : '<span class="tag">' + esc(r.key.split('/').filter(Boolean).slice(0, 1).join('/') || 'root') + '</span>';
      html += '<div class="sr ' + (i === activeRow ? 'active' : '') + '" data-i="' + i + '">' + dot + '<span class="p">' + esc(r.key) + '</span>' + tag + '</div>';
    });
    el.searchDrop.innerHTML = html;
    el.searchDrop.hidden = false;
  }
  function hideDrop() { el.searchDrop.hidden = true; activeRow = -1; }
  function pickRow(i) {
    const r = searchRows[i];
    if (!r) return;
    el.search.value = ''; hideDrop(); el.search.blur();
    if (r.type === 'cluster') focusCluster(r.key); else focusPage(r.key);
  }
  el.search.addEventListener('input', () => { activeRow = -1; runSearch(el.search.value); renderDrop(); });
  el.search.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); activeRow = Math.min(activeRow + 1, searchRows.length - 1); renderDrop(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); activeRow = Math.max(activeRow - 1, 0); renderDrop(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); pickRow(activeRow >= 0 ? activeRow : 0); }
    else if (ev.key === 'Escape') { el.search.value = ''; hideDrop(); el.search.blur(); }
  });
  el.searchDrop.addEventListener('click', (ev) => {
    const row = ev.target.closest && ev.target.closest('.sr');
    if (row) pickRow(Number(row.getAttribute('data-i')));
  });
  document.addEventListener('click', (ev) => {
    if (!el.searchDrop.hidden && !el.searchDrop.contains(ev.target) && ev.target !== el.search) hideDrop();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === '/' && document.activeElement !== el.search) { ev.preventDefault(); el.search.focus(); }
    else if (ev.key === 'Escape' && document.activeElement !== el.search) {
      if (!exMenu.hidden) setExportMenu(false);
      else { closeInspector(); clearSelection(); }
    }
  });

  /* ================= 过滤器（画布控制条） ================= */
  el.chromeToggle.addEventListener('change', () => {
    state.chrome = el.chromeToggle.checked;
    if (state.view !== 'data') renderGraph();
  });
  el.minCountSel.addEventListener('change', () => {
    state.minCount = Number(el.minCountSel.value) || 1;
    if (state.view !== 'data') renderGraph();
  });

  /* ================= 侧栏 ================= */
  function renderStats() {
    $('#stat-pages').textContent = pages.length;
    $('#stat-edges').textContent = contentEdgeCount;
    $('#stat-clusters').textContent = clusterList.length;
    const orphansEl = $('#stat-orphans');
    orphansEl.textContent = orphans.length;
    orphansEl.classList.toggle('good', orphans.length === 0);
  }
  function renderClusterList() {
    const box = $('#cl-list');
    box.innerHTML = clusterList.map((c) => {
      const w = Math.max(6, Math.round((c.pages.length / maxPages) * 100));
      return '<div class="cl-row' + (state.scope && state.scope.cluster === c.name ? ' active' : '') + '" data-cluster="' + esc(c.name) + '">'
        + '<span class="dot" style="background:' + c.color + '"></span>'
        + '<span class="nwrap"><span class="ntop"><span class="n">' + esc(c.name) + '</span></span>'
        + '<span class="bar"><i style="width:' + w + '%;background:' + c.color + '"></i></span></span>'
        + '<span class="nums"><span class="np">' + c.pages.length + '<i>页</i></span>'
        + '<span class="nx">↗ ' + sum(c.out) + ' · ↘ ' + sum(c.in) + '</span></span></div>';
    }).join('');
  }
  // 问题分级色：孤儿页 = 琥珀，零出链 = 石板灰，抓取失败 = 红
  const ISSUE_TONE = { orphan: '#e8a23d', zero: '#93a1b5', fail: '#c2453e' };
  const issueItems = (list, cap, asLink, tone) => {
    if (!list.length) return '<p class="empty">（无）</p>';
    let html = '';
    list.slice(0, cap).forEach((p) => {
      if (asLink) {
        html += '<div class="issue-item"><span class="dot" style="background:' + tone + '"></span><a class="p" href="' + esc(p.url) + '" target="_blank" rel="noopener" title="' + esc(p.url) + '">' + esc(p.url) + '</a><span class="tag">' + esc(p.error || '') + '</span></div>';
      } else {
        html += '<div class="issue-item" data-goto="' + esc(p) + '"><span class="dot" style="background:' + tone + '"></span><span class="p" title="' + esc(p) + '">' + esc(p) + '</span></div>';
      }
    });
    if (list.length > cap) html += '<p class="more-hint">…还有 ' + (list.length - cap) + ' 条</p>';
    return html;
  };
  function renderIssues() {
    $('#issue-orphans').innerHTML = issueItems(orphans, 30, false, ISSUE_TONE.orphan);
    $('#issue-zeroout').innerHTML = issueItems(zeroOut, 30, false, ISSUE_TONE.zero);
    $('#issue-failures').innerHTML = issueItems(failures, 30, true, ISSUE_TONE.fail);
  }
  el.sidebar.addEventListener('click', (ev) => {
    const t = ev.target;
    const goto = t.closest && t.closest('[data-goto]');
    if (goto) return focusPage(goto.getAttribute('data-goto'));
    const c = t.closest && t.closest('.cl-row');
    if (c) return focusCluster(c.getAttribute('data-cluster'));
    const s = t.closest && t.closest('#stat-orphans-wrap');
    if (s) { syncSeg('data'); setView('data'); }
  });
  // 侧栏集群悬停 ↔ 画布联动：高亮对应分组框（页面视图）或卡片（集群视图）
  let spotName = null;
  el.sidebar.addEventListener('mouseover', (ev) => {
    const row = ev.target.closest && ev.target.closest('.cl-row');
    const name = row ? row.getAttribute('data-cluster') : null;
    if (name === spotName) return;
    spotName = name;
    if (!cy) return;
    cy.nodes('.spot').removeClass('spot');
    if (!name) return;
    let g = cy.getElementById('g:' + name);
    if (!g.nonempty()) g = cy.getElementById('c:' + name);
    if (g.nonempty()) g.addClass('spot');
  });
  el.sidebar.addEventListener('mouseleave', () => {
    spotName = null;
    if (cy) cy.nodes('.spot').removeClass('spot');
  });

  /* ================= 数据视图 ================= */
  function renderDataTab() {
    if (el.dataView.dataset.done) return;
    const tbl = (headers, rows) => {
      if (!rows.length) return '<p class="empty">（无）</p>';
      return '<table><thead><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    };
    const a = (p) => '<a href="' + esc(urlOf(p)) + '" target="_blank" rel="noopener">' + esc(p) + '</a>';
    el.dataView.innerHTML = '<div class="cols">'
      + '<div class="card"><h2>入度 Top（非导航入边）</h2>' + tbl(['页面', '入度'], (T.topInDegree || []).map((n) => [a(n.path), n.inDegree])) + '</div>'
      + '<div class="card"><h2>跨集群内容边</h2>' + tbl(['源集群', '目标集群', '次数'], (T.crossClusterEdges || []).map((e) => [esc(e.from), esc(e.to), e.count])) + '</div>'
      + '<div class="card"><h2>孤儿页（无非导航入边）</h2>' + tbl(['页面', ''], orphans.map((p) => [a(p), '—'])) + '</div>'
      + '<div class="card"><h2>零出链页面</h2>' + tbl(['页面', ''], zeroOut.map((p) => [a(p), '—'])) + '</div>'
      + '<div class="card"><h2>抓取失败</h2>' + tbl(['URL', '错误'], failures.map((f) => ['<a href="' + esc(f.url) + '" target="_blank" rel="noopener">' + esc(f.url) + '</a>', esc(f.error)])) + '</div>'
      + '</div>';
    el.dataView.dataset.done = '1';
  }

  /* ================= 导出 =================
     图像：合成卡片 = 画布位图 + 双尺度点阵背景 + 覆盖层标注重绘（HTML 层不进位图）+ 署名页脚。
     数据：CSV（UTF-8 BOM，Excel 直开）、原始 JSON（与 topology.json 一致），
     图分析格式：GEXF（Gephi）/ GraphML（Cytoscape、yEd、NetworkX）。 */
  const SANS = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif';
  const EXPORT_HOST = (() => { try { return new URL(BASE).hostname.replace(/^www\./, '') || 'site'; } catch { return 'site'; } })();
  const EXPORT_DATE = new Date().toISOString().slice(0, 10);
  const fileBase = () => 'link-topology-' + EXPORT_HOST + '-' + EXPORT_DATE;

  const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const toCSV = (headers, rows) => '\ufeff' + [headers.join(',')].concat(rows.map((r) => r.map(csvCell).join(','))).join('\r\n') + '\r\n';
  function buildPagesCSV() {
    const rows = pages.slice()
      .sort((a, b) => a.cluster.localeCompare(b.cluster) || b.inDegree - a.inDegree || a.path.localeCompare(b.path))
      .map((p) => [p.path, p.cluster, p.inDegree, p.outDegree, p.inSitemap ? 'yes' : 'no', orphanSet.has(p.path) ? 'yes' : 'no', p.outDegree === 0 ? 'yes' : 'no']);
    return toCSV(['path', 'cluster', 'inDegree', 'outDegree', 'inSitemap', 'orphan', 'zeroOut'], rows);
  }
  function buildEdgesCSV() {
    const rows = allEdges.slice()
      .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
      .map((e) => [e.from, e.to, e.count, e.chrome ? 'navigation' : 'content']);
    return toCSV(['from', 'to', 'count', 'type'], rows);
  }
  function buildClustersCSV() {
    const rows = clusterList.map((c) => [c.name, c.pages.length, c.internal, sum(c.out), sum(c.in)]);
    return toCSV(['cluster', 'pages', 'internalLinks', 'crossClusterOut', 'crossClusterIn'], rows);
  }

  // 图分析标准格式：GEXF（Gephi 原生）/ GraphML（Cytoscape、yEd、NetworkX 通用）。
  // 节点带集群 / 度数属性与集群配色（GEXF viz），边带链接次数与内容 / 导航类型——导入即可继续做图分析
  const xmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const hexRGB = (h) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
    if (!m) return null;
    const v = parseInt(m[1], 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
  };
  const graphNodes = () => pages.slice()
    .sort((a, b) => a.cluster.localeCompare(b.cluster) || b.inDegree - a.inDegree || a.path.localeCompare(b.path));
  function buildGEXF() {
    const ns = graphNodes();
    const idOf = new Map(ns.map((p, i) => [p.path, 'n' + i]));
    const maxIn = ns.reduce((m, p) => Math.max(m, p.inDegree), 1);
    const parts = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gexf xmlns="http://gexf.net/1.3" xmlns:viz="http://gexf.net/1.3/viz" version="1.3">',
      '<meta lastmodifieddate="' + EXPORT_DATE + '"><creator>Link Topology Explorer</creator>'
        + '<description>Internal link graph for ' + xmlEsc(EXPORT_HOST) + '</description></meta>',
      '<graph defaultedgetype="directed">',
      '<attributes class="node">',
      '<attribute id="cluster" title="cluster" type="string"/>',
      '<attribute id="inDegree" title="inDegree" type="int"/>',
      '<attribute id="outDegree" title="outDegree" type="int"/>',
      '<attribute id="inSitemap" title="inSitemap" type="boolean"/>',
      '</attributes>',
      '<attributes class="edge">',
      '<attribute id="count" title="count" type="int"/>',
      '<attribute id="etype" title="type" type="string"/>',
      '</attributes>',
      '<nodes>'];
    for (const p of ns) {
      const rgb = hexRGB((clusterMap.get(p.cluster) || {}).color);
      parts.push('<node id="' + idOf.get(p.path) + '" label="' + xmlEsc(p.path) + '">'
        + '<attvalues><attvalue for="cluster" value="' + xmlEsc(p.cluster) + '"/>'
        + '<attvalue for="inDegree" value="' + p.inDegree + '"/>'
        + '<attvalue for="outDegree" value="' + p.outDegree + '"/>'
        + '<attvalue for="inSitemap" value="' + (p.inSitemap ? 'true' : 'false') + '"/></attvalues>'
        + (rgb ? '<viz:color r="' + rgb.r + '" g="' + rgb.g + '" b="' + rgb.b + '"/>' : '')
        + '<viz:size value="' + (10 + 30 * (p.inDegree / maxIn)).toFixed(1) + '"/></node>');
    }
    parts.push('</nodes>');
    parts.push('<edges>');
    allEdges.forEach((e, i) => {
      parts.push('<edge id="e' + i + '" source="' + idOf.get(e.from) + '" target="' + idOf.get(e.to) + '" weight="' + e.count + '">'
        + '<attvalues><attvalue for="count" value="' + e.count + '"/>'
        + '<attvalue for="etype" value="' + (e.chrome ? 'navigation' : 'content') + '"/></attvalues></edge>');
    });
    parts.push('</edges></graph></gexf>');
    return parts.join('\n');
  }
  function buildGraphML() {
    const ns = graphNodes();
    const idOf = new Map(ns.map((p, i) => [p.path, 'n' + i]));
    const parts = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<graphml xmlns="http://graphml.graphdrawing.org/xmlns"',
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
      ' xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">',
      '<key id="cluster" for="node" attr.name="cluster" attr.type="string"/>',
      '<key id="inDegree" for="node" attr.name="inDegree" attr.type="int"/>',
      '<key id="outDegree" for="node" attr.name="outDegree" attr.type="int"/>',
      '<key id="inSitemap" for="node" attr.name="inSitemap" attr.type="boolean"/>',
      '<key id="count" for="edge" attr.name="count" attr.type="int"/>',
      '<key id="etype" for="edge" attr.name="type" attr.type="string"/>',
      '<graph id="G" edgedefault="directed">'];
    for (const p of ns) {
      parts.push('<node id="' + idOf.get(p.path) + '"><data key="cluster">' + xmlEsc(p.cluster) + '</data>'
        + '<data key="inDegree">' + p.inDegree + '</data><data key="outDegree">' + p.outDegree + '</data>'
        + '<data key="inSitemap">' + (p.inSitemap ? 'true' : 'false') + '</data></node>');
    }
    allEdges.forEach((e, i) => {
      parts.push('<edge id="e' + i + '" source="' + idOf.get(e.from) + '" target="' + idOf.get(e.to) + '">'
        + '<data key="count">' + e.count + '</data><data key="etype">' + (e.chrome ? 'navigation' : 'content') + '</data></edge>');
    });
    parts.push('</graph></graphml>');
    return parts.join('\n');
  }

  function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    $('#toast-text').textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }
  function saveText(text, name, mime) {
    download(name, new Blob([text], { type: mime + ';charset=utf-8' }));
    toast('已导出 ' + name);
  }

  async function cyPngBlob(opts) {
    let out = null;
    try { out = cy.png(Object.assign({ output: 'blob-promise' }, opts)); } catch { out = null; }
    if (out && typeof out.then === 'function') { try { out = await out; } catch { out = null; } }
    if (out instanceof Blob) return out;
    let b64 = '';
    try { b64 = String(cy.png(Object.assign({ output: 'base64' }, opts))); } catch { throw new Error('canvas 渲染失败'); }
    const bin = atob(b64.split(',')[1] || '');
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: 'image/png' });
  }
  async function blobToImage(blob) {
    if (window.createImageBitmap) { try { return await createImageBitmap(blob); } catch { /* 回退 <img> */ } }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }

  function pathRound(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function fitText(ctx, text, maxW) {
    if (maxW <= 0) return '';
    if (ctx.measureText(text).width <= maxW) return text;
    let t = String(text);
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }
  // 与 #cy 的 CSS 点阵同一参数（22px 细点 / 110px 主点），按导出倍率重绘
  function paintDots(ctx, x, y, w, h, s) {
    const minor = 22 * s; const major = 110 * s; const r = Math.max(1, 1.05 * s);
    ctx.fillStyle = '#dbe2ec';
    for (let gx = x + minor / 2; gx < x + w; gx += minor) {
      for (let gy = y + minor / 2; gy < y + h; gy += minor) ctx.fillRect(gx - r, gy - r, r * 2, r * 2);
    }
    ctx.fillStyle = '#c8d2e0';
    const r2 = r * 1.15;
    for (let gx = x + major / 2; gx < x + w; gx += major) {
      for (let gy = y + major / 2; gy < y + h; gy += major) ctx.fillRect(gx - r2, gy - r2, r2 * 2, r2 * 2);
    }
  }
  function drawFooterMark(ctx, cx, cy, fh) {
    const u = fh * 0.16;
    ctx.lineWidth = Math.max(1, u * 0.42); ctx.strokeStyle = '#9aa6b8'; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - u * 0.5, cy - u * 0.3); ctx.lineTo(cx + u * 0.55, cy - u * 0.85);
    ctx.moveTo(cx - u * 0.5, cy + u * 0.3); ctx.lineTo(cx + u * 0.55, cy + u * 0.85);
    ctx.stroke();
    ctx.fillStyle = '#3465d4'; ctx.beginPath(); ctx.arc(cx - u, cy, u * 0.72, 0, 6.3); ctx.fill();
    ctx.fillStyle = '#e8590c'; ctx.beginPath(); ctx.arc(cx + u * 0.8, cy - u * 0.95, u * 0.55, 0, 6.3); ctx.fill();
    ctx.fillStyle = '#12b886'; ctx.beginPath(); ctx.arc(cx + u * 0.8, cy + u * 0.95, u * 0.55, 0, 6.3); ctx.fill();
  }
  function viewLabel() {
    if (state.view === 'cluster') return '集群视图';
    const sc = normScope(state.scope);
    if (!sc) return '页面视图';
    const c = clusterMap.get(sc.cluster) || {};
    if (bigSite && c.pages && c.pages.length > FOCUS_MEMBER_LIMIT) {
      if (sc.group === TAIL) return '页面视图 · ' + sc.cluster + ' / 长尾组';
      if (sc.group) return '页面视图 · ' + sc.cluster + ' / ' + shortLabel(sc.group);
      if (sc.hot || !clusterSkeleton(sc.cluster).usable) return '页面视图 · ' + sc.cluster + ' / 热门';
      return '页面视图 · ' + sc.cluster + ' 类目目录';
    }
    if (bigSite && srcPanel(sc.cluster)) {
      return sc.hot ? '页面视图 · ' + sc.cluster + ' / 集群页面图' : '页面视图 · ' + sc.cluster + ' 类目目录';
    }
    return '页面视图 · 聚焦 ' + sc.cluster;
  }
  // 读取当前 HTML 覆盖层（集群标题胶囊 / 头部页名胶囊）的视觉矩形与文字——它们不会出现在画布位图里
  function overlaySpec() {
    const base = el.cy.getBoundingClientRect();
    const items = [];
    for (const node of el.labels.children) {
      const r = node.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const first = node.childNodes[0];
      items.push({
        chip: node.classList.contains('hub-chip'),
        mini: node.classList.contains('mini'),
        x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height,
        color: node.style.color || '#5f6a7a',
        main: first && first.nodeType === 3 ? first.textContent : (node.textContent || ''),
        suffix: node.querySelector('.n') ? node.querySelector('.n').textContent : '',
      });
    }
    return items;
  }
  function paintOverlay(ctx, items, s, pad, project) {
    ctx.textBaseline = 'middle';
    for (const it of items) {
      const w = it.w * s; const h = it.h * s;
      const c = project(it.x + it.w / 2, it.y + it.h / 2);
      const x = pad + c.x - w / 2; const y = pad + c.y - h / 2;
      pathRound(ctx, x, y, w, h, (it.chip ? 6 : 7) * s);
      ctx.lineWidth = Math.max(1, s);
      if (it.chip) {
        ctx.fillStyle = 'rgba(22, 32, 46, .86)'; ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, .18)'; ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = '600 ' + 10 * s + 'px ' + SANS;
        ctx.textAlign = 'center';
        ctx.fillText(fitText(ctx, it.main, w - 14 * s), x + w / 2, y + h / 2 + 0.5 * s);
        continue;
      }
      ctx.fillStyle = 'rgba(255, 255, 255, .94)'; ctx.fill();
      ctx.strokeStyle = 'rgba(20, 31, 47, .08)'; ctx.stroke();
      ctx.save();
      pathRound(ctx, x, y, w, h, 7 * s); ctx.clip();
      ctx.fillStyle = it.color;
      ctx.fillRect(x, y, 3 * s, h); // 左侧集群色条（与 .g-label border-left 同语言）
      ctx.restore();
      ctx.font = '650 ' + (it.mini ? 9.5 : 11) * s + 'px ' + SANS;
      ctx.fillStyle = it.color;
      ctx.textAlign = 'left';
      const padL = (it.mini ? 7 : 9) * s;
      const mainTxt = fitText(ctx, it.main, w - padL * 2 - (it.suffix ? 34 * s : 0));
      ctx.fillText(mainTxt, x + padL, y + h / 2 + 0.5 * s);
      if (it.suffix) {
        const mainW = ctx.measureText(mainTxt).width;
        ctx.font = '550 ' + 10 * s + 'px ' + SANS;
        ctx.fillStyle = '#7a8699';
        const sufTxt = fitText(ctx, it.suffix, Math.max(0, x + w - 7 * s - (x + padL + mainW + 6 * s)));
        ctx.fillText(sufTxt, x + padL + mainW + 6 * s, y + h / 2 + 0.5 * s);
      }
    }
  }

  async function exportPNG(full) {
    if (!cy) { toast('请先切换到「集群」或「页面」视图'); return null; }
    const prevZoom = cy.zoom(); const prevPan = cy.pan();
    const dpr = Math.max(1, window.devicePixelRatio || 1); // cy.png 输出 = 视口 × scale × dpr
    let bb = null; let scale = 2; let fitPan = null; let fitZoom = 1;
    if (full) {
      cy.fit(56);
      await new Promise((r) => setTimeout(r, 140)); // 等 fit 后覆盖层按新视口重建
      fitZoom = cy.zoom(); fitPan = cy.pan();
      bb = cy.elements().boundingBox();
      // 分辨率自适应：目标位图不超过 8192px 边 / 约 24M 像素面积（scale 除回 dpr 抵消内部倍率）
      const eff = Math.min(1.6, 8192 / Math.max(bb.w, bb.h, 1), Math.sqrt(24e6 / Math.max(1, bb.w * bb.h)));
      scale = Math.max(0.2, eff / dpr);
    }
    const px = scale * dpr; // CSS 像素 → 位图像素的真实倍率（点阵/覆盖层重绘都用它）
    const items = overlaySpec();
    let blob = null; let err = null;
    try { blob = await cyPngBlob({ full: !!full, scale }); }
    catch (e) { err = e; }
    if (full) { cy.zoom(prevZoom); cy.pan(prevPan); }
    if (!blob) { toast('图像导出失败' + (err && err.message ? '：' + err.message : '')); return null; }
    const img = await blobToImage(blob);
    const iw = img.width; const ih = img.height;
    const pad = full ? 34 : 14;
    const fh = Math.max(46, Math.min(84, Math.round(iw * 0.032)));
    const W = iw + pad * 2; const H = ih + pad * 2 + fh;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.save();
    pathRound(ctx, 0.5, 0.5, W - 1, H - 1, 16); ctx.clip();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#f6f8fb'; ctx.fillRect(pad, pad, iw, ih);
    paintDots(ctx, pad, pad, iw, ih, px);
    ctx.drawImage(img, pad, pad);
    if (items.length) {
      ctx.save();
      ctx.beginPath(); ctx.rect(pad, pad, iw, ih); ctx.clip();
      // 视图导出：视口坐标 × px；整图导出：经 fit 时的 pan/zoom 换算成模型坐标，再映射进全图位图
      const project = full
        ? (vx, vy) => ({ x: ((vx - fitPan.x) / fitZoom - bb.x1) * px, y: ((vy - fitPan.y) / fitZoom - bb.y1) * px })
        : (vx, vy) => ({ x: vx * px, y: vy * px });
      paintOverlay(ctx, items, px, pad, project);
      ctx.restore();
    }
    const fy = pad + ih; // 署名页脚
    ctx.strokeStyle = '#e6eaf1'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad, fy + 0.5); ctx.lineTo(W - pad, fy + 0.5); ctx.stroke();
    const fs = Math.max(11, Math.round(fh * 0.27));
    const markC = pad + 16 + fh * 0.3; const midY = fy + fh / 2;
    drawFooterMark(ctx, markC, midY, fh);
    const titleX = markC + fh * 0.44 + 12;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = '650 ' + (fs + 1) + 'px ' + SANS;
    ctx.fillStyle = '#1c2b3a';
    const title = 'Link Topology Explorer';
    ctx.fillText(title, titleX, midY + 1);
    const titleW = ctx.measureText(title).width;
    ctx.font = '550 ' + fs + 'px ' + SANS; ctx.fillStyle = '#8a95a8';
    ctx.fillText(EXPORT_HOST, titleX + titleW + 10, midY + 1);
    const hostW = ctx.measureText(EXPORT_HOST).width;
    ctx.fillStyle = '#5c6a80'; ctx.textAlign = 'right';
    const stats = viewLabel() + ' · ' + pages.length + ' 页 · ' + clusterList.length + ' 集群 · 内容边 ' + contentEdgeCount + ' · ' + EXPORT_DATE;
    ctx.fillText(fitText(ctx, stats, Math.max(40, W - pad - 14 - (titleX + titleW + 10 + hostW) - 20)), W - pad - 14, midY + 1);
    ctx.restore();
    pathRound(ctx, 0.5, 0.5, W - 1, H - 1, 16);
    ctx.strokeStyle = 'rgba(20, 31, 47, .12)'; ctx.lineWidth = 1; ctx.stroke();

    const name = fileBase() + (state.view === 'cluster' ? '-cluster' : '-page' + (state.scope ? '-focus' : '')) + (full ? '-full' : '-view') + '.png';
    const outBlob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    if (!outBlob) { toast('图像导出失败：合成画布超出浏览器上限'); return null; }
    download(name, outBlob);
    toast('已导出 ' + name + ' · ' + Math.round(outBlob.size / 1024) + ' KB');
    return { name, size: outBlob.size, width: W, height: H };
  }

  const exBtn = $('#export-btn'); const exMenu = $('#export-menu');
  function setExportMenu(open) {
    exMenu.hidden = !open;
    exBtn.classList.toggle('open', open);
    exBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      const ok = !!cy; // 数据视图下画布已销毁，图像导出不可用
      exMenu.querySelectorAll('[data-export="png-view"], [data-export="png-full"]').forEach((b) => {
        b.disabled = !ok;
        b.title = ok ? '' : '请先切换到「集群」或「页面」视图';
      });
    }
  }
  exBtn.addEventListener('click', (ev) => { ev.stopPropagation(); setExportMenu(exMenu.hidden); });
  document.addEventListener('click', (ev) => {
    if (!exMenu.hidden && !exMenu.contains(ev.target) && !exBtn.contains(ev.target)) setExportMenu(false);
  });
  exMenu.addEventListener('click', (ev) => {
    const item = ev.target.closest && ev.target.closest('.ex-item');
    if (!item || item.disabled) return;
    setExportMenu(false);
    runExport(item.dataset.export);
  });
  async function runExport(kind) {
    if (kind === 'png-view') return exportPNG(false);
    if (kind === 'png-full') return exportPNG(true);
    if (kind === 'csv-pages') return saveText(buildPagesCSV(), fileBase() + '-pages.csv', 'text/csv');
    if (kind === 'csv-edges') return saveText(buildEdgesCSV(), fileBase() + '-edges.csv', 'text/csv');
    if (kind === 'csv-clusters') return saveText(buildClustersCSV(), fileBase() + '-clusters.csv', 'text/csv');
    if (kind === 'json') return saveText(JSON.stringify(T, null, 2) + '\n', fileBase() + '.json', 'application/json');
    if (kind === 'gexf') return saveText(buildGEXF(), fileBase() + '.gexf', 'application/xml');
    if (kind === 'graphml') return saveText(buildGraphML(), fileBase() + '.graphml', 'application/xml');
    return null;
  }

  /* ================= 视图按钮 ================= */
  el.segButtons.forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.view === 'page' && state.view !== 'page') setScope(state.scope);
    else setView(b.dataset.view);
  }));

  /* ================= 启动 ================= */
  window.__linktopo = { get cy() { return cy; }, state, clusterSkeleton, exports: { buildPagesCSV, buildEdgesCSV, buildClustersCSV, buildGEXF, buildGraphML, exportPNG, runExport } };
  renderStats();
  renderClusterList();
  renderIssues();
  el.crumbText.textContent = '页面视图 · 全站';
  el.breadcrumb.hidden = true;
  setView('cluster');
})();
