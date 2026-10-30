/* matrix-graph 矩阵视图：表格编辑 + 元数据（拼接进 main.js） */

/* ---------------- 模型与序列化 ---------------- */

function parseMatrixBlock(source) {
  const parsed = MatrixCore.parseMatrix(source);
  const rows = parsed.elements.map((el) => ({
    name: el.name,
    imageHint: el.imageHint || '',
    cells: el.flags.map(Boolean)
  }));
  const options = {};
  Object.keys(parsed.options || {}).forEach((k) => { options[k] = parsed.options[k]; });
  return { tags: parsed.tags.slice(), rows: rows, options: options, errors: parsed.errors };
}

function serializeMatrixBlock(model) {
  const lines = [];
  const optOrder = ['mode', 'threshold', 'linkMode', 'perTag', 'linkLength', 'repulsion', 'gravity', 'attraction',
    'nodeScale', 'edgeWidth', 'labelAlpha', 'orphans', 'showLabels', 'elementLabel', 'tagLabel', 'imagePrefix', 'height'];
  const seen = new Set();
  optOrder.forEach((k) => {
    if (model.options[k] !== undefined && model.options[k] !== '') { lines.push(k + ': ' + model.options[k]); seen.add(k); }
  });
  Object.keys(model.options).forEach((k) => {
    if (!seen.has(k) && model.options[k] !== undefined && model.options[k] !== '') { lines.push(k + ': ' + model.options[k]); }
  });
  const withImage = model.rows.some((r) => r.imageHint);
  lines.push('| 卡牌 |' + (withImage ? ' 图片 |' : '') + ' ' + model.tags.join(' | ') + ' |');
  lines.push('|' + '---|'.repeat(model.tags.length + (withImage ? 2 : 1)));
  model.rows.forEach((r) => {
    const cells = model.tags.map((t, i) => (r.cells[i] ? '✓' : ''));
    const img = withImage ? (r.imageHint ? ' ' + r.imageHint + ' |' : '  |') : '';
    lines.push('| ' + r.name + ' |' + img + ' ' + cells.join(' | ') + ' |');
  });
  return lines.join('\n');
}

function isTruthyCell(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return false;
  return /^(✓|✔|v|y|yes|true|1|x|on|是|√)$/i.test(v);
}

/* ---------------- 表格 ---------------- */

