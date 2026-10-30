/* matrix-graph Obsidian 集成层（由 build.ps1 拼接进 main.js） */

const VIEW_TYPE = 'matrix-graph-view';


const DEFAULT_OPTS = {
  mode: 'similar',
  threshold: 2,
  topK: 0,
  linkLength: 120,
  repulsion: 1200,
  gravity: 0.0013,
  height: (typeof Platform !== 'undefined' && Platform.isMobile) ? 420 : 560,
  imagePrefix: '',
  tagLabel: '体系',
  elementLabel: '元素',
  orphans: true,
  collideRadius: 76,
  showLabels: true,
  linkMode: 'proportional',
  perTag: 0.035,
  baseStrength: 0.05,
  minAlpha: 0.012,
  nodeScale: 1.16,
  edgeWidth: 1,
  labelAlpha: 0.85,
  attraction: 0.7
};

function cssVar(name, fallback, doc) {
  const d = doc || document;
  const body = d.body || document.body;
  const v = getComputedStyle(body).getPropertyValue(name);
  return (v && v.trim()) || fallback;
}

function parseOptions(parsed) {
  const opts = {};
  // 解析器会把键小写化，这里做不区分大小写的映射（imagePrefix / tagLabel / topK 等驼峰键）
  const lowerMap = {};
  Object.keys(DEFAULT_OPTS).forEach((k) => { lowerMap[k.toLowerCase()] = k; });
  Object.keys(parsed.options || {}).forEach((rawKey) => {
    const key = lowerMap[String(rawKey).toLowerCase()];
    if (!key) return;
    const raw = parsed.options[rawKey];
    opts[key] = (typeof DEFAULT_OPTS[key] === 'number') ? Number(raw) : raw;
  });
  return opts;
}

/* 把一段 matrix-graph 源码挂到任意容器上（行内块 / 独立视图共用） */
class MatrixGraphMount {
  constructor(plugin, app, containerEl, source, sourcePath, override) {
    this.plugin = plugin;
    this.app = app || (plugin && plugin.app) || null;
    this.containerEl = containerEl;
    this.source = source;
    this.sourcePath = sourcePath || '';
    this.override = override || {};
    this.blockIndex = this.override.blockIndex == null ? 0 : this.override.blockIndex;
    this.renderer = null;
    this.disposers = [];
    this.blobUrls = [];
  }

