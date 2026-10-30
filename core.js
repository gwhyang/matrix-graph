/*
 * matrix-graph core: 与运行环境无关的纯逻辑
 *  - parseMatrix:    markdown 表格 -> {tags, elements, memberships}
 *  - buildGraph:     两种模式生成节点/边（hub | similar）
 *  - createSim:      力导向模拟（朴素斥力，n>1200 时可替换为网格）
 *  - layout helpers: 视口裁剪、LOD、命中检测
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MatrixCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 解析 ---------------- */

  var TRUTHY_EMPTY = new Set(['', '-', '—', '0', 'false', 'no', '×']);

  function parseMatrix(source) {
    var lines = String(source || '').split(/\r?\n/);
    var options = {};
    var tableLines = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.charAt(0) === '|') { tableLines.push(line); continue; }
      if (!tableLines.length) {
        var m = line.match(/^([A-Za-z_][\w-]*)\s*[:=]\s*(.+)$/);
        if (m) options[m[1].toLowerCase()] = m[2].trim();
      }
    }

    if (!tableLines.length) return { options: options, tags: [], elements: [], memberships: new Map(), errors: ['没有找到表格'] };

    function splitRow(row) {
      var inner = row.replace(/^\|/, '').replace(/\|$/, '');
      return inner.split('|').map(function (c) { return c.trim().replace(/\\\|/g, '|'); });
    }

    var headerCells = splitRow(tableLines[0]);
    var imageCol = -1;
    var tagCols = [];
    for (var hc = 1; hc < headerCells.length; hc++) {
      var hn = headerCells[hc].trim();
      if (/^(图片|卡图|图|image|img|art|icon)$/i.test(hn)) imageCol = hc;
      else if (hn.length > 0) tagCols.push(hc);
    }
    var tags = tagCols.map(function (idx) { return headerCells[idx].trim(); });
    var start = 1;
    if (tableLines.length > 1 && /^[\s:|-]+$/.test(tableLines[1])) start = 2;

    function cleanImageHint(raw) {
      var s = String(raw || '').trim();
      s = s.replace(/^!?\[\[/, '').replace(/\]\]$/, '');
      s = s.split('|')[0].trim();
      return s;
    }

    var elements = [];
    var memberships = new Map();
    for (var r = start; r < tableLines.length; r++) {
      var cells = splitRow(tableLines[r]);
      var name = (cells[0] || '').trim();
      if (!name) continue;
      var flags = [];
      var weights = [];
      for (var c = 0; c < tags.length; c++) {
        var raw = (cells[tagCols[c]] || '').trim();
        var on = !TRUTHY_EMPTY.has(raw.toLowerCase());
        flags.push(on ? 1 : 0);
        var num = Number(raw);
        weights.push(on && isFinite(num) && num !== 0 ? num : (on ? 1 : 0));
      }
      var hint = imageCol >= 0 ? cleanImageHint(cells[imageCol]) : '';
      elements.push({ name: name, imageHint: hint, cellText: cells, flags: flags, weights: weights });
      memberships.set(name, tags.filter(function (_, idx) { return flags[idx]; }));
    }

    return { options: options, tags: tags, elements: elements, memberships: memberships, errors: [] };
  }

  /* ---------------- 建图 ---------------- */

  function buildGraph(parsed, cfg) {
    cfg = cfg || {};
    var mode = cfg.mode || 'hub';
    var threshold = Math.max(1, cfg.threshold == null ? 2 : cfg.threshold);
    // topK = 0 表示不限制（默认），>0 时每节点最多连这么多条边
    var topK = cfg.topK == null ? 0 : Number(cfg.topK);
    if (!isFinite(topK) || topK < 0) topK = 0;
    var tags = parsed.tags.slice();
    var elements = parsed.elements;
    var nodes = [];
    var links = [];
    var tagIndex = new Map();

    // 孤立聚类：完全没有标签的元素，归入一个虚拟标签
    var orphanTag = cfg.orphanTag || '（无标签）';
    var orphanEls = elements.filter(function (el) {
      return el.flags.every(function (f) { return !f; });
    });
    var useOrphans = cfg.orphans !== false && orphanEls.length > 0;
    var colorTags = tags.concat(useOrphans ? [orphanTag] : []);

    function nodeId(name) { return 'e:' + name; }

    elements.forEach(function (el) {
      nodes.push({
        id: nodeId(el.name),
        label: el.name,
        kind: 'element',
        tags: parsed.memberships.get(el.name) || [],
        imageHint: el.imageHint || '',
        degree: 0
      });
    });

    if (mode === 'hub') {
      tags.forEach(function (t) {
        var id = 't:' + t;
        tagIndex.set(t, id);
        nodes.push({ id: id, label: t, kind: 'tag', tags: [], degree: 0 });
      });
      var byId = new Map(nodes.map(function (n) { return [n.id, n]; }));
      elements.forEach(function (el) {
        var list = parsed.memberships.get(el.name) || [];
        list.forEach(function (t) {
          var tid = tagIndex.get(t);
          if (!tid) return;
          var w = el.weights[tags.indexOf(t)] || 1;
          links.push({ source: nodeId(el.name), target: tid, weight: w, kind: 'hub' });
          byId.get(nodeId(el.name)).degree++;
          byId.get(tid).degree++;
        });
      });
      if (useOrphans) {
        var oid = 't:' + orphanTag;
        var onode = { id: oid, label: orphanTag, kind: 'tag', tags: [], degree: 0, orphan: true };
        nodes.push(onode);
        byId.set(oid, onode);
        orphanEls.forEach(function (el) {
          links.push({ source: nodeId(el.name), target: oid, weight: 1, kind: 'orphan' });
          byId.get(nodeId(el.name)).degree++;
          onode.degree++;
        });
      }
      return { nodes: nodes, links: links, mode: mode, tags: colorTags };
    }

    // similar 模式：元素之间，权重 = 共同标签数
    var inv = new Map();
    tags.forEach(function (t) { inv.set(t, []); });
    elements.forEach(function (el) {
      el.flags.forEach(function (f, idx) { if (f) inv.get(tags[idx]).push(el.name); });
    });

    var pairCount = new Map();
    inv.forEach(function (list) {
      for (var a = 0; a < list.length; a++) {
        for (var b = a + 1; b < list.length; b++) {
          var key = list[a] + '\u0000' + list[b];
          pairCount.set(key, (pairCount.get(key) || 0) + 1);
        }
      }
    });

    var keep = [];
    pairCount.forEach(function (w, key) {
      if (w < threshold) return;
      var parts = key.split('\u0000');
      keep.push({ source: nodeId(parts[0]), target: nodeId(parts[1]), weight: w, kind: 'similar' });
    });

    // 每节点 Top-K 限制，防团块坍缩
    keep.sort(function (a, b) { return b.weight - a.weight; });
    var deg = new Map();
    var kept = [];
    var truncated = 0;
    keep.forEach(function (l) {
      if (topK > 0) {
        var ds = deg.get(l.source) || 0;
        var dt = deg.get(l.target) || 0;
        if (ds >= topK || dt >= topK) { truncated++; return; }
        deg.set(l.source, ds + 1);
        deg.set(l.target, dt + 1);
      }
      kept.push(l);
    });

    if (useOrphans) {
      for (var oi = 0; oi < orphanEls.length; oi++) {
        for (var oj = oi + 1; oj < orphanEls.length; oj++) {
          kept.push({
            source: nodeId(orphanEls[oi].name),
            target: nodeId(orphanEls[oj].name),
            weight: 1,
            kind: 'orphan'
          });
        }
      }
    }

    var degById = new Map();
    kept.forEach(function (l) {
      degById.set(l.source, (degById.get(l.source) || 0) + 1);
      degById.set(l.target, (degById.get(l.target) || 0) + 1);
    });

    // 孤立聚类（相似模式）：过滤后没有任何连线的节点，彼此连成一组
    var isolatedCount = 0;
    if (cfg.orphans !== false) {
      var lonely = nodes.filter(function (n) {
        return n.kind === 'element' && !(degById.get(n.id) > 0);
      });
      isolatedCount = lonely.length;
      lonely.forEach(function (n) { n.isolated = true; });
      if (lonely.length) {
        // ≤8 个：两两相连（真正的团）；更多：星形（1 拖 N），边数只 +N-1，避免边数爆炸
        if (lonely.length <= 8) {
          for (var li = 0; li < lonely.length; li++) {
            for (var lj = li + 1; lj < lonely.length; lj++) {
              kept.push({ source: lonely[li].id, target: lonely[lj].id, weight: 1, kind: 'isolated' });
            }
          }
        } else {
          var anchor = lonely[0].id;
          for (var lk = 1; lk < lonely.length; lk++) {
            kept.push({ source: anchor, target: lonely[lk].id, weight: 1, kind: 'isolated' });
          }
        }
        degById = new Map();
        kept.forEach(function (l) {
          degById.set(l.source, (degById.get(l.source) || 0) + 1);
          degById.set(l.target, (degById.get(l.target) || 0) + 1);
        });
      }
    }

    nodes.forEach(function (n) { n.degree = degById.get(n.id) || 0; });

    return {
      nodes: nodes,
      links: kept,
      mode: mode,
      dropped: pairCount.size - keep.length,
      truncated: truncated,
      isolated: isolatedCount,
      tags: colorTags
    };
  }

  /* ---------------- 力模拟 ---------------- */

  /* d3-force 语义的力模拟（对齐 Obsidian 核心图谱：charge -1000 / link 250 / center 0.1）
   * 关键点：
   *  - 所有节点从原点附近出发，靠斥力炸开（不是预排布）
   *  - 斥力是全局 1/r²，没有距离截断，所以会持续向外扩张
   *  - 位置更新 = 速度积分，alpha 只衰减力的大小，不直接缩放位移
   */
  function createSim(nodes, links, opts) {
    opts = opts || {};

    var charge = -(opts.repelStrength == null
      ? (opts.repulsion == null ? 4000 : opts.repulsion)
      : opts.repelStrength);
    var centerStrength = opts.centerStrength == null
      ? (opts.gravity == null ? 0.0016 : opts.gravity) * 62.5
      : opts.centerStrength;
    var linkDistance = opts.linkDistance == null
      ? (opts.linkLength == null ? 250 : opts.linkLength)
      : opts.linkDistance;
    var linkStrength = opts.linkStrength == null
      ? (opts.attraction == null ? 1 : opts.attraction)
      : opts.linkStrength;

    var alphaMin = 0.001;
    var convergeTicks = opts.convergeTicks == null ? 1200 : opts.convergeTicks;
    var alphaDecay = 1 - Math.pow(alphaMin, 1 / convergeTicks);
    var velocityDecay = 0.4;
    var alpha = 1;
    var alphaTarget = 0;

    var linkMode = opts.linkMode || 'proportional';
    var perTag = opts.perTag == null ? 0.035 : opts.perTag;
    var collide = opts.collide === false ? 0 : (opts.collideRadius || 72);

    var idx = new Map();
    var i;
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      idx.set(n.id, i);
      n.index = i;
      if (n.x == null || n.y == null) { n.x = 0; n.y = 0; }   // 原点出发
      if (n.fx != null) { n.x = n.fx; }
      if (n.fy != null) { n.y = n.fy; }
      n.vx = 0; n.vy = 0;
      n.fixed = !!n.fixed;
    }

    // 轻微抖动，避免完全重合时方向为 0
    if (!nodes.__jittered) {
      for (i = 0; i < nodes.length; i++) {
        nodes[i].x += (Math.random() - 0.5) * 1e-3;
        nodes[i].y += (Math.random() - 0.5) * 1e-3;
      }
    }

    var edges = [];
    for (i = 0; i < links.length; i++) {
      var l = links[i];
      var si = idx.get(l.source), ti = idx.get(l.target);
      if (si == null || ti == null || si === ti) continue;
      var w = Math.max(1, l.weight || 1);
      var st = linkStrength, dist = linkDistance;
      if (linkMode === 'proportional' && w > 1) {
        st = linkStrength * (1 + (w - 1) * perTag * 6);
        dist = linkDistance / (1 + (w - 1) * 0.25);
      }
      edges.push({ s: si, t: ti, weight: w, distance: dist, strength: st });
    }

    // link bias：度数越大，单条边的影响力越小
    var count = new Float64Array(nodes.length);
    for (i = 0; i < edges.length; i++) { count[edges[i].s]++; count[edges[i].t]++; }
    for (i = 0; i < edges.length; i++) {
      var ee = edges[i];
      var cs = count[ee.s], ct = count[ee.t];
      ee.biasS = ct / (cs + ct);
      ee.biasT = cs / (cs + ct);
    }

    function applyLink() {
      for (var k = 0; k < edges.length; k++) {
        var ed = edges[k];
        var a = nodes[ed.s], b = nodes[ed.t];
        var dx = b.x + b.vx - a.x - a.vx;
        var dy = b.y + b.vy - a.y - a.vy;
        var d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        var l = (d - ed.distance) / d * alpha * ed.strength;
        dx *= l; dy *= l;
        b.vx -= dx * ed.biasT; b.vy -= dy * ed.biasT;
        a.vx += dx * ed.biasS; a.vy += dy * ed.biasS;
      }
    }

    /* 斥力：每次 tick 给两个节点各加一份速度增量
     *   Δv = charge · alpha / d        （沿两点连线方向，charge < 0 表示相互推开）
     * 注意是 1/d 而不是 1/d²：与 d3-force 的 forceManyBody 一致
     *   d3 里 w = strength·alpha/d²，再 vx += dx·w，|Δv| = d·|w| = |strength|·alpha/d
     * 必须对称地给两端都加，否则低序号节点被推、高序号节点被吸，整张图会收缩
     */
    function applyCharge() {
      var k = charge * alpha;
      for (var p = 0; p < nodes.length; p++) {
        var a = nodes[p];
        for (var q = p + 1; q < nodes.length; q++) {
          var b = nodes[q];
          var dx = b.x - a.x, dy = b.y - a.y;
          var d2 = dx * dx + dy * dy;
          if (d2 < 1) d2 = 1;
          var w = k / d2;
          a.vx += dx * w; a.vy += dy * w;
          b.vx -= dx * w; b.vy -= dy * w;
        }
      }
    }
    function applyCenter() {
      for (var p = 0; p < nodes.length; p++) {
        var a = nodes[p];
        a.vx += (0 - a.x) * centerStrength * alpha;
        a.vy += (0 - a.y) * centerStrength * alpha;
      }
    }

    function applyCollide() {
      if (!collide) return;
      var minD = collide * 2;
      for (var p = 0; p < nodes.length; p++) {
        var a = nodes[p];
        for (var q = p + 1; q < nodes.length; q++) {
          var b = nodes[q];
          var dx = b.x - a.x, dy = b.y - a.y;
          var d2 = dx * dx + dy * dy;
          if (d2 >= minD * minD || d2 === 0) continue;
          var d = Math.sqrt(d2);
          var overlap = (minD - d) / d * 0.5;
          var sx = dx * overlap, sy = dy * overlap;
          if (!a.fixed) { a.x -= sx; a.y -= sy; }
          if (!b.fixed) { b.x += sx; b.y += sy; }
        }
      }
    }

    function integrate() {
      for (var p = 0; p < nodes.length; p++) {
        var a = nodes[p];
        if (a.fixed) { a.vx = 0; a.vy = 0; continue; }
        a.vx *= (1 - velocityDecay);
        a.vy *= (1 - velocityDecay);
        a.x += a.vx;
        a.y += a.vy;
      }
    }

    return {
      nodes: nodes,
      edges: edges,
      get alpha() { return alpha; },
      alphaNow: function () { return alpha; },
      /* 只更新连线，不重新解算坐标（热更新用） */
      setLinks: function (newLinks) {
        var idx2 = new Map();
        for (var i2 = 0; i2 < nodes.length; i2++) idx2.set(nodes[i2].id, i2);
        var e2 = [];
        for (var j2 = 0; j2 < newLinks.length; j2++) {
          var l2 = newLinks[j2];
          var s2 = idx2.get(l2.source), t2 = idx2.get(l2.target);
          if (s2 == null || t2 == null || s2 === t2) continue;
          var w2 = Math.max(1, l2.weight || 1);
          var st2 = linkStrength, di2 = linkDistance;
          if (linkMode === 'proportional' && w2 > 1) {
            st2 = linkStrength * (1 + (w2 - 1) * perTag * 6);
            di2 = linkDistance / (1 + (w2 - 1) * 0.25);
          }
          e2.push({ s: s2, t: t2, weight: w2, distance: di2, strength: st2 });
        }
        var cnt2 = new Float64Array(nodes.length);
        for (var k2 = 0; k2 < e2.length; k2++) { cnt2[e2[k2].s]++; cnt2[e2[k2].t]++; }
        for (var p2 = 0; p2 < e2.length; p2++) {
          var ed2 = e2[p2];
          var cs2 = cnt2[ed2.s], ct2 = cnt2[ed2.t];
          ed2.biasS = ct2 / (cs2 + ct2);
          ed2.biasT = cs2 / (cs2 + ct2);
        }
        edges = e2;
        return e2.length;
      },
      reheat: function (a) { alpha = Math.max(alpha, a == null ? 1 : a); },
      setAlpha: function (a) { alpha = a == null ? 1 : a; },
      stop: function () { alpha = 0; },
      step: function () {
        if (alpha < alphaMin) return false;
        applyLink();
        applyCharge();
        applyCenter();
        integrate();
        applyCollide();
        alpha += (alphaTarget - alpha) * alphaDecay;
        return alpha >= alphaMin;
      },
      tick: function () { /* alpha 在 step 内推进（d3 语义） */ }
    };
  }
  /* ---------------- 布局/渲染辅助 ---------------- */

  function bounds(nodes, pad) {
    pad = pad || 0;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(function (n) {
      if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
    });
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  }

  function lodFor(zoom, cfg) {
    cfg = cfg || {};
    var full = cfg.lodFull == null ? 0.75 : cfg.lodFull;
    var mid = cfg.lodMid == null ? 0.35 : cfg.lodMid;
    if (zoom >= full) return 'image';
    if (zoom >= mid) return 'box';
    return 'dot';
  }

  function pick(nodes, x, y, zoom) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var hw = (n.kind === 'tag' ? 70 : 60) * zoom;
      var hh = (n.kind === 'tag' ? 22 : 34) * zoom;
      if (Math.abs(n.x * zoom - x) <= hw && Math.abs(n.y * zoom - y) <= hh) {
        var d = Math.abs(n.x * zoom - x) + Math.abs(n.y * zoom - y);
        if (d < bestD) { bestD = d; best = n; }
      }
    }
    return best;
  }

  return {
    parseMatrix: parseMatrix,
    buildGraph: buildGraph,
    createSim: createSim,
    bounds: bounds,
    lodFor: lodFor,
    pick: pick
  };
});