function buildMatrixTable(container, model, hooks) {
  hooks = hooks || {};
  const onChange = hooks.onChange || function () { };
  // 选区在重建之间保持（否则每点一次格子选区就没了）
  const sel = (container.__mgSel && container.__mgSel.anchor) ? container.__mgSel : { anchor: null, focus: null };
  container.__mgSel = sel;
  if (sel.anchor) {
    sel.anchor.r = Math.min(sel.anchor.r, model.rows.length - 1);
    sel.focus.r = Math.min(sel.focus.r, model.rows.length - 1);
    sel.anchor.c = Math.min(sel.anchor.c, model.tags.length - 1);
    sel.focus.c = Math.min(sel.focus.c, model.tags.length - 1);
  }

  const widths = container.__mgColWidths || (container.__mgColWidths = { name: 220, image: 150, tags: {} });
  let resizing = false;

  container.empty();
  const wrap = container.createDiv({ cls: 'mg-table-wrap' });
  wrap.tabIndex = 0;
  const table = wrap.createEl('table', { cls: 'mg-table' });
  const showImageCol = model.rows.some((r) => r.imageHint) || !!hooks.forceImageCol;

  /* ---------- 选区 ---------- */
  function rangeOf() {
    if (!sel.anchor || !sel.focus) return null;
    return {
      r0: Math.min(sel.anchor.r, sel.focus.r), r1: Math.max(sel.anchor.r, sel.focus.r),
      c0: Math.min(sel.anchor.c, sel.focus.c), c1: Math.max(sel.anchor.c, sel.focus.c)
    };
  }
  function cellInRange(r, c) {
    const g = rangeOf();
    return !!g && r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;
  }

  /* ---------- 拖拽排序 ---------- */
  let drag = null, ghost = null, dropTarget = null;
  function clearDropMark() {
    if (dropTarget) { dropTarget.classList.remove('mg-drop-before', 'mg-drop-after'); dropTarget = null; }
  }
  /* 按下后位移超过 4px 才进入拖拽；不移动则当作点击（选择行/列） */
  function startPress(ev, type, index, onTap) {
    if (ev.button !== 0) return;
    if (ev.target.closest && ev.target.closest('.mg-col-resizer')) return;
    const sx = ev.clientX, sy = ev.clientY;
    let started = false;
    const onMove = (e2) => {
      if (started) return;
      if (Math.abs(e2.clientX - sx) > 4 || Math.abs(e2.clientY - sy) > 4) {
        started = true;
        beginDrag(e2, type, index);
      }
    };
    const onUp = (e2) => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (!started && onTap) onTap(e2);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  function beginDrag(ev, type, index) {
    if (drag) return;
    if (!ev || !ev.clientX) ev = { clientX: 0, clientY: 0 };
    drag = { type, index };
    ghost = document.createElement('div');
    ghost.className = 'mg-drag-ghost';
    ghost.textContent = type === 'row' ? model.rows[index].name : model.tags[index];
    document.body.appendChild(ghost);
    moveGhost(ev);
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd, { once: true });
    document.body.classList.add('mg-dragging');
  }
  function moveGhost(ev) { if (ghost) { ghost.style.left = ev.clientX + 12 + 'px'; ghost.style.top = ev.clientY + 12 + 'px'; } }
  function onDragMove(ev) {
    if (!drag) return;
    moveGhost(ev); clearDropMark();
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el) return;
    if (drag.type === 'row') {
      const tr = el.closest('tr.mg-tr'); if (!tr) return;
      const r = Number(tr.dataset.row); if (Number.isNaN(r)) return;
      tr.classList.add(r > drag.index ? 'mg-drop-after' : 'mg-drop-before'); dropTarget = tr;
    } else {
      const th = el.closest('th.mg-th-tag'); if (!th) return;
      const c = Number(th.dataset.col); if (Number.isNaN(c)) return;
      th.classList.add(c > drag.index ? 'mg-drop-after' : 'mg-drop-before'); dropTarget = th;
    }
  }
  function onDragEnd(ev) {
    document.removeEventListener('pointermove', onDragMove);
    clearDropMark();
    if (ghost) { ghost.remove(); ghost = null; }
    document.body.classList.remove('mg-dragging');
    if (!drag) return;
    const d = drag; drag = null;
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el) return;
    if (d.type === 'row') {
      const tr = el.closest('tr.mg-tr'); if (!tr) return;
      let to = Number(tr.dataset.row); if (Number.isNaN(to) || to === d.index) return;
      const [row] = model.rows.splice(d.index, 1);
      if (d.index < to) to -= 1;
      model.rows.splice(to, 0, row);
    } else {
      const th = el.closest('th.mg-th-tag'); if (!th) return;
      let to = Number(th.dataset.col); if (Number.isNaN(to) || to === d.index) return;
      const [tag] = model.tags.splice(d.index, 1);
      model.rows.forEach((r) => { const [cell] = r.cells.splice(d.index, 1); r.cells.splice(to, 0, cell); });
      if (d.index < to) to -= 1;
      model.tags.splice(to, 0, tag);
    }
    onChange(); render();
  }

  /* ---------- 结构操作 ---------- */
  function addRow(at) { model.rows.splice(at, 0, { name: '新卡牌', imageHint: '', cells: model.tags.map(() => false) }); onChange(); render(); }
  function addCol(at) { model.tags.splice(at, 0, '新体系'); model.rows.forEach((r) => r.cells.splice(at, 0, false)); onChange(); render(); }
  function moveRow(from, to) { if (to < 0 || to >= model.rows.length) return; const [r] = model.rows.splice(from, 1); model.rows.splice(to, 0, r); onChange(); render(); }
  function moveCol(from, to) {
    if (to < 0 || to >= model.tags.length) return;
    const [t] = model.tags.splice(from, 1);
    model.rows.forEach((r) => { const [c] = r.cells.splice(from, 1); r.cells.splice(to, 0, c); });
    model.tags.splice(to, 0, t);
    onChange(); render();
  }
  function delRows(idxs) { [...idxs].sort((a, b) => b - a).forEach((i) => model.rows.splice(i, 1)); sel.anchor = sel.focus = null; onChange(); render(); }
  function delCols(idxs) { [...idxs].sort((a, b) => b - a).forEach((i) => { model.tags.splice(i, 1); model.rows.forEach((r) => r.cells.splice(i, 1)); }); sel.anchor = sel.focus = null; onChange(); render(); }

  function setCell(r, c, val) {
    if (!model.rows[r] || c < 0) return;
    while (model.rows[r].cells.length <= c) model.rows[r].cells.push(false);
    model.rows[r].cells[c] = !!val;
  }

  /* ---------- 批量：矩形选区切换 ---------- */
  function toggleRange(value) {
    const g = rangeOf();
    if (!g) return;
    const v = value == null ? !model.rows[g.r0].cells[g.c0] : value;
    for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) setCell(r, c, v);
    onChange(); render();
  }

  /* ---------- 粘贴 TSV ---------- */
  function pasteTSV(text) {
    const rowsIn = text.replace(/\r/g, '').split('\n').filter((l) => l.trim().length > 0);
    if (!rowsIn.length) return;
    const grid = rowsIn.map((l) => l.split('\t'));
    const start = sel.anchor || { r: 0, c: 0 };
    const needRows = start.r + grid.length;
    while (model.rows.length < needRows) {
      model.rows.push({ name: '新卡牌 ' + (model.rows.length + 1), imageHint: '', cells: model.tags.map(() => false) });
    }
    const maxCols = Math.max(...grid.map((g) => g.length));
    while (model.tags.length < start.c + maxCols) addColSilent();
    grid.forEach((line, i) => line.forEach((raw, j) => setCell(start.r + i, start.c + j, isTruthyCell(raw))));
    function addColSilent() { model.tags.push('新体系'); model.rows.forEach((r) => r.cells.push(false)); }
    onChange(); render();
  }
  container.__mgPaste = pasteTSV;

  container.__mgApi = {
    model, sel, addRow, addCol, moveRow, moveCol, delRows, delCols,
    toggleRange, pasteTSV, rangeOf, beginColumnEdit, render: () => render()
  };

  /* ---------- 列宽 ---------- */
  function applyWidths() {
    if (!colgroup || !table) return;
    // 固定布局 + 显式总宽，colgroup 的宽度才会被真正采用
    table.style.tableLayout = 'fixed';
    let total = widths.name + (showImageCol ? widths.image : 0);
    model.tags.forEach((t, i) => { total += (widths.tags[i] || 64); });
    table.style.width = total + 'px';
    table.style.minWidth = total + 'px';

    const cols = colgroup.children;
    if (cols[0]) cols[0].style.width = widths.name + 'px';
    let offset = 1;
    if (showImageCol) { if (cols[1]) cols[1].style.width = widths.image + 'px'; offset = 2; }
    model.tags.forEach((t, i) => {
      const el = cols[offset + i];
      if (el) el.style.width = (widths.tags[i] || 64) + 'px';
    });
  }

  /* 给任意表头单元格挂列宽拖拽器：getW/setW 决定改哪一列 */
  function attachResizer(th, getW, setW, label) {
    const rz = th.createDiv({ cls: 'mg-col-resizer' });
    rz.setAttribute('aria-label', label || '拖动调整列宽，双击复位');
    const beginResize = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      if (resizing) return;            // 同一次按下只允许一个调宽会话
      resizing = true;
      const startX = ev.clientX;
      const startW = Math.round(getW() || th.getBoundingClientRect().width);
      const tblRect = table.getBoundingClientRect();

      // 跟手线：鼠标在哪，线就在哪（不受表格重排影响）
      const guide = document.createElement('div');
      guide.className = 'mg-col-guide';
      guide.style.left = ev.clientX + 'px';
      guide.style.top = tblRect.top + 'px';
      guide.style.height = tblRect.height + 'px';
      document.body.appendChild(guide);
      document.body.classList.add('mg-col-resizing');

      let pending = null, raf = null;
      const flush = () => {
        raf = null;
        if (pending == null) return;
        setW(pending); pending = null;
        applyWidths();
      };
      const onMove = (e2) => {
        guide.style.left = e2.clientX + 'px';               // 立即跟手
        pending = Math.max(36, Math.round(startW + (e2.clientX - startX)));
        if (raf == null) raf = requestAnimationFrame(flush); // 每帧最多改一次宽
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        if (raf != null) { cancelAnimationFrame(raf); flush(); }
        guide.remove();
        document.body.classList.remove('mg-col-resizing');
        resizing = false;
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp, { once: true });
    };
    rz.addEventListener('pointerdown', beginResize);
    rz.addEventListener('dblclick', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      setW(64);
      applyWidths();
    });
    return { el: rz, beginResize: beginResize };
  }

  const colgroup = table.createEl('colgroup');
  colgroup.createEl('col');
  if (showImageCol) colgroup.createEl('col');
  model.tags.forEach(() => colgroup.createEl('col'));

  /* ---------- 表头 ---------- */
  const thead = table.createEl('thead');
  const htr = thead.createEl('tr');
  const cornerTh = htr.createEl('th', { cls: 'mg-th mg-th-corner', text: '卡牌 / 体系' });
  const cornerCtl = attachResizer(cornerTh, () => widths.name, (w) => { widths.name = w; }, '拖动调整第一列宽度');
  cornerTh.addEventListener('pointerdown', (e) => {
    const r = cornerTh.getBoundingClientRect();
    if (e.clientX > r.right - 12) { cornerCtl.beginResize(e); }
  });

  if (showImageCol) {
    const th = htr.createEl('th', { cls: 'mg-th mg-th-image', text: '图片' });
    const imgCtl = attachResizer(th, () => widths.image, (w) => { widths.image = w; }, '拖动调整图片列宽度');
    th.addEventListener('pointerdown', (e) => {
      const r = th.getBoundingClientRect();
      if (e.clientX > r.right - 12) { imgCtl.beginResize(e); }
    });
    th.addEventListener('contextmenu', (e) => { e.preventDefault(); if (hooks.onColumnMenu) hooks.onColumnMenu(e, -2, container.__mgApi); });
  }

  const colHeaderEls = {};

  /* 列名重命名：内联输入框（Electron 不支持 window.prompt） */
  function beginColumnEdit(ci) {
    const th = colHeaderEls[ci];
    if (!th) return;
    const label = th.querySelector(".mg-th-text");
    if (!label) return;
    const input = document.createElement("input");
    input.className = "mg-col-input";
    input.value = model.tags[ci] || "";
    label.replaceWith(input);
    input.focus(); input.select();
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    let done = false;
    const commit = () => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (v && v !== model.tags[ci]) { model.tags[ci] = v; onChange(); }
      render();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); done = true; render(); }
    });
  }

  model.tags.forEach((tag, ci) => {
    const th = htr.createEl('th', { cls: 'mg-th mg-th-tag' });
    th.dataset.col = String(ci);
    colHeaderEls[ci] = th;
    th.createSpan({ cls: 'mg-drag-handle', text: '⠿' });
    const thText = th.createSpan({ cls: 'mg-th-text', text: tag });
    let resizeCtl = null;
    th.addEventListener('pointerdown', (e) => {
      const r = th.getBoundingClientRect();
      if (e.clientX > r.right - 12 && resizeCtl) {          // 贴近右边缘 = 调宽
        resizeCtl.beginResize(e);
        return;
      }
      startPress(e, 'col', ci, (e2) => selectColumn(ci, e2.ctrlKey || e2.metaKey));
      e.preventDefault();
    }, true);   // capture：先于 resizer 的冒泡监听判断一次，由 resizing 锁防重复
    th.addEventListener('dblclick', (e) => {
      e.preventDefault();
      beginColumnEdit(ci);
    });
    th.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!selectedCols().has(ci)) { sel.anchor = { r: 0, c: ci }; sel.focus = { r: model.rows.length - 1, c: ci }; paintSelection(); }
      if (hooks.onColumnMenu) hooks.onColumnMenu(e, ci, container.__mgApi);
    });
    resizeCtl = attachResizer(th, () => widths.tags[ci], (w) => { widths.tags[ci] = w; }, '拖动调整本列宽度');
  });

  /* ---------- 表体 ---------- */
  const tbody = table.createEl('tbody');
  model.rows.forEach((row, ri) => {
    const tr = tbody.createEl('tr', { cls: 'mg-tr' + (ri % 2 ? ' mg-tr-alt' : '') });
    tr.dataset.row = String(ri);

    const nameTd = tr.createEl('td', { cls: 'mg-td mg-td-name' });
    nameTd.createSpan({ cls: 'mg-drag-handle', text: '⠿' });
    nameTd.createSpan({ cls: 'mg-name', text: row.name });
    nameTd.addEventListener('pointerdown', (e) => {
      startPress(e, 'row', ri, (e2) => selectRow(ri, e2.ctrlKey || e2.metaKey));
    });
    nameTd.addEventListener('dblclick', () => {
      const input = document.createElement('input');
      input.value = row.name; input.className = 'mg-name-input';
      nameTd.empty(); nameTd.appendChild(input); input.focus(); input.select();
      const commit = () => { row.name = input.value.trim() || row.name; onChange(); render(); };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') render(); });
    });

    nameTd.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!selectedRows().has(ri)) { sel.anchor = { r: ri, c: 0 }; sel.focus = { r: ri, c: model.tags.length - 1 }; paintSelection(); }
      if (hooks.onRowMenu) hooks.onRowMenu(e, ri, container.__mgApi);
    });

    if (showImageCol) {
      const td = tr.createEl('td', { cls: 'mg-td mg-td-image' });
      const input = td.createEl('input', { type: 'text', cls: 'mg-image-input' });
      input.value = row.imageHint;
      input.placeholder = '卡图/图标';
      input.addEventListener('change', () => { row.imageHint = input.value.trim(); onChange(); });
    }

    model.tags.forEach((tag, ci) => {
      const td = tr.createEl('td', {
        cls: 'mg-td mg-td-cell' + (row.cells[ci] ? ' is-on' : ''),
        attr: { tabindex: ri === 0 && ci === 0 ? '0' : '-1', 'data-r': String(ri), 'data-c': String(ci) }
      });
      if (row.cells[ci]) td.setText('✓');

      td.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.shiftKey && sel.anchor) { sel.focus = { r: ri, c: ci }; paintSelection(); return; }
        const sx = e.clientX, sy = e.clientY;
        let moved = false;
        sel.anchor = { r: ri, c: ci };
        sel.focus = { r: ri, c: ci };
        paintSelection();
        const onMove = (ev) => {
          if (Math.abs(ev.clientX - sx) > 4 || Math.abs(ev.clientY - sy) > 4) moved = true;
          const el = document.elementFromPoint(ev.clientX, ev.clientY);
          const cell = el && el.closest ? el.closest('td.mg-td-cell') : null;
          if (cell) {
            sel.focus = { r: Number(cell.dataset.r), c: Number(cell.dataset.c) };
            paintSelection();
          }
        };
        const onUp = () => {
          document.removeEventListener('pointermove', onMove);
          if (!moved) { row.cells[ci] = !row.cells[ci]; onChange(); render(); }
          else if (hooks.onSelectionChange) hooks.onSelectionChange(sel);
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp, { once: true });
        e.preventDefault();
      });

      td.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleRange(); return; }
        const mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
        if (mv) {
          e.preventDefault();
          const next = table.querySelector('td.mg-td-cell[data-r="' + (ri + mv[0]) + '"][data-c="' + (ci + mv[1]) + '"]');
          if (next) focusCell(next);
        }
        if (e.key === 'Tab') {
          const all = [...table.querySelectorAll('td.mg-td-cell')];
          const i = all.indexOf(td);
          const nxt = all[i + (e.shiftKey ? -1 : 1)];
          if (nxt) { e.preventDefault(); focusCell(nxt); }
        }
      });
    });
  });

  function focusCell(td) {
    table.querySelectorAll('td.mg-td-cell').forEach((c) => c.setAttribute('tabindex', '-1'));
    td.setAttribute('tabindex', '0');
    td.focus();
    sel.anchor = { r: Number(td.dataset.r), c: Number(td.dataset.c) };
    sel.focus = { r: sel.anchor.r, c: sel.anchor.c };
    paintSelection();
  }

  function selectRow(ri, add) {
    const cols = model.tags.length - 1;
    if (!add) { sel.anchor = { r: ri, c: 0 }; sel.focus = { r: ri, c: cols }; }
    else if (sel.anchor) { sel.focus = { r: ri, c: cols }; }
    else { sel.anchor = { r: ri, c: 0 }; sel.focus = { r: ri, c: cols }; }
    paintSelection();
    if (hooks.onSelectionChange) hooks.onSelectionChange(sel);
  }
  function selectColumn(ci, add) {
    const rows = model.rows.length - 1;
    if (!add) { sel.anchor = { r: 0, c: ci }; sel.focus = { r: rows, c: ci }; }
    else if (sel.anchor) { sel.focus = { r: rows, c: ci }; }
    else { sel.anchor = { r: 0, c: ci }; sel.focus = { r: rows, c: ci }; }
    paintSelection();
    if (hooks.onSelectionChange) hooks.onSelectionChange(sel);
  }
  function selectedRows() {
    const g = rangeOf(); const s = new Set();
    if (!g) return s;
    if (g.c0 === 0 && g.c1 >= model.tags.length - 1) for (let r = g.r0; r <= g.r1; r++) s.add(r);
    return s;
  }
  function selectedCols() {
    const g = rangeOf(); const s = new Set();
    if (!g) return s;
    if (g.r0 === 0 && g.r1 >= model.rows.length - 1) for (let c = g.c0; c <= g.c1; c++) s.add(c);
    return s;
  }

  function paintSelection() {
    const g = rangeOf();
    table.querySelectorAll('td.mg-td-cell').forEach((td) => {
      const r = Number(td.dataset.r), c = Number(td.dataset.c);
      const inRange = !!g && r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;
      td.classList.toggle('is-sel', inRange);
    });
    table.querySelectorAll('tr.mg-tr').forEach((tr, ri) => {
      tr.classList.toggle('is-row-sel', !!g && ri >= g.r0 && ri <= g.r1 && g.c0 === 0 && g.c1 >= model.tags.length - 1);
    });
    table.querySelectorAll('th.mg-th-tag').forEach((th) => {
      const c = Number(th.dataset.col);
      th.classList.toggle('is-selected', !!g && c >= g.c0 && c <= g.c1 && g.r0 === 0 && g.r1 >= model.rows.length - 1);
    });
  }

  applyWidths();
  paintSelection();

  function render() { buildMatrixTable(container, model, hooks); }
  container.__mgApi.render = render;
  return container.__mgApi;
}