  async mount() {
    if (!this.app || !this.app.vault) {
      this.containerEl.createDiv({ cls: 'matrix-graph-error', text: '内部错误：app 不可用' });
      return;
    }
    const parsed = MatrixCore.parseMatrix(this.source);
    this.parsed = parsed;
    if (parsed.errors.length) {
      this.containerEl.createDiv({ cls: 'matrix-graph-error', text: parsed.errors.join('; ') });
      return;
    }
    const globalDef = Object.assign({}, DEFAULT_OPTS, this.plugin.settings.defaults || {});
    const blockOpts = parseOptions(parsed);
    this.mergedDefaults = Object.assign({}, globalDef, blockOpts);
    const opts = Object.assign({}, this.mergedDefaults, this.override || {});
    var layoutTimer = null;
    const surface = opts.fill ? "view" : "inline";
    var layoutTimer = null;
    const autoSaveLayout = (pos) => {
      if (!pos) return;
      if (layoutTimer) clearTimeout(layoutTimer);
      layoutTimer = setTimeout(async () => {
        const store = this.plugin.settings.layouts = this.plugin.settings.layouts || {};
        const entry = store[this.sourcePath] && store[this.sourcePath].positions ? store[this.sourcePath] : { positions: {}, cams: {} };
        entry.positions = pos;
        entry.hash = String(this.source || '').length + ':' + String(this.source || '').slice(0, 40);
        entry.cams = entry.cams || {};
        if (this.renderer && this.renderer.viewState) entry.cams[surface] = this.renderer.viewState();
        store[this.sourcePath] = entry;
        await this.plugin.saveSettings();
      }, 900);
    };

    const uiKey = this.plugin.cacheKey(this.sourcePath, this.blockIndex);
    this.plugin.migrateLegacyKey(this.sourcePath, this.blockIndex);
    const savedUI = (this.plugin.settings.ui || {})[uiKey];
    if (savedUI) {
      Object.keys(savedUI).forEach((k) => {
        if (k === 'fill' || k === 'height') return;
        opts[k] = savedUI[k];
      });
    }
    this.opts = opts;
    this.uiKey = uiKey;

    const root = this.containerEl.createDiv({ cls: 'matrix-graph' + (opts.fill ? ' matrix-graph-fill' : '') });
    const bar = root.createDiv({ cls: 'matrix-graph-toolbar' });

    // —— 第一行：模式 / 阈值 / 开关 / 按钮 ——
    const modeWrap = bar.createDiv({ cls: 'matrix-graph-field' });
    modeWrap.createSpan({ cls: 'matrix-graph-label', text: '模式' });
    const modeSel = modeWrap.createEl('select', { cls: 'dropdown' });
    modeSel.createEl('option', { value: 'similar', text: opts.elementLabel + '相似（主）' });
    modeSel.createEl('option', { value: 'hub', text: opts.tagLabel + '枢纽' });
    modeSel.value = opts.mode;
    this.ui = this.ui || {}; this.ui.modeSel = modeSel;

    const thrWrap = bar.createDiv({ cls: 'matrix-graph-field' });
    thrWrap.createSpan({ cls: 'matrix-graph-label', text: '共同标签≥' });
    const thr = thrWrap.createEl('input', { type: 'range', cls: 'matrix-graph-range' });
    thr.min = '1'; thr.max = String(Math.max(2, parsed.tags.length)); thr.step = '1';
    thr.value = String(opts.threshold);
    const thrVal = thrWrap.createSpan({ cls: 'matrix-graph-value', text: String(opts.threshold) });
    this.ui.thr = thr; this.ui.thrVal = thrVal;

    const linkWrap = bar.createDiv({ cls: 'matrix-graph-field' });
    linkWrap.createSpan({ cls: 'matrix-graph-label', text: '连接力' });
    const linkSel = linkWrap.createEl('select', { cls: 'dropdown' });
    linkSel.createEl('option', { value: 'equal', text: '等力' });
    linkSel.createEl('option', { value: 'proportional', text: '正比+' });
    linkSel.value = opts.linkMode === 'equal' ? 'equal' : 'proportional';
    this.ui.linkSel = linkSel;
    const orphanWrap = bar.createDiv({ cls: 'matrix-graph-field' });
    const orphanChk = orphanWrap.createEl('input', { type: 'checkbox', cls: 'matrix-graph-check' });
    orphanChk.checked = opts.orphans !== false;
    this.ui.orphanChk = orphanChk;
    orphanWrap.createSpan({ cls: 'matrix-graph-label', text: '孤立聚类' });

    const labelWrap = bar.createDiv({ cls: 'matrix-graph-field' });
    const labelChk = labelWrap.createEl('input', { type: 'checkbox', cls: 'matrix-graph-check' });
    labelChk.checked = opts.showLabels !== false;
    this.ui.labelChk = labelChk;
    labelWrap.createSpan({ cls: 'matrix-graph-label', text: '显示标签' });

    const btnWrap = bar.createDiv({ cls: 'matrix-graph-buttons' });
    const fitBtn = btnWrap.createEl('button', { cls: 'matrix-graph-btn', text: '适应视图' });
    const reloadBtn = btnWrap.createEl('button', { cls: 'matrix-graph-btn', text: '重新布局' });
    const resetBtn = btnWrap.createEl('button', { cls: 'matrix-graph-btn', text: '重置本块' });
    const overrideCountEl = bar.createDiv({ cls: 'matrix-graph-stat' });
    this.overrideCountEl = overrideCountEl;

    // 右上角：动画 + 放大
    const actions = bar.createDiv({ cls: 'matrix-graph-actions' });
    const animBtn = actions.createEl('button', { cls: 'matrix-graph-btn matrix-graph-btn-icon', text: '播放' });
    animBtn.setAttribute('aria-label', '播放/暂停动画');
    const tableBtn = actions.createEl('button', { cls: 'matrix-graph-btn matrix-graph-btn-icon', text: '表格' });
    tableBtn.setAttribute('aria-label', '在矩阵视图里编辑表格');
    const expandBtn = actions.createEl('button', { cls: 'matrix-graph-btn matrix-graph-btn-icon', text: '放大' });
    expandBtn.setAttribute('aria-label', '在独立窗口打开');

    const stat = bar.createDiv({ cls: 'matrix-graph-stat' });

    // —— 折叠面板：受力 / 外观 ——
    const panel = root.createEl('details', { cls: 'matrix-graph-panel' });
    panel.createEl('summary', { cls: 'matrix-graph-summary', text: '受力 / 外观' });
    const grid = panel.createDiv({ cls: 'matrix-graph-panel-grid' });

    const mkSlider = (key, label, min, max, step, initial, isForce) => {
      const wrap = grid.createDiv({ cls: 'matrix-graph-field matrix-graph-field-wide' });
      wrap.createSpan({ cls: 'matrix-graph-label', text: label });
      const el = wrap.createEl('input', { type: 'range', cls: 'matrix-graph-range matrix-graph-range-wide' });
      el.min = String(min); el.max = String(max); el.step = String(step); el.value = String(initial);
      const val = wrap.createSpan({ cls: 'matrix-graph-value', text: String(initial) });
      this.ui = this.ui || {}; (this.ui.sliders = this.ui.sliders || {})[key] = { el: el, label: val };
      el.addEventListener('input', () => {
        const v = Number(el.value);
        val.setText(String(v));
        if (isForce) {
          this.opts[key] = v;
          this.persist();
          this.applyParams({ [key]: v });
        } else if (this.renderer) {
          this.opts[key] = v;
          this.persist();
          this.renderer.setStyle({ [key]: v });
        }
      });
      return el;
    };

    const perTagEl = mkSlider('perTag', '每标签增加力', 0.005, 0.15, 0.005, opts.perTag == null ? 0.035 : opts.perTag, true);
    mkSlider('topK', '每节点连线上限 (0=不限)', 0, 40, 1, opts.topK == null ? 0 : opts.topK, true);
    mkSlider('gravity', '向心力', 0, 0.008, 0.0002, opts.gravity == null ? 0.0016 : opts.gravity, true);
    mkSlider('repulsion', '排斥力', 300, 6000, 100, opts.repulsion == null ? 1200 : opts.repulsion, true);
    mkSlider('attraction', '吸引力', 0.2, 2, 0.05, opts.attraction == null ? 1 : opts.attraction, true);
    mkSlider('linkLength', '连线长度', 60, 400, 10, opts.linkLength == null ? 120 : opts.linkLength, true);
    mkSlider('nodeScale', '节点大小', 0.5, 2, 0.02, opts.nodeScale == null ? 1.16 : opts.nodeScale, false);
    mkSlider('edgeWidth', '连线粗细', 0.5, 4, 0.1, opts.edgeWidth == null ? 1 : opts.edgeWidth, false);
    mkSlider('labelAlpha', '文字透明度', 0, 1, 0.02, opts.labelAlpha == null ? 0.85 : opts.labelAlpha, false);

    let saveTimer = null;
    this.persist = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const diff = {};
        PARAM_KEYS.forEach((k) => {
          if (this.opts[k] !== this.mergedDefaults[k]) diff[k] = this.opts[k];
        });
        this.plugin.settings.ui = this.plugin.settings.ui || {};
        if (Object.keys(diff).length) this.plugin.settings.ui[this.uiKey] = diff;
        else delete this.plugin.settings.ui[this.uiKey];
        if (this.overrideCountEl) {
          const n = Object.keys(diff).length;
          this.overrideCountEl.setText(n ? '覆盖 ' + n + ' 项' : '默认');
        }
        await this.plugin.saveSettings();
        if (this.plugin.broadcastParams) this.plugin.broadcastParams(this.sourcePath, this);
      }, 250);
    };
    const info = root.createDiv({ cls: 'matrix-graph-canvas-wrap' });

    const ownDoc = (this.containerEl && this.containerEl.ownerDocument) || document;
    this.palette = {
      bg: cssVar('--background-primary', '#ffffff', ownDoc),
      text: cssVar('--text-normal', '#333333', ownDoc),
      edge: cssVar('--background-modifier-border', 'rgba(120,130,150,.45)', ownDoc),
      accent: cssVar('--interactive-accent', '#6b8afd', ownDoc),
      muted: cssVar('--text-faint', '#8892a0', ownDoc)
    };

    const cacheKey = this.plugin.cacheKey(this.sourcePath, this.source);
    const saved = (this.plugin.settings.layouts || {})[cacheKey];

    this.rebuild = async (mode, threshold) => {
      const graph = MatrixCore.buildGraph(this.parsed, {
        mode: mode,
        threshold: threshold,
        topK: this.opts.topK,
        orphans: orphanChk.checked
      });
      if (this.renderer) { this.renderer.dispose(); this.renderer = null; }
      info.empty();
      const canvas = info.createEl('canvas', { cls: 'matrix-graph-canvas' });

      let images = new Map();
      try { images = await this.loadImages(graph); }
      catch (e) { console.warn('matrix-graph: 图片加载失败', e); }

      this.renderer = MatrixRenderer.createRenderer({
        core: MatrixCore,
        canvas: canvas,
        holder: info,
        graph: graph,
        images: images,
        options: this.opts,
        palette: this.palette,
        tagOrder: graph.tags || this.parsed.tags,
        savedLayout: (saved && saved.positions) ? { positions: saved.positions, view: (saved.cams || {})[surface] || null, animate: !!(saved.hash && saved.hash !== String(this.source || '').length + ':' + String(this.source || '').slice(0, 40)) } : (saved || null),
        onLayoutChange: autoSaveLayout,
        onNodeClick: (n) => this.openNode(n)
      });

      if (saved && !this.appliedSaved) { this.renderer.applyPositions(saved); this.appliedSaved = true; }
      else { this.renderer.fit(); }

      const tagCount = graph.nodes.filter((n) => n.kind === 'tag').length;
      const elCount = graph.nodes.length - tagCount;
      stat.setText(elCount + ' 节点 · ' + graph.links.length + ' 边 · 卡图 ' + images.size + '/' + elCount);

      if (this.diagEl) { this.diagEl.remove(); this.diagEl = null; }
      if (images.size === 0 && elCount > 0 && (this.opts.imagePrefix || this.parsed.elements.some((e) => e.imageHint))) {
        this.diagEl = info.createDiv({ cls: 'matrix-graph-error' });
        const withHint = this.parsed.elements.filter((e) => e.imageHint).length;
        const first = this.parsed.elements[0] || {};
        const firstPath = first.name
          ? (this.resolveImagePath({ label: first.name, imageHint: first.imageHint || '' }) || '(解析失败)')
          : '?';
        this.diagEl.setText(
          '卡图未加载 ｜ 元素 ' + elCount + ' ｜ 带图片列 ' + withHint +
          ' ｜ imagePrefix=' + (this.opts.imagePrefix || '(空)') +
          ' ｜ 目录索引 ' + (this.imageIndex ? this.imageIndex.size : 0) +
          ' ｜ 全库图片 ' + (this._gIndex ? this._gIndex.size : 0) +
          ' ｜ 首张 ' + (first.name || '?') + ' → ' + firstPath
        );
      }
    };

    modeSel.addEventListener('change', () => { this.opts.mode = modeSel.value; this.persist(); this.regraph(modeSel.value, Number(thr.value)); });
    thr.addEventListener('input', () => {
      thrVal.setText(thr.value);
      this.opts.threshold = Number(thr.value);
      this.persist();
      this.regraph(this.opts.mode, Number(thr.value));
    });
    linkSel.addEventListener('change', () => {
      this.opts.linkMode = linkSel.value;
      this.persist();
      if (this.renderer) this.renderer.rerun();
    });
    orphanChk.addEventListener('change', () => { this.opts.orphans = orphanChk.checked; this.persist(); this.regraph(modeSel.value, Number(thr.value)); });
    labelChk.addEventListener('change', () => {
      this.opts.showLabels = labelChk.checked;
      this.persist();
      if (this.renderer) this.renderer.setStyle({ showLabels: labelChk.checked });
    });
    fitBtn.addEventListener('click', () => { if (this.renderer) this.renderer.fit(); });
    reloadBtn.addEventListener('click', () => {
      if (!this.renderer) return;
      this.renderer.playAnimation();
      animBtn.setText('暂停');
    });
    animBtn.addEventListener('click', () => {
      if (!this.renderer) return;
      if (this.renderer.isTimelapsing()) {
        this.renderer.stopTimelapse();
        animBtn.setText('播放');
      } else {
        this.renderer.playTimelapse();
        animBtn.setText('停止');
        const total = { n: 0 };
        const tick = setInterval(() => {
          if (!this.renderer || !this.renderer.isTimelapsing()) {
            clearInterval(tick);
            animBtn.setText('播放');
          }
        }, 250);
      }
    });
    ;
    resetBtn.addEventListener('click', async () => {
      this.plugin.settings.ui = this.plugin.settings.ui || {};
      delete this.plugin.settings.ui[this.uiKey];
      await this.plugin.saveSettings();
      new Notice('已重置为全局默认');
      if (this.override && this.override.remount) this.override.remount();
    });
    tableBtn.addEventListener('click', () => {
      this.plugin.openMatrix(this.source, this.sourcePath, this.opts.elementLabel + ' × ' + this.opts.tagLabel);
    });
    expandBtn.addEventListener('click', () => {
      this.plugin.openView(this.source, this.sourcePath, this.opts.tagLabel + ' × ' + this.opts.elementLabel, this.opts);
    });

    // 跟随 Obsidian 主题：暗色/亮色切换时重读 CSS 变量
    const refreshPalette = () => {
      const d2 = (this.containerEl && this.containerEl.ownerDocument) || document;
      const p2 = {
        bg: cssVar('--background-primary', '#ffffff', d2),
        text: cssVar('--text-normal', '#333333', d2),
        edge: cssVar('--background-modifier-border', 'rgba(120,130,150,.45)', d2),
        accent: cssVar('--interactive-accent', '#6b8afd', d2),
        muted: cssVar('--text-faint', '#8892a0', d2)
      };
      Object.assign(this.palette, p2);
      if (this.renderer && this.renderer.setPalette) this.renderer.setPalette(p2);
    };
    if (this.plugin && this.plugin.app && this.plugin.app.workspace) {
      const ref = this.plugin.app.workspace.on('css-change', refreshPalette);
      this.disposers.push(() => { try { this.plugin.app.workspace.offref(ref); } catch (e) { } });
    }

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => { if (this.renderer) this.renderer.resize(); });
      ro.observe(info);
      this.disposers.push(() => ro.disconnect());
    }

    await this.rebuild(this.opts.mode, Number(this.opts.threshold));
    this.persist();
  }
  /* 从 data.json 重新读参数并应用（其它视图改了参数时被调用） */
  syncFromSettings() {
    const saved = (this.plugin.settings.ui || {})[this.plugin.cacheKey(this.sourcePath)] || {};
    Object.assign(this.opts, saved);
    const ui = this.ui || {};
    if (ui.modeSel) ui.modeSel.value = this.opts.mode;
    if (ui.thr) ui.thr.value = String(this.opts.threshold);
    if (ui.thrVal) ui.thrVal.setText(String(this.opts.threshold));
    if (ui.linkSel) ui.linkSel.value = this.opts.linkMode === 'equal' ? 'equal' : 'proportional';
    if (ui.orphanChk) ui.orphanChk.checked = this.opts.orphans !== false;
    if (ui.labelChk) ui.labelChk.checked = this.opts.showLabels !== false;
    if (ui.sliders) {
      Object.keys(ui.sliders).forEach((k) => {
        if (this.opts[k] == null) return;
        ui.sliders[k].el.value = String(this.opts[k]);
        ui.sliders[k].label.setText(String(this.opts[k]));
      });
    }
    this.applyParams(this.opts);
    this.regraph(this.opts.mode, Number(this.opts.threshold));
  }
  /* 数据更新：原地增量（不动镜头），并按变化开启物理 */
  async dataReload(source) {
    if (source == null) return;
    this.source = source;
    let parsed;
    try { parsed = MatrixCore.parseMatrix(source); } catch (e) { return; }
    if (!parsed || parsed.errors.length) return;
    this.parsed = parsed;
    if (!this.renderer || !this.renderer.replaceGraph) {
      await this.rebuild(this.opts.mode, Number(this.opts.threshold));
      return;
    }
    const graph = MatrixCore.buildGraph(parsed, {
      mode: this.opts.mode,
      threshold: Number(this.opts.threshold),
      topK: this.opts.topK,
      orphans: this.opts.orphans !== false
    });
    try {
      const imgs = await this.loadImages(graph);
      if (this.renderer.setImages) this.renderer.setImages(imgs);
    } catch (e) { }
    this.renderer.replaceGraph(graph);
  }

  /* 模式/阈值/孤立聚类变化：重算结构，原地替换 */
  async regraph(mode, threshold) {
    if (!this.renderer || !this.renderer.replaceGraph) { await this.rebuild(mode, threshold); return; }
    const graph = MatrixCore.buildGraph(this.parsed, {
      mode: mode, threshold: threshold, topK: this.opts.topK, orphans: this.opts.orphans !== false
    });
    try {
      const imgs = await this.loadImages(graph);
      if (this.renderer.setImages) this.renderer.setImages(imgs);
    } catch (e) { }
    this.renderer.replaceGraph(graph);
  }

  /* 只改参数：不重建渲染器、不动镜头、物理直接开跑 */
  applyParams(patch) {
    if (this.renderer && this.renderer.applyParams) this.renderer.applyParams(patch);
  }
  dispose() {
    if (this.renderer) { this.renderer.dispose(); this.renderer = null; }
    this.disposers.forEach((fn) => { try { fn(); } catch (e) { } });
    this.disposers = [];
    (this.blobUrls || []).forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { } });
    this.blobUrls = [];
  }

  normName(s) {
    return String(s || '').replace(/\([^)]*\)/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  buildImageIndex(prefix) {
    const index = new Map();
    if (!prefix) return index;
    const slash = prefix.lastIndexOf('/');
    const dir = slash >= 0 ? prefix.slice(0, slash) : '';
    const filePart = slash >= 0 ? prefix.slice(slash + 1) : prefix;
    const head = filePart.split('{name}')[0] || '';
    this.imageIndexDir = dir;
    const all = this.app.vault.getFiles ? this.app.vault.getFiles() : [];
    const prefixPath = dir ? dir + '/' : '';
    for (const f of all) {
      if (prefixPath && !f.path.startsWith(prefixPath)) continue;
      if (!/\.(png|jpe?g|webp|gif|avif|svg)$/i.test(f.name)) continue;
      let stem = f.name.replace(/\.[^.]+$/, '');
      if (head && stem.toLowerCase().startsWith(head.toLowerCase())) stem = stem.slice(head.length);
      index.set(this.normName(stem), f.path);
    }
    void ('matrix-graph: 图片索引', index.size, '条，来自', dir, '，卡片数', all.length);
    return index;
  }

  /* 读二进制 -> Blob URL（最稳，不依赖 app:// 编码） */
  async loadImageViaBlob(rel) {
    try {
      if (!this.app.vault.adapter.readBinary) return null;
      const buf = await this.app.vault.adapter.readBinary(rel);
      const ext = String(rel.split('.').pop() || '').toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp'
        : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : 'image/jpeg';
      const url = URL.createObjectURL(new Blob([buf], { type: mime }));
      const img = await new Promise((resolve) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => resolve(null);
        i.src = url;
      });
      if (img) { this.blobUrls.push(url); return img; }
      URL.revokeObjectURL(url);
      return null;
    } catch (e) { return null; }
  }

  /* 依次尝试多种取图 URL 方案，返回第一个加载成功的 Image */
  loadImageFrom(rel) {
    const adapter = this.app.vault.adapter;
    const urls = [];
    try { if (adapter.getResourcePath) urls.push(adapter.getResourcePath(rel)); } catch (e) { }
    try {
      const base = adapter.getBasePath ? adapter.getBasePath() : '';
      if (base) {
        const abs = (base.replace(/\\/g, '/') + '/' + rel).replace(/\/+/g, '/');
        if (adapter.getResourcePath) { try { urls.push(adapter.getResourcePath(abs)); } catch (e) { } }
        urls.push('app://local/' + encodeURI(abs));
      }
    } catch (e) { }
    urls.push('app://local/' + encodeURI(rel));
    const uniq = urls.filter((u, i) => u && urls.indexOf(u) === i);
    return new Promise((resolve) => {
      let i = 0;
      const tryNext = () => {
        if (i >= uniq.length) { console.warn('matrix-graph: 图片加载失败', rel, uniq); resolve(null); return; }
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => { i++; tryNext(); };
        img.src = uniq[i];
      };
      tryNext();
    });
  }

  /* 全库图片按归一化文件名建索引（懒加载，只建一次） */
  globalImageIndex() {
    if (this._gIndex) return this._gIndex;
    const idx = new Map();
    const all = this.app.vault.getFiles ? this.app.vault.getFiles() : [];
    for (const f of all) {
      if (!/\.(png|jpe?g|webp|gif|avif|svg)$/i.test(f.name)) continue;
      const stem = f.name.replace(/\.[^.]+$/, '');
      const key = this.normName(stem);
      if (!idx.has(key)) idx.set(key, f.path);
      // 去掉 StS2_<颜色>- 前缀再索引一次，跨前缀（Colorless/Curse/Quest）也能命中
      const short = stem.replace(/^StS2_[^-]+-/, '');
      const key2 = this.normName(short);
      if (key2 && !idx.has(key2)) idx.set(key2, f.path);
    }
    this._gIndex = idx;
    void ('matrix-graph: 全库图片索引', idx.size, '条 / 文件总数', all.length);
    return idx;
  }

  resolveImagePath(node) {
    if (node.imageHint) {
      const dest = this.app.metadataCache.getFirstLinkpathDest(node.imageHint, this.sourcePath);
      if (dest) return dest.path;
      const direct = this.app.vault.getAbstractFileByPath(node.imageHint);
      if (direct) return direct.path;
    }
    const prefix = this.opts.imagePrefix;
    if (!prefix) return null;
    if (!this.imageIndex || this.imageIndexKey !== prefix) {
      this.imageIndex = this.buildImageIndex(prefix);
      this.imageIndexKey = prefix;
    }
    const hit = this.imageIndex.get(this.normName(node.label));
    if (hit) return hit;
    const cands = [
      prefix.replace('{name}', node.label),
      prefix.replace('{name}', node.label.replace(/ /g, '')),
      prefix.replace('{name}', node.label.replace(/ /g, '_'))
    ];
    for (const c of cands) {
      const f = this.app.vault.getAbstractFileByPath(c);
      if (f instanceof TFile) return f.path;
    }
    // 最终兜底：全库按「归一化文件名」找
    const g = this.globalImageIndex();
    const byName = g.get(this.normName(node.label));
    if (byName) return byName;
    return null;
  }

  async loadImages(graph) {
    // 图片缓存：只加载新出现的节点，避免每次更新都重新解码导致闪白
    if (!this.imageCache) this.imageCache = new Map();
    const map = new Map();
    const els = graph.nodes.filter((n) => n.kind === 'element');
    const todo = [];
    els.forEach((n) => {
      const cached = this.imageCache.get(n.id);
      if (cached) map.set(n.id, cached); else todo.push(n);
    });
    await Promise.all(todo.map((n) => new Promise((resolve) => {
      const rel = this.resolveImagePath(n);
      if (!rel) return resolve();
      return this.loadImageViaBlob(rel).then((img) => {
        if (img) { map.set(n.id, img); this.imageCache.set(n.id, img); }
        resolve();
      });
    })));
    return map;
  }

  openNode(n) {
    const dest = this.app.metadataCache.getFirstLinkpathDest(n.label, this.sourcePath);
    if (dest) this.app.workspace.getLeaf(false).openFile(dest);
    else new Notice('找不到笔记：' + n.label);
  }
}

