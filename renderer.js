/*
 * matrix-graph renderer: Canvas 2D 渲染 + 交互（不依赖 Obsidian，可在浏览器里独立跑）
 * LOD:  zoom>=0.75 画卡图 | 0.35~0.75 画色块 | <0.35 画圆点
 * 视口裁剪：只画屏幕内节点
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MatrixRenderer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COLORS = ['#3f6ad8', '#d98a1f', '#12a08c', '#b8459b', '#5f8f22', '#c0483f', '#7a6fd8', '#2f9ec4'];

  function createRenderer(cfg) {
    var canvas = cfg.canvas;
    var ctx = canvas.getContext('2d', { alpha: false });
    var holder = cfg.holder || canvas.parentElement;
    var core = cfg.core;
    var graph = cfg.graph;
    var images = cfg.images || new Map();     // nodeId -> Image
    var onNodeClick = cfg.onNodeClick || function () {};
    var onNodeHover = cfg.onNodeHover || function () {};
    var palette = cfg.palette || {};
    var opts = cfg.options || {};

    var view = { x: 0, y: 0, zoom: 1 };
    var sim = core.createSim(graph.nodes, graph.links, opts);
    var raf = null;
    var dragging = null;
    var panning = null;
    var hover = null;
    var running = true;
    var playing = true;
    var settledOnce = false;
    // timelapse：按连线顺序逐步生长（对齐 Obsidian 核心图谱的「生长动画」）
    var tlp = { on: false, prog: 0, speed: 0, t0: 0, total: 0 };
    var visIds = null;
    var visCount = {};          // 当前可见连线数（标签节点用它决定大小）
    var enterAt = new Map();    // nodeId -> 首次出现的时刻（淡入用）
    var seen = new Set();       // 已经出现过（用于外侧圆周入场）
    var firstDraw = true;
    var settled = false;
    var tagColor = new Map();
    var tagColorByName = new Map();
    var tagOrder = cfg.tagOrder || [];
    if (!tagOrder.length) {
      tagOrder = graph.nodes.filter(function (n) { return n.kind === 'tag'; }).map(function (n) { return n.label; });
    }
    tagOrder.forEach(function (t, i) { tagColorByName.set(t, COLORS[i % COLORS.length]); });
    graph.nodes.forEach(function (n, i) {
      if (n.kind === 'tag') tagColor.set(n.id, tagColorByName.get(n.label) || COLORS[i % COLORS.length]);
    });

    function primaryColor(n) {
      if (n.kind === 'tag') return tagColor.get(n.id) || COLORS[0];
      if (n.isolated) return '#8b93a7';   // 固定中灰，避免主题 --text-faint 太浅看不见
      var t = (n.tags && n.tags[0]) || '';
      return tagColorByName.get(t) || (palette.muted || '#8892a0');
    }

    function resize() {
      var rect = holder.getBoundingClientRect();
      var w = Math.max(320, Math.floor(rect.width));
      var h = opts.fill
        ? Math.max(240, Math.floor(holder.clientHeight || (window.innerHeight * 0.72)))
        : Math.max(240, Math.floor(opts.height || 520));
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      view.w = w; view.h = h;
    }

    function screen(n) { return { x: n.x * view.zoom + view.x, y: n.y * view.zoom + view.y }; }
    function toWorld(px, py) { return { x: (px - view.x) / view.zoom, y: (py - view.y) / view.zoom }; }

    function fit() {
      var b = core.bounds(graph.nodes, 120);
      var w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY);
      var z = Math.min(view.w / w, view.h / h);
      z = Math.max(0.05, Math.min(1.6, z));
      view.zoom = z;
      view.x = view.w / 2 - ((b.minX + b.maxX) / 2) * z;
      view.y = view.h / 2 - ((b.minY + b.maxY) / 2) * z;
    }

    function fitToBounds(b, margin) {
      margin = margin == null ? 0.2 : margin;
      var w = Math.max(1, b.maxX - b.minX) * (1 + margin * 2);
      var h = Math.max(1, b.maxY - b.minY) * (1 + margin * 2);
      var z = Math.min(view.w / w, view.h / h);
      view.zoom = Math.max(0.03, Math.min(1.6, z));
      view.x = view.w / 2 - ((b.minX + b.maxX) / 2) * view.zoom;
      view.y = view.h / 2 - ((b.minY + b.maxY) / 2) * view.zoom;
    }

    /* 预解算：用同一套力参数在副本上跑到收敛，得到大致包围盒（不动真实节点） */
    function presolveBounds() {
      var ghost = graph.nodes.map(function (n) {
        return { id: n.id, kind: n.kind, x: 0, y: 0, vx: 0, vy: 0, fixed: false };
      });
      var ghostSim = core.createSim(ghost, graph.links, Object.assign({}, opts));
      for (var i = 0; i < 600; i++) { if (!ghostSim.step()) break; }
      return core.bounds(ghost, 0);
    }
    function neighborsOf(node) {
      var set = new Set();
      if (!node) return set;
      graph.links.forEach(function (l) {
        if (l.source === node.id) set.add(l.target);
        else if (l.target === node.id) set.add(l.source);
      });
      set.add(node.id);
      return set;
    }

    var dbg = { total: 0, drawn: 0, culled: 0, bad: 0 };
    var layoutNotified = false;
    function notifyLayout() {
      if (cfg.onLayoutChange) { try { cfg.onLayoutChange(positionsSnapshot()); } catch (e) { } }
    }
    function positionsSnapshot() {
      var o = {};
      graph.nodes.forEach(function (n) { o[n.id] = [Math.round(n.x), Math.round(n.y)]; });
      return o;
    }

    function draw() {
      var w = view.w, h = view.h, z = view.zoom;
      if (!(w > 0) || !(h > 0)) return;
      dbg.total = graph.nodes.length; dbg.drawn = 0; dbg.culled = 0; dbg.bad = 0;
      var maxImg = opts.imageMaxNodes == null ? 220 : opts.imageMaxNodes;
    var mode;
    if (graph.nodes.length <= maxImg) mode = 'image';
    else mode = core.lodFor(z, { lodFull: opts.lodFull == null ? 0.28 : opts.lodFull, lodMid: opts.lodMid == null ? 0.15 : opts.lodMid });
      var focus = hover ? neighborsOf(hover) : null;

      ctx.fillStyle = palette.bg || '#ffffff';
      ctx.fillRect(0, 0, w, h);

      // 边
      ctx.lineWidth = opts.edgeWidth == null ? 1 : opts.edgeWidth;
      ctx.strokeStyle = palette.edge || 'rgba(120,130,150,0.45)';
      var visLinks = activeLinks();
      // 首次出现的节点：从外侧圆周飞入，并开始淡入
      (function () {
        var visibleList = [];
        for (var q1 = 0; q1 < graph.nodes.length; q1++) {
          var nd0 = graph.nodes[q1];
          if (visIds && !visIds.has(nd0.id)) continue;
          if (seen.has(nd0.id)) { visibleList.push(nd0); continue; }
          seen.add(nd0.id);
          if (firstDraw) { visibleList.push(nd0); continue; }   // 首帧：只登记，不搬运
          enterAt.set(nd0.id, performance.now());
          var cx0 = 0, cy0 = 0, cnt0 = 0, maxR0 = 140;
          for (var q2 = 0; q2 < visibleList.length; q2++) {
            cx0 += visibleList[q2].x; cy0 += visibleList[q2].y; cnt0++;
          }
          if (cnt0) {
            cx0 /= cnt0; cy0 /= cnt0;
            for (var q3 = 0; q3 < visibleList.length; q3++) {
              var dd = Math.hypot(visibleList[q3].x - cx0, visibleList[q3].y - cy0);
              if (dd > maxR0) maxR0 = dd;
            }
          }
          var ang0 = Math.random() * Math.PI * 2;
          var rad0 = maxR0 * 1.35;
          nd0.x = cx0 + Math.cos(ang0) * rad0;
          nd0.y = cy0 + Math.sin(ang0) * rad0;
          nd0.vx = 0; nd0.vy = 0;
          visibleList.push(nd0);
        }
      })();
      visCount = {};
      for (var vi = 0; vi < visLinks.length; vi++) {
        visCount[visLinks[vi].source] = (visCount[visLinks[vi].source] || 0) + 1;
        visCount[visLinks[vi].target] = (visCount[visLinks[vi].target] || 0) + 1;
      }
      visIds = tlp.on ? visibleNodeIds(visLinks) : null;
      ctx.beginPath();
      for (var i = 0; i < visLinks.length; i++) {
        var l = visLinks[i];
        var a = graph.nodes.find(function (n) { return n.id === l.source; });
        var b = graph.nodes.find(function (n) { return n.id === l.target; });
        if (!a || !b) continue;
        var pa = screen(a), pb = screen(b);
        if ((pa.x < -50 && pb.x < -50) || (pa.x > w + 50 && pb.x > w + 50)) continue;
        if ((pa.y < -50 && pb.y < -50) || (pa.y > h + 50 && pb.y > h + 50)) continue;
        ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
      }
      ctx.stroke();

      // 节点（先画元素，后画体系，体系在上层）
      var order = graph.nodes.slice().sort(function (m, n) {
        return (m.kind === 'tag' ? 1 : 0) - (n.kind === 'tag' ? 1 : 0);
      });

      firstDraw = false;

      for (var k = 0; k < order.length; k++) {
        var n = order[k];
        if (visIds && !visIds.has(n.id)) continue;
        // 坐标坏了就自愈，避免整张卡静默消失
        if (!isFinite(n.x) || !isFinite(n.y)) {
          dbg.bad++;
          n.x = (Math.random() - 0.5) * 200;
          n.y = (Math.random() - 0.5) * 200;
          n.vx = 0; n.vy = 0;
        }
        var p = screen(n);
        if (!isFinite(p.x) || !isFinite(p.y)) { dbg.bad++; continue; }
        var ns = opts.nodeScale == null ? 1 : opts.nodeScale;
        var tagLinks = (n.kind === 'tag') ? (visCount[n.id] || 0) : 0;
        var tagBaseW = opts.tagBaseW == null ? 96 : opts.tagBaseW;
        var tagStepW = opts.tagStepW == null ? 9 : opts.tagStepW;
        var tagBaseH = opts.tagBaseH == null ? 26 : opts.tagBaseH;
        var tagStepH = opts.tagStepH == null ? 2.2 : opts.tagStepH;
        var cw = (n.kind === 'tag')
          ? Math.max(46, (tagBaseW + tagStepW * tagLinks) * z)
          : Math.max(96 * z * ns, 26 * ns);
        var ch = (n.kind === 'tag')
          ? Math.max(16, (tagBaseH + tagStepH * tagLinks) * z)
          : Math.max(120 * z * ns, 33 * ns);
        var fade = 1;
        var ft0 = enterAt.get(n.id);
        if (ft0 != null) {
          var fk = (performance.now() - ft0) / (opts.enterFade == null ? 420 : opts.enterFade);
          if (fk >= 1) enterAt.delete(n.id); else fade = Math.max(0.05, fk);
        }
        if (p.x + cw < -20 || p.x - cw > w + 20 || p.y + ch < -20 || p.y - ch > h + 20) { dbg.culled++; continue; }

        dbg.drawn++;
        var dim = focus && !focus.has(n.id);
        var tagTextColor = palette.bg || '#ffffff';
        ctx.globalAlpha = (dim ? 0.42 : 1) * fade;

        if (n.kind === 'tag') {
          ctx.fillStyle = tagColor.get(n.id) || COLORS[0];
          roundRect(ctx, p.x - cw / 2, p.y - ch / 2, cw, ch, 6);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = Math.max(9, 13 * z) + 'px var(--font-interface, sans-serif)';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(n.label, p.x, p.y);
        } else if (mode === 'image' && images.has(n.id)) {
          var img = images.get(n.id);
          ctx.drawImage(img, p.x - cw / 2, p.y - ch / 2, cw, ch);
        } else if (mode === 'box') {
          ctx.fillStyle = primaryColor(n);
          roundRect(ctx, p.x - cw / 2, p.y - ch / 2, cw, ch, 4);
          ctx.fill();
        } else {
          ctx.fillStyle = primaryColor(n);
          if (mode === 'image') {
            roundRect(ctx, p.x - cw / 2, p.y - ch / 2, cw, ch, 4);
            ctx.fill();
            ctx.fillStyle = tagTextColor;
            ctx.font = Math.max(8, 11 * z) + 'px sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(String(n.label).slice(0, 2), p.x, p.y);
          } else {
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(2.5, 7 * z), 0, 6.2832);
            ctx.fill();
          }
        }

        if (fade < 1) {
          ctx.save();
          ctx.globalAlpha = (1 - fade) * 0.92;
          ctx.fillStyle = palette.bg || '#ffffff';
          roundRect(ctx, p.x - cw / 2, p.y - ch / 2, cw, ch, n.kind === 'tag' ? 6 : 4);
          ctx.fill();
          ctx.restore();
        }

        if (n === hover) {
          ctx.strokeStyle = palette.accent || '#6b8afd';
          ctx.lineWidth = 2;
          roundRect(ctx, p.x - cw / 2 - 2, p.y - ch / 2 - 2, cw + 4, ch + 4, 6);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

        var showLabels = opts.showLabels !== false;
        var labelAlpha = opts.labelAlpha == null ? 0.85 : opts.labelAlpha;
        if (showLabels && n.kind !== 'tag' && (mode !== 'dot' ? z > 0.28 : z > 0.18)) {
          ctx.globalAlpha = labelAlpha;
          ctx.fillStyle = palette.text || '#333';
          ctx.font = Math.max(9, 11 * Math.min(1, z * 1.6)) + 'px var(--font-interface, sans-serif)';
          ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          var lb = n.label.length > 20 ? n.label.slice(0, 19) + '…' : n.label;
          ctx.fillText(lb, p.x, p.y + ch / 2 + 3);
          ctx.globalAlpha = 1;
        }
      }

      
    }

    /* 把孤立节点整体挪到主团下方，独立成一团 */
  
    function roundRect(c, x, y, w, h, r) {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }

    function resetPositions() {
      graph.nodes.forEach(function (n) {
        if (n.isolated) { n.fixed = false; }
        n.x = (Math.random() - 0.5) * 24;
        n.y = (Math.random() - 0.5) * 24;
        n.vx = 0; n.vy = 0;
      });
    }

    /* 重新开始的动画：回到中心 -> 加热 -> 让循环自己炸开 */
    function clearEntry() { seen.clear(); enterAt.clear(); }

    function playAnimation() {
      clearEntry();
      resetPositions();
      sim = core.createSim(graph.nodes, graph.links, opts);
      sim.reheat(1);
      playing = true;
      fit();
      draw();
      kick();
    }

    function runLayout() {
      var guard = 0;
      while (sim.alpha > 0 && guard < 900) { sim.step(); sim.tick(); guard++; }
      fit();
      draw();
    }
    function activeLinks() {
      if (!tlp.on) return graph.links;
      return graph.links.slice(0, Math.min(tlp.prog, graph.links.length));
    }

    function visibleNodeIds(links) {
      var ids = new Set();
      links.forEach(function (l) { ids.add(l.source); ids.add(l.target); });
      // 播放生长动画时，体系节点从第一帧就在场（枢纽模式）`n      if (tlp.on) { for (var ti = 0; ti < graph.nodes.length; ti++) { if (graph.nodes[ti].kind === "tag") ids.add(graph.nodes[ti].id); } }
      return ids;
    }

    function rebuildForProgression() {
      var links = activeLinks();
      var ids = visibleNodeIds(links);
      var nodes = graph.nodes.filter(function (n) { return ids.has(n.id); });
      sim = core.createSim(nodes, links, opts);
      sim.reheat(0.45);
      draw();
    }

    /* 播放生长动画：progression 从 1 条连线推进到全部 */
    function playTimelapse() {
      tlp.total = graph.links.length;
      if (!tlp.total) return;
      clearEntry();
      tlp.on = true;
      tlp.prog = 1;
      tlp.speed = Math.min(100, Math.max(5, 0.5 * Math.sqrt(tlp.total)));
      tlp.t0 = performance.now();
      playing = true;
      rebuildForProgression();
      fit();
      kick();
    }

    function stopTimelapse() {
      tlp.on = false;
      sim = core.createSim(graph.nodes, graph.links, opts);
      sim.reheat(0.5);
      fit();
      draw();
      kick();
    }
    var autoFitDone = false;

    /* 数据热更新：保留已有节点坐标、保留镜头，只让新节点轻轻归位 */
    function replaceGraph(newGraph) {
      // 真正的增量：能改数据结构就不重建，能不动坐标就不动
      var oldById = new Map();
      graph.nodes.forEach(function (n) { oldById.set(n.id, n); });
      var newIds = new Set();
      newGraph.nodes.forEach(function (n) { newIds.add(n.id); });

      var added = [], removed = 0;
      newGraph.nodes.forEach(function (n) { if (!oldById.has(n.id)) added.push(n); });
      oldById.forEach(function (n, id) { if (!newIds.has(id)) removed++; });

      // 节点：复用旧对象（保住坐标），只更新属性
      var merged = [];
      newGraph.nodes.forEach(function (n) {
        var keep = oldById.get(n.id);
        if (keep) {
          keep.tags = n.tags; keep.degree = n.degree; keep.isolated = n.isolated;
          merged.push(keep);
        } else {
          merged.push(n);
        }
      });
      graph.nodes = merged;

      // 连线差异
      var oldKey = new Set();
      graph.links.forEach(function (l) { oldKey.add(l.source + '>' + l.target); });
      var newKey = new Set();
      newGraph.links.forEach(function (l) { newKey.add(l.source + '>' + l.target); });
      var linkAdded = 0, linkRemoved = 0;
      newKey.forEach(function (k) { if (!oldKey.has(k)) linkAdded++; });
      oldKey.forEach(function (k) { if (!newKey.has(k)) linkRemoved++; });
      graph.links = newGraph.links;

      // 新节点先放到已存在邻居的质心附近（避免从原点飞过来）
      if (added.length) {
        var pos = {};
        graph.nodes.forEach(function (n) { pos[n.id] = [n.x, n.y]; });
        added.forEach(function (n) {
          var sx = 0, sy = 0, c = 0;
          graph.links.forEach(function (l) {
            if (l.source === n.id && pos[l.target]) { sx += pos[l.target][0]; sy += pos[l.target][1]; c++; }
            else if (l.target === n.id && pos[l.source]) { sx += pos[l.source][0]; sy += pos[l.source][1]; c++; }
          });
          if (c) { n.x = sx / c + (Math.random() - 0.5) * 24; n.y = sy / c + (Math.random() - 0.5) * 24; }
          else { n.x = (Math.random() - 0.5) * 160; n.y = (Math.random() - 0.5) * 160; }
          n.vx = 0; n.vy = 0;
        });
      }

      // 开启物理模拟（保留现有坐标）；按变化量决定"点火强度"
      sim = core.createSim(graph.nodes, graph.links, opts);
      var heat = (added.length || removed) ? 0.10     // 节点增删：中等
        : (linkAdded || linkRemoved) ? 0.05           // 连线增删：轻微
          : 0.02;                                     // 其它：只做微扰
      if (sim.setAlpha) sim.setAlpha(heat); else sim.reheat(heat);
      playing = true;
      running = true;
      settledOnce = false;
      autoFitDone = true;
      if (raf == null) kick(); else draw();

      autoFitDone = true;
      draw();
      return { added: added.length, removed: removed, linkAdded: linkAdded, linkRemoved: linkRemoved };
    }

    function setImages(map) {
      if (!map) return;
      map.forEach(function (v, k) { images.set(k, v); });
    }
    function loop() {
      if (!running) return;
      if (!playing) { raf = null; return; }
      if (panning) { raf = requestAnimationFrame(loop); return; }   // 平移中冻结物理
      if (tlp.on) {
        var elapsed = (performance.now() - tlp.t0) / 1000;
        var next = 1 + Math.floor(tlp.speed * elapsed);
        if (next >= tlp.total) {
          tlp.on = false;
          sim = core.createSim(graph.nodes, graph.links, opts);
          sim.reheat(0.5);
          fit();
        } else if (next !== tlp.prog) {
          tlp.prog = next;
          rebuildForProgression();
        }
      }
      sim.step();
      if (!autoFitDone && sim.alphaNow() < 0.02) {
        autoFitDone = true;
        fit();          // 收敛后按真实布局重新框选，避免外围节点跑出画布
      }
      sim.tick();
      draw();
      raf = requestAnimationFrame(loop);
    }

    function kick() {
      if (raf == null && running) raf = requestAnimationFrame(loop);
    }

    /* ---------- 交互 ---------- */
    function localPos(ev) {
      var r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }

        /* 节点在屏幕上的真实绘制尺寸（与 draw() 同一套公式） */
    function nodeScreenSize(n) {
      var z = view.zoom, ns = opts.nodeScale == null ? 1 : opts.nodeScale;
      if (n.kind === 'tag') return { w: Math.max(150 * z, 46), h: Math.max(34 * z, 15) };
      return { w: Math.max(96 * z * ns, 26 * ns), h: Math.max(120 * z * ns, 33 * ns) };
    }

    /* 命中检测：必须是卡片本身，空白处留给平移 */
    function hitTest(px, py) {
      var best = null, bestD = Infinity;
      for (var i = 0; i < graph.nodes.length; i++) {
        var n = graph.nodes[i];
        if (visIds && !visIds.has(n.id)) continue;
        var p = screen(n);
        var s = nodeScreenSize(n);
        if (Math.abs(p.x - px) <= s.w / 2 + 2 && Math.abs(p.y - py) <= s.h / 2 + 2) {
          var d = Math.abs(p.x - px) + Math.abs(p.y - py);
          if (d < bestD) { bestD = d; best = n; }
        }
      }
      return best;
    }

    canvas.addEventListener('mousedown', function (ev) {
      var p = localPos(ev);
      var n = hitTest(p.x, p.y);
      if (n) {
        dragging = { node: n, dx: n.x * view.zoom + view.x - p.x, dy: n.y * view.zoom + view.y - p.y };
        n.fixed = true;
        sim.reheat(0.9);
      } else {
        panning = { x: p.x - view.x, y: p.y - view.y };
      }
      ev.preventDefault();
    });

    canvas.addEventListener('mousemove', function (ev) {
      var p = localPos(ev);
      if (dragging) {
        var nx = (p.x + dragging.dx - view.x) / view.zoom;
        var ny = (p.y + dragging.dy - view.y) / view.zoom;
        dragging.node.x = nx; dragging.node.y = ny; dragging.node.fixed = true;
        sim.reheat(0.35);
        draw();
        return;
      }
      if (panning) {
        view.x = p.x - panning.x; view.y = p.y - panning.y; draw(); return;
      }
      var n = hitTest(p.x, p.y);
      if (n !== hover) {
        hover = n;
        canvas.style.cursor = n ? 'pointer' : 'default';
        if (n) onNodeHover(n); else onNodeHover(null);
        draw();
      }
    });

    window.      window.addEventListener('mouseup', function () {
        canvas.style.cursor = 'default';
        var draggedNode = (dragging && dragging.node) ? dragging.node : null;
        dragging = null;
        panning = null;
        notifyLayout();   // 平移结束：记住镜头
        // 纯平移视角不加热模拟，否则松手后整张图会飘
        if (draggedNode) {
          if (!draggedNode.isolated) draggedNode.fixed = false;
          sim.reheat(0.25);
          kick();
        }
      });

    canvas.addEventListener('dblclick', function (ev) {
      var p = localPos(ev);
      var n = hitTest(p.x, p.y);
      if (n) onNodeClick(n);
    });

    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var p = localPos(ev);
      var before = toWorld(p.x, p.y);
      var factor = Math.exp(-ev.deltaY * 0.0015);
      view.zoom = Math.max(0.05, Math.min(3, view.zoom * factor));
      var after = toWorld(p.x, p.y);
      view.x += (after.x - before.x) * view.zoom;
      view.y += (after.y - before.y) * view.zoom;
      draw();
        notifyLayout();
    }, { passive: false });

    resize();
    playing = true;

    /* 有保存过的布局：原样恢复坐标 + 镜头，不重跑爆炸动画 */
    var restored = false;
    if (cfg.savedLayout) {
      var savedPos = cfg.savedLayout.positions || cfg.savedLayout;
      var anyRestored = false;
      graph.nodes.forEach(function (n) {
        var p = savedPos && savedPos[n.id];
        if (p && isFinite(p[0]) && isFinite(p[1])) { n.x = p[0]; n.y = p[1]; n.vx = 0; n.vy = 0; anyRestored = true; }
      });
      if (anyRestored) {
        sim.stop();
        var sv = cfg.savedLayout.view;
        if (sv && isFinite(sv.zoom) && isFinite(sv.x) && isFinite(sv.y)) {
          view.zoom = sv.zoom; view.x = sv.x; view.y = sv.y;
        } else { fit(); }
        autoFitDone = true;
        restored = true;
        draw();
        // 数据确实变了（不是单纯重渲染）：恢复坐标后把物理打开
        if (cfg.savedLayout.animate) {
          if (sim.setAlpha) sim.setAlpha(0.08); else sim.reheat(0.08);
          playing = true;
          running = true;
          settledOnce = false;
          if (raf == null) kick();
        }
      }
    }
    if (!restored) {
      // 同步预跑：先算出可看的布局并画出来，之后再交给 rAF 继续动画
      sim.setAlpha ? sim.setAlpha(1) : sim.reheat(1);
      for (var pre = 0; pre < 260; pre++) { if (!sim.step()) break; }
      fit();   // 已同步解算完，直接按真实布局框选
      draw();
      kick();
    }

    return {
      view: view,
      sim: sim,
      fit: function () { fit(); draw(); kick(); },
      /* 参数变化：换力参数并开启物理，不重建、不动镜头 */
      applyParams: function (patch) {
        Object.assign(opts, patch || {});
        if (sim && sim.setLinks) sim.setLinks(graph.links);
        sim = core.createSim(graph.nodes, graph.links, opts);
        if (sim.setAlpha) sim.setAlpha(0.35); else sim.reheat(0.35);
        playing = true;
        running = true;
        settledOnce = false;
        autoFitDone = true;
        if (raf == null) kick(); else draw();
      },
      redraw: draw,
      viewState: function () { return { zoom: view.zoom, x: view.x, y: view.y }; },
      stepFrames: function (n) {
        for (var i = 0; i < (n || 1); i++) { if (!sim.step()) break; }
        draw();
      },
      replaceGraph: replaceGraph,
      setImages: setImages,
      setPalette: function (p2) { Object.assign(palette, p2 || {}); draw(); },
      playAnimation: playAnimation,
      playTimelapse: playTimelapse,
      stopTimelapse: stopTimelapse,
      isTimelapsing: function () { return tlp.on; },
      isPlaying: function () { return playing; },
      stats: function () { return { total: dbg.total, drawn: dbg.drawn, culled: dbg.culled, bad: dbg.bad, zoom: view.zoom }; },
      setPlaying: function (v) {
        playing = !!v;
        if (playing) { sim.reheat(0.25); kick(); }
        else if (raf) { cancelAnimationFrame(raf); raf = null; }
      },
      setStyle: function (o) { Object.assign(opts, o || {}); draw(); },
      resize: function () { resize(); draw(); },
      rerun: function () {
        sim = core.createSim(graph.nodes, graph.links, opts);
        if (sim.setAlpha) sim.setAlpha(0.4); else sim.reheat(0.4);   // 参数变了：开启模拟
        playing = true;
        settledOnce = false;
        autoFitDone = true;
        kick();
      },
      setRunning: function (v) { running = v; if (v) kick(); else if (raf) { cancelAnimationFrame(raf); raf = null; } },
      dispose: function () { running = false; if (raf) cancelAnimationFrame(raf); raf = null; },
      positions: function () {
        var o = {};
        graph.nodes.forEach(function (n) { o[n.id] = [Math.round(n.x), Math.round(n.y)]; });
        return o;
      },
      applyPositions: function (pos) {
        var any = false;
        graph.nodes.forEach(function (n) {
          var p = pos && pos[n.id];
          if (p) { n.x = p[0]; n.y = p[1]; n.fixed = false; any = true; }
        });
        if (any) { sim.stop(); fit(); draw(); }
      }
    };
  }

  return { createRenderer: createRenderer, COLORS: COLORS };
});