/* ---------------- 视图 ---------------- */

const MATRIX_VIEW = 'matrix-graph-matrix';

class MatrixTableView extends ItemView {
  constructor(leaf, plugin, source, sourcePath, title) {
    super(leaf);
    this.plugin = plugin;
    this.source = source || '';
    this.sourcePath = sourcePath || '';
    this.title = title || '矩阵视图';
    this.model = null;
    this.saveTimer = null;
  }

  getViewType() { return MATRIX_VIEW; }
  getDisplayText() { return this.title; }
  getIcon() { return 'table'; }

  async onOpen() {
    await this.render();
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (!file || file.path !== this.sourcePath || this.saveTimer) return;
      clearTimeout(this._extTimer);
      this._extTimer = setTimeout(async () => {
        const text = await this.app.vault.cachedRead(file);
        const m = text.match(/```matrix-graph[^\n]*\n([\s\S]*?)\n```/);
        if (m && m[1] !== this.source) { this.source = m[1]; await this.render(); }
      }, 400);
    }));
  }

  async render() {
    const el = this.contentEl;
    el.empty();
    el.addClass('mg-matrix-view');
    if (!this.source) {
      el.createDiv({ cls: 'matrix-graph-error', text: '没有可用的矩阵数据：请从含 matrix-graph 代码块的笔记里点「表格」。' });
      return;
    }
    this.model = parseMatrixBlock(this.source);

    const bar = el.createDiv({ cls: 'mg-toolbar' });
    const stat = bar.createDiv({ cls: 'mg-stat' });
    this.updateStat = () => {
      const on = this.model.rows.reduce((s, r) => s + r.cells.filter(Boolean).length, 0);
      const api = this.table; const g = api && api.rangeOf ? api.rangeOf() : null;
      const selText = g ? ` · 选中 ${g.r1 - g.r0 + 1}×${g.c1 - g.c0 + 1}` : '';
      stat.setText(`${this.model.rows.length} 行 · ${this.model.tags.length} 列 · ${on} 个标记${selText}`);
    };
    this.updateStat();

    const btn = (text, fn, cls, title) => {
      const b = bar.createEl('button', { cls: 'matrix-graph-btn ' + (cls || ''), text: text });
      if (title) b.setAttribute('aria-label', title);
      b.addEventListener('click', fn);
      return b;
    };
    btn('+ 行', () => this.table.addRow(this.model.rows.length));
    btn('+ 列', () => this.table.addCol(this.model.tags.length));
    btn('✓ 选中', () => this.table.toggleRange(true), '', '把选区全部标记');
    btn('✗ 选中', () => this.table.toggleRange(false), '', '把选区全部取消');
    btn('⤒', () => this.moveSelectedRows(-1));
    btn('⤓', () => this.moveSelectedRows(1));
    btn('⇤', () => this.moveSelectedCols(-1));
    btn('⇥', () => this.moveSelectedCols(1));
    btn('删除选区', () => this.deleteSelected());
    btn('保存到笔记', () => this.saveNow(), 'mod-cta');
    const status = bar.createDiv({ cls: 'mg-status', text: 'Ctrl/Cmd+V 可粘贴 Excel 区域' });
    this.statusEl = status;

    const meta = el.createEl('details', { cls: 'mg-meta' });
    meta.createEl('summary', { cls: 'mg-meta-summary', text: '元数据（渲染参数 / 图标规则）' });
    const grid = meta.createDiv({ cls: 'mg-meta-grid' });
    const field = (label, key, placeholder, hint) => {
      const w = grid.createDiv({ cls: 'mg-field' });
      w.createEl('label', { cls: 'mg-field-label', text: label });
      const input = w.createEl('input', { type: 'text', cls: 'mg-field-input' });
      input.value = this.model.options[key] == null ? '' : String(this.model.options[key]);
      input.placeholder = placeholder || '';
      input.addEventListener('change', () => {
        const v = input.value.trim();
        if (v === '') delete this.model.options[key]; else this.model.options[key] = v;
        this.touch();
      });
      if (hint) w.createEl('div', { cls: 'mg-field-hint', text: hint });
    };
    const modeWrap = grid.createDiv({ cls: 'mg-field' });
    modeWrap.createEl('label', { cls: 'mg-field-label', text: '模式' });
    const modeSel = modeWrap.createEl('select', { cls: 'dropdown' });
    modeSel.createEl('option', { value: 'similar', text: '卡牌相似' });
    modeSel.createEl('option', { value: 'hub', text: '体系枢纽' });
    modeSel.value = this.model.options.mode === 'hub' ? 'hub' : 'similar';
    modeSel.addEventListener('change', () => { this.model.options.mode = modeSel.value; this.touch(); });
    field('共同标签阈值', 'threshold', '2');
    field('图标匹配规则', 'imagePrefix', 'GameIdea/StS2卡牌/images-small/StS2_Silent-{name}.jpg', '用 {name} 代指卡名');
    field('块高度', 'height', '640');

    const holder = el.createDiv({ cls: 'mg-table-holder' });
    holder.tabIndex = 0;
    this.table = buildMatrixTable(holder, this.model, {
      forceImageCol: this.forceImageCol,
      onChange: () => { this.updateStat(); this.touch(); },
      onSelectionChange: () => this.updateStat(),
      onRowMenu: (e, ri, api) => this.rowMenu(e, ri, api),
      onColumnMenu: (e, ci, api) => this.columnMenu(e, ci, api)
    });

    // 粘贴 TSV
    holder.addEventListener('paste', (ev) => {
      const text = (ev.clipboardData || window.clipboardData).getData('text');
      if (!text) return;
      ev.preventDefault();
      this.table.pasteTSV(text);
      this.touch();
    });

    this.updateStat();
  }

  moveSelectedRows(delta) {
    const g = this.table.rangeOf();
    if (!g) return;
    const rows = [];
    for (let r = (delta > 0 ? g.r1 : g.r0); delta > 0 ? r >= g.r0 : r <= g.r1; r += delta > 0 ? -1 : 1) rows.push(r);
    rows.forEach((r) => this.table.moveRow(r, r + delta));
  }
  moveSelectedCols(delta) {
    const g = this.table.rangeOf();
    if (!g) return;
    const cols = [];
    for (let c = (delta > 0 ? g.c1 : g.c0); delta > 0 ? c >= g.c0 : c <= g.c1; c += delta > 0 ? -1 : 1) cols.push(c);
    cols.forEach((c) => this.table.moveCol(c, c + delta));
  }
  deleteSelected() {
    const g = this.table.rangeOf();
    if (!g) return;
    const isFullRow = g.c0 === 0 && g.c1 >= this.model.tags.length - 1;
    const isFullCol = g.r0 === 0 && g.r1 >= this.model.rows.length - 1;
    if (isFullRow) {
      const rows = new Set();
      for (let r = g.r0; r <= g.r1; r++) rows.add(r);
      this.table.delRows(rows);
    } else if (isFullCol) {
      const cols = new Set();
      for (let c = g.c0; c <= g.c1; c++) cols.add(c);
      this.table.delCols(cols);
    } else {
      for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) this.model.rows[r].cells[c] = false;
      this.touch(); this.table.render();
    }
  }

  rowMenu(e, ri, api) {
    const m = new Menu();
    m.addItem((i) => i.setTitle('在上方插入行').setIcon('arrow-up').onClick(() => api.addRow(ri)));
    m.addItem((i) => i.setTitle('在下方插入行').setIcon('arrow-down').onClick(() => api.addRow(ri + 1)));
    m.addItem((i) => i.setTitle('上移一行').setIcon('arrow-up-circle').onClick(() => api.moveRow(ri, ri - 1)));
    m.addItem((i) => i.setTitle('下移一行').setIcon('arrow-down-circle').onClick(() => api.moveRow(ri, ri + 1)));
    m.addItem((i) => i.setTitle('复制本行').setIcon('copy').onClick(() => {
      const src = this.model.rows[ri];
      this.model.rows.splice(ri + 1, 0, { name: src.name + ' 副本', imageHint: src.imageHint, cells: src.cells.slice() });
      this.touch(); api.render();
    }));
    m.addSeparator();
    m.addItem((i) => i.setTitle('删除本行').setIcon('trash').onClick(() => api.delRows(new Set([ri]))));
    m.showAtMouseEvent(e);
  }

  columnMenu(e, ci, api) {
    const m = new Menu();
    if (ci < 0) {
      m.addItem((i) => i.setTitle('清空图片列').setIcon('eraser').onClick(() => {
        this.model.rows.forEach((r) => { r.imageHint = ''; });
        this.touch(); api.render();
      }));
    } else {
      m.addItem((i) => i.setTitle('在左侧插入列').setIcon('arrow-left').onClick(() => api.addCol(ci)));
      m.addItem((i) => i.setTitle('在右侧插入列').setIcon('arrow-right').onClick(() => api.addCol(ci + 1)));
      m.addItem((i) => i.setTitle('左移一列').setIcon('arrow-left-circle').onClick(() => api.moveCol(ci, ci - 1)));
      m.addItem((i) => i.setTitle('右移一列').setIcon('arrow-right-circle').onClick(() => api.moveCol(ci, ci + 1)));
      m.addItem((i) => i.setTitle('重命名此列').setIcon('pencil').onClick(() => { if (api.beginColumnEdit) api.beginColumnEdit(ci); }));
      m.addItem((i) => i.setTitle('清空此列').setIcon('eraser').onClick(() => {
        this.model.rows.forEach((r) => { r.cells[ci] = false; });
        this.touch(); api.render();
      }));
      m.addSeparator();
      m.addItem((i) => i.setTitle('删除此列').setIcon('trash').onClick(() => api.delCols(new Set([ci]))));
    }
    m.showAtMouseEvent(e);
  }

  touch() {
    // 1) 立刻广播给图视图（热更新：保留坐标与镜头）
    this.dirty = true;
    if (this.statusEl) this.statusEl.setText("已同步视图 · 写入中…");
    if (this._syncTimer) clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => {
      if (this.plugin.broadcastMatrixUpdate) {
        this.plugin.broadcastMatrixUpdate(this.sourcePath, serializeMatrixBlock(this.model));
      }
    }, 100);

    // 2) 防抖写回笔记：每次编辑都会落盘，保证数据不丢
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(true), 600);
  }

  async saveNow(silent) {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.sourcePath) return;
    const file = this.app.vault.getAbstractFileByPath(this.sourcePath);
    if (!(file instanceof TFile)) return;
    const text = await this.app.vault.read(file);
    const re = /```matrix-graph[^\n]*\n([\s\S]*?)\n```/;
    const m = text.match(re);
    if (!m) return;
    const body = serializeMatrixBlock(this.model);
    const updated = text.replace(re, '```matrix-graph\n' + body + '\n```');
    if (updated !== text) await this.app.vault.modify(file, updated);
    this.source = body;
    this.dirty = false;
    if (this.statusEl) this.statusEl.setText('已保存 ' + new Date().toTimeString().slice(0, 8));
      // 表格里显式写进代码块的选项优先于 ui 覆盖，避免"表格改 3、图还是 2"
      try {
        const uiKey = this.plugin.cacheKey(this.sourcePath, 0);
        const ui = (this.plugin.settings.ui || {})[uiKey];
        if (ui) {
          let changed = false;
          Object.keys(this.model.options).forEach((k) => {
            if (ui[k] !== undefined) { delete ui[k]; changed = true; }
          });
          if (changed) await this.plugin.saveSettings();
        }
      } catch (e) { }

      if (this.plugin.broadcastMatrixUpdate) this.plugin.broadcastMatrixUpdate(this.sourcePath, body);
    if (!silent) new Notice('矩阵已写回笔记');
  }

  async onClose() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = null; }
    if (this.dirty) { try { await this.saveNow(true); } catch (e) { } }
  }
}