/* ---------------- 行内代码块 ---------------- */

  class MatrixGraphBlock extends MarkdownRenderChild {
    constructor(plugin, containerEl, source, ctx) {
      super(containerEl);
      this.plugin = plugin;
      this.source = source;
      this.ctx = ctx;
      this.sourcePath = (ctx && ctx.sourcePath) || '';
      this.mount = null;
    }

    async onload() {
      const build = async () => {
        if (this.mount) { this.mount.dispose(); this.mount = null; }
        this.containerEl.empty();
        this.mount = new MatrixGraphMount(this.plugin, this.plugin.app, this.containerEl, this.source, this.sourcePath, { remount: build });
        await this.mount.mount();
      };
      this._rebuild = build;
      if (this.plugin.graphBlocks) this.plugin.graphBlocks.add(this);
      await build();
    }

    /* 内容被矩阵视图改掉时调用 */
    async reloadWith(source) {
      if (source == null || source === this.source) return;
      this.source = source;
      if (this.mount && this.mount.dataReload) {
        try { await this.mount.dataReload(source); return; } catch (e) { console.error("matrix-graph: 热更新失败", e); }
      }
      if (this._rebuild) { try { await this._rebuild(); } catch (e) { } }
    }

    onunload() {
      if (this.plugin.graphBlocks) this.plugin.graphBlocks.delete(this);
      if (this.mount) { this.mount.dispose(); this.mount = null; }
    }
  }

/* ---------------- 独立视图（整窗） ---------------- */

class MatrixGraphView extends ItemView {
  constructor(leaf, plugin, source, sourcePath, title) {
    super(leaf);
    this.plugin = plugin;
    this.source = source || '';
    this.sourcePath = sourcePath || '';
    this.title = title || '矩阵图谱';
    this.mount = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.title; }
  getIcon() { return 'git-fork'; }

  async render() {
    if (this.mount) { this.mount.dispose(); this.mount = null; }
    this.contentEl.empty();
    if (!this.source) {
      this.contentEl.createDiv({ cls: 'matrix-graph-error', text: '没有可用的矩阵数据：请从含 matrix-graph 代码块的笔记里点「放大」。' });
      return;
    }
    const remount = () => this.render();
    this.mount = new MatrixGraphMount(
      this.plugin, this.plugin.app, this.contentEl, this.source, this.sourcePath,
      Object.assign({ fill: true, height: 0, remount: remount, blockIndex: this.blockIndex || 0 }, this.extraOpts || {})
    );
    try { await this.mount.mount(); }
    catch (e) {
      console.error('matrix-graph: 视图渲染失败', e);
      this.contentEl.createDiv({ cls: 'matrix-graph-error', text: '渲染失败: ' + e.message });
    }
  }

  /* 笔记内容被矩阵视图改写时，重建整张图 */
    async reloadWith(source) {
      if (source == null || source === this.source) return;
      this.source = source;
      if (this.mount && this.mount.dataReload) {
        try { await this.mount.dataReload(source); return; } catch (e) { }
      }
      try { await this.render(); } catch (e) { }
    }

  async onOpen() {
    this.contentEl.addClass('matrix-graph-view');
    await this.render();
  }

  async onClose() { if (this.mount) { this.mount.dispose(); this.mount = null; } }
}

/* ---------------- 插件 ---------------- */

function extractFirstBlock(text) {
  const m = String(text || '').match(/```matrix-graph[^\n]*\n([\s\S]*?)\n```/);
  return m ? m[1] : null;
}

class MatrixGraphPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({ layouts: {}, ui: {} }, await this.loadData());
    this.graphBlocks = new Set();

    this.registerView(VIEW_TYPE, (leaf) => new MatrixGraphView(leaf, this, '', '', '矩阵图谱'));
    this.registerView(MATRIX_VIEW, (leaf) => new MatrixTableView(leaf, this, '', '', '矩阵视图'));

    this.registerMarkdownCodeBlockProcessor('matrix-graph', (source, el, ctx) => {
      ctx.addChild(new MatrixGraphBlock(this, el, source, ctx));
    });

    this.addRibbonIcon('git-fork', '新建矩阵图谱笔记', () => this.createMatrixNote());

    this.addCommand({
      id: 'open-matrix-table-view',
      name: '打开矩阵视图（表格编辑）',
      callback: () => this.openMatrixFromActive()
    });

    this.addCommand({
      id: 'open-matrix-graph-view',
      name: '打开矩阵图谱（整窗）',
      callback: () => this.openViewFromActive()
    });

    this.addCommand({
      id: 'insert-matrix-graph',
      name: '插入 matrix-graph 代码块',
      editorCallback: (editor) => {
        editor.replaceSelection('```matrix-graph\nmode: hub\nimagePrefix: \n| 元素 | 图片 | 标签A | 标签B |\n|---|---|---|---|\n| 项目1 |  | ✓ |  |\n```\n');
      }
    });

    this.addSettingTab(new MatrixGraphSettingTab(this.app, this));
    if (this.app.vault.on) this.registerEvent(this.app.vault.on('modify', (file) => {
      if (!file || !file.path) return;
      clearTimeout(this._modifyTimer);
      this._modifyTimer = setTimeout(async () => {
        try {
          const text = await this.app.vault.cachedRead(file);
          const block = extractFirstBlock(text);
          if (block) this.broadcastMatrixUpdate(file.path, block);
        } catch (e) { }
      }, 350);
    }));

    void ('matrix-graph: loaded');
  }

  async openView(source, sourcePath, title, extraOpts, blockIndex) {
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    const view = leaf.view;
    if (view instanceof MatrixGraphView) {
      view.source = source;
      view.sourcePath = sourcePath || '';
      view.title = title || '矩阵图谱';
      view.contentEl.empty();
      view.contentEl.removeClass('matrix-graph-view-error');
      if (view.mount) { view.mount.dispose(); view.mount = null; }
      view.extraOpts = extraOpts || null;
      await view.render();
    }
  }

  /* 新建一个独立笔记，内含 matrix-graph 代码块；可在其它笔记里用 ![[文件名]] 嵌入，渲染与行内一致 */
  async createMatrixNote() {
    const folder = this.app.workspace.getActiveFile()
      ? (this.app.workspace.getActiveFile().parent ? this.app.workspace.getActiveFile().parent.path : '')
      : '';
    let base = '矩阵图谱';
    let path = normalizePath((folder ? folder + '/' : '') + base + '.md');
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath((folder ? folder + '/' : '') + base + ' ' + (++i) + '.md');
    }
    const body = [
      '---',
      'tags:',
      '  - matrix-graph',
      '---',
      '',
      '# 矩阵图谱',
      '',
      '> 这个笔记里的 matrix-graph 代码块可以直接编辑；也可以在其它笔记里用 ![[文件名]] 嵌入，渲染效果与行内图谱一致。',
      '',
      '```matrix-graph',
      'mode: similar',
      'height: 560',
      'threshold: 2',
      '| 元素 | 体系A | 体系B | 体系C |',
      '|---|---|---|---|',
      '| 项目1 | ✓ |  | ✓ |',
      '| 项目2 |  | ✓ | ✓ |',
      '| 项目3 | ✓ |  |  |',
      '```',
      ''
    ].join('\n');
    const file = await this.app.vault.create(path, body);
    await this.app.workspace.getLeaf(true).openFile(file);
    new Notice('已创建 ' + file.basename);
    return file;
  }

  async openMatrix(source, sourcePath, title) {
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: MATRIX_VIEW, active: true });
    const view = leaf.view;
    if (view instanceof MatrixTableView) {
      view.source = source;
      view.sourcePath = sourcePath || '';
      view.title = title || '矩阵视图';
      await view.render();
    }
  }

  async openMatrixFromActive() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice('请先打开一个含 matrix-graph 的笔记'); return; }
    const text = await this.app.vault.cachedRead(file);
    const block = extractFirstBlock(text);
    if (!block) { new Notice('当前笔记里没有 matrix-graph 代码块'); return; }
    await this.openMatrix(block, file.path, file.basename + ' · 矩阵');
  }

  async openViewFromActive() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice('请先打开一个含 matrix-graph 的笔记'); return; }
    const text = await this.app.vault.cachedRead(file);
    const block = extractFirstBlock(text);
    if (!block) { new Notice('当前笔记里没有 matrix-graph 代码块'); return; }
    await this.openView(block, file.path, file.basename, null);
  }

  /* 把新内容推给所有相关视图与行内块 */
  broadcastMatrixUpdate(path, source) {
    if (path == null) return;
    try {
      this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
        const v = leaf.view;
        if (v && v.sourcePath === path && typeof v.reloadWith === 'function') v.reloadWith(source);
      });
    } catch (e) { }
    (this.graphBlocks || new Set()).forEach((b) => {
      if (b && b.sourcePath === path && typeof b.reloadWith === 'function') b.reloadWith(source);
    });
  }

  /* 参数变更 → 通知同笔记的其它视图/行内块 */
  broadcastParams(path, origin) {
    if (!path) return;
    try {
      this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
        const v = leaf.view;
        if (v && v.sourcePath === path && v !== origin && v.mount && v.mount.syncFromSettings) v.mount.syncFromSettings();
      });
    } catch (e) { }
    (this.graphBlocks || new Set()).forEach((b) => {
      if (b && b.sourcePath === path && b !== origin && b.mount && b.mount.syncFromSettings) b.mount.syncFromSettings();
    });
  }
  async saveSettings() { await this.saveData(this.settings); }

    /* 稳定 key：笔记路径 + 该块在文件里的序号（内容怎么改都不变） */
    /* 稳定 key：只按笔记路径。块序号/内容都不参与，永远不会因为重排或改内容而丢设置 */
    cacheKey(path) {
      return path || "(untitled)";
    }

    /* 把历史上所有形态的 key（路径#哈希、路径#bN）合并进 路径 */
    migrateLegacyKey(path) {
      if (!path) return;
      let changed = false;
      ["ui", "layouts"].forEach((section) => {
        const store = this.settings[section] || (this.settings[section] = {});
        const target = Object.assign({}, store[path] || {});
        Object.keys(store).forEach((k) => {
          if (k !== path && k.indexOf(path + "#") === 0) {
            Object.assign(target, store[k]);
            delete store[k];
            changed = true;
          }
        });
        if (Object.keys(target).length) store[path] = target;
      });
      if (changed) this.saveSettings();
    }

  }

module.exports = MatrixGraphPlugin;
