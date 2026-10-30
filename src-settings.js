/* matrix-graph 设置页与参数示意预览（拼接进 main.js） */

const PARAM_KEYS = [
  'mode', 'threshold', 'linkMode', 'perTag', 'baseStrength',
  'gravity', 'repulsion', 'attraction', 'linkLength',
  'nodeScale', 'edgeWidth', 'labelAlpha', 'orphans', 'showLabels'
];

function cssVarSafe(name, fallback) {
  try {
    const v = getComputedStyle(document.body).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  } catch (e) { return fallback; }
}

/* 每个参数一张 170×54 的示意图 */
function drawParamPreview(canvas, key, value, all) {
  const W = 170, H = 54;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  canvas.className = 'matrix-graph-preview';
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);

  const bg = cssVarSafe('--background-secondary', '#f5f5f7');
  const fg = cssVarSafe('--text-muted', '#8a93a3');
  const accent = cssVarSafe('--interactive-accent', '#6b8afd');
  c.fillStyle = bg; c.fillRect(0, 0, W, H);
  c.strokeStyle = fg; c.fillStyle = fg; c.lineWidth = 1;

  const dot = (x, y, r, col) => { c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fillStyle = col || fg; c.fill(); };
  const line = (x1, y1, x2, y2, w) => { c.beginPath(); c.lineWidth = w || 1; c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); };

  switch (key) {
    case 'mode': {
      if (value === 'hub') {
        const hubs = [[45, 18], [45, 38]];
        hubs.forEach(([hx, hy]) => {
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * 6.2832;
            line(hx, hy, hx + Math.cos(a) * 22, hy + Math.sin(a) * 12);
          }
          dot(hx, hy, 4, accent);
        });
        dot(120, 28, 10, accent); dot(150, 28, 10, accent);
      } else {
        const pts = [[40, 16], [70, 16], [40, 38], [70, 38], [110, 20], [140, 34]];
        line(40, 16, 70, 16, 1.5); line(40, 38, 70, 38, 1.5);
        line(70, 16, 110, 20); line(70, 38, 140, 34);
        pts.forEach(([x, y]) => dot(x, y, 5, accent));
      }
      break;
    }
    case 'threshold': {
      const tags = [2, 1, 3, 1, 2, 3];
      for (let i = 0; i < tags.length; i++) {
        for (let j = i + 1; j < tags.length; j++) {
          const shared = Math.min(tags[i], tags[j]);
          if (shared >= value) line(28 + i * 22, 27, 28 + j * 22, 27, 1);
        }
      }
      tags.forEach((t, i) => dot(28 + i * 22, 27, 4 + t, t >= value ? accent : fg));
      break;
    }
    case 'linkMode': case 'perTag': case 'baseStrength': {
      const equal = all.linkMode === 'equal';
      const len1 = equal ? 46 : 46;
      const len3 = equal ? 46 : Math.max(14, 46 - (all.perTag || 0.035) * 400);
      line(14, 18, 14 + len1, 18, (all.baseStrength || 0.05) * 30);
      line(14, 40, 14 + len3, 40, equal ? (all.baseStrength || 0.05) * 30 : ((all.baseStrength || 0.05) + (all.perTag || 0.035) * 3) * 30);
      dot(14, 18, 5, accent); dot(14 + len1, 18, 5, fg);
      dot(14, 40, 5, accent); dot(14 + len3, 40, 5, fg);
      c.font = '9px sans-serif'; c.fillStyle = fg;
      c.fillText('共同1', 96, 21); c.fillText('共同4', 96, 43);
      break;
    }
    case 'gravity': {
      const r = Math.max(8, 26 - (value || 0) * 2600);
      c.beginPath(); c.arc(85, 27, r, 0, 6.2832); c.stroke();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * 6.2832;
        dot(85 + Math.cos(a) * r, 27 + Math.sin(a) * r, 4, accent);
      }
      dot(85, 27, 3, fg);
      break;
    }
    case 'repulsion': {
      const r = 6 + (value / 30000) * 22;
      dot(85, 27, 4, accent);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * 6.2832;
        dot(85 + Math.cos(a) * r, 27 + Math.sin(a) * r * 0.7, 4, fg);
        line(85, 27, 85 + Math.cos(a) * r, 27 + Math.sin(a) * r * 0.7, 0.5);
      }
      break;
    }
    case 'attraction': {
      const d = 20 + (1 - Math.min(1, value || 1)) * 30;
      line(85 - d, 27, 85 + d, 27, 1 + (value || 1));
      dot(85 - d, 27, 5, accent); dot(85 + d, 27, 5, accent);
      break;
    }
    case 'linkLength': {
      const d = Math.min(70, 10 + (value || 150) / 4);
      line(85 - d, 27, 85 + d, 27, 1.5);
      dot(85 - d, 27, 5, accent); dot(85 + d, 27, 5, accent);
      break;
    }
    case 'nodeScale': {
      const w = 18 * (value || 1.16), h = 24 * (value || 1.16);
      c.fillStyle = accent;
      roundRectPath(c, 85 - w / 2, 27 - h / 2, w, h, 3); c.fill();
      c.fillStyle = fg; c.font = '9px sans-serif'; c.fillText('卡', 82, 31);
      break;
    }
    case 'edgeWidth': {
      [0, 1, 2].forEach((i) => line(40, 14 + i * 13, 130, 14 + i * 13, value || 1));
      break;
    }
    case 'labelAlpha': {
      c.globalAlpha = value == null ? 0.85 : value;
      c.fillStyle = accent; c.font = '11px sans-serif';
      c.fillText('卡名标签', 55, 31);
      c.globalAlpha = 1;
      c.fillStyle = fg; c.font = '9px sans-serif';
      c.fillText(Math.round((value == null ? 0.85 : value) * 100) + '%', 132, 50);
      break;
    }
    case 'orphans': {
      const pts = [[40, 18], [62, 18], [40, 34], [62, 34]];
      pts.forEach(([x, y]) => dot(x, y, 5, accent));
      line(40, 18, 62, 18, 1); line(40, 34, 62, 34, 1);
      if (value) {
        c.save(); c.setLineDash([3, 3]); c.strokeStyle = fg;
        c.strokeRect(96, 10, 60, 34); c.restore();
        [[108, 20], [128, 20], [108, 32], [128, 32]].forEach(([x, y]) => dot(x, y, 4, fg));
        c.font = '8px sans-serif'; c.fillText('孤立', 98, 52);
      } else {
        [[108, 20], [128, 32], [148, 20], [118, 44]].forEach(([x, y]) => dot(x, y, 4, fg));
      }
      break;
    }
    case 'showLabels': {
      c.fillStyle = accent;
      roundRectPath(c, 55, 8, 22, 28, 3); c.fill();
      if (value) { c.fillStyle = fg; c.font = '9px sans-serif'; c.fillText('卡名', 56, 48); }
      c.fillStyle = accent; roundRectPath(c, 100, 8, 22, 28, 3); c.fill();
      c.fillStyle = fg; c.fillText(value ? '卡名' : '(无标签)', 96, 48);
      break;
    }
    default: {
      c.font = '10px sans-serif';
      c.fillText(key + ' = ' + value, 8, 30);
    }
  }
}

function roundRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* ---------------- 设置页 ---------------- */

class MatrixGraphSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  defaults() {
    return Object.assign({}, DEFAULT_OPTS, this.plugin.settings.defaults || {});
  }

  async setDefault(key, value) {
    this.plugin.settings.defaults = this.plugin.settings.defaults || {};
    this.plugin.settings.defaults[key] = value;
    await this.plugin.saveSettings();
    this.refreshPreviews();
  }

  refreshPreviews() {
    const all = this.defaults();
    (this.previews || []).forEach(({ canvas, key }) => {
      drawParamPreview(canvas, key, all[key], all);
    });
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    this.previews = [];

    containerEl.createEl('h2', { text: 'Matrix Graph 全局默认参数' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '这里改的是所有矩阵块的默认值。任何一个块里手动调过的参数会单独覆盖它（覆盖值存在 data.json 的 ui 段）。右侧小图是当前取值下的示意。'
    });

    const addRow = (key, name, desc) => {
      const setting = new Setting(containerEl).setName(name).setDesc(desc);
      const canvas = document.createElement('canvas');
      setting.controlEl.insertBefore(canvas, setting.controlEl.firstChild);
      this.previews.push({ canvas, key });
      return setting;
    };

    const all = this.defaults();

    // 模式
    addRow('mode', '默认模式', '卡牌相似＝卡与卡连边；体系枢纽＝卡挂在体系上')
      .addDropdown((dd) => {
        dd.addOption('similar', '卡牌相似');
        dd.addOption('hub', '体系枢纽');
        dd.setValue(all.mode === 'hub' ? 'hub' : 'similar');
        dd.onChange((v) => this.setDefault('mode', v));
      });

    addRow('threshold', '共同标签阈值', '共享标签数达到该值才连边（仅相似模式）')
      .addSlider((s) => {
        s.setLimits(1, 6, 1).setValue(all.threshold || 2).setDynamicTooltip();
        s.onChange((v) => this.setDefault('threshold', v));
      });

    addRow('linkMode', '连接力模式', '等力：所有边力量相同；正比：每多一个共同标签增加力量')
      .addDropdown((dd) => {
        dd.addOption('equal', '等力');
        dd.addOption('proportional', '正比');
        dd.setValue(all.linkMode === 'equal' ? 'equal' : 'proportional');
        dd.onChange((v) => this.setDefault('linkMode', v));
      });

    addRow('perTag', '每标签增加力', '正比模式下，每多 1 个共同标签增加多少弹簧强度')
      .addSlider((s) => {
        s.setLimits(0.005, 0.15, 0.005).setValue(all.perTag == null ? 0.035 : all.perTag).setDynamicTooltip();
        s.onChange((v) => this.setDefault('perTag', v));
      });

    addRow('baseStrength', '基础弹簧强度', '每条边的最小弹簧强度')
      .addSlider((s) => {
        s.setLimits(0.01, 0.2, 0.005).setValue(all.baseStrength == null ? 0.05 : all.baseStrength).setDynamicTooltip();
        s.onChange((v) => this.setDefault('baseStrength', v));
      });

    addRow('topK', '每节点连线上限', '0 = 不限制；大于 0 时每个节点最多连这么多条边（会丢弃部分共同标签连线）')
      .addSlider((sl) => {
        sl.setLimits(0, 40, 1).setValue(all.topK == null ? 0 : all.topK).setDynamicTooltip();
        sl.onChange((v) => this.setDefault('topK', v));
      });

    addRow('repulsion', '排斥力', '节点互相推开的力量，越大越散')
      .addSlider((s) => {
        s.setLimits(1000, 30000, 200).setValue(all.repulsion || 9200).setDynamicTooltip();
        s.onChange((v) => this.setDefault('repulsion', v));
      });

    addRow('gravity', '向心力', '把节点拉向中心的力量')
      .addSlider((s) => {
        s.setLimits(0, 0.008, 0.0002).setValue(all.gravity == null ? 0.0016 : all.gravity).setDynamicTooltip();
        s.onChange((v) => this.setDefault('gravity', v));
      });

    addRow('attraction', '吸引力倍率', '整体放大/缩小所有弹簧强度')
      .addSlider((s) => {
        s.setLimits(0.2, 2, 0.05).setValue(all.attraction == null ? 1 : all.attraction).setDynamicTooltip();
        s.onChange((v) => this.setDefault('attraction', v));
      });

    addRow('linkLength', '连线长度', '边的期望长度')
      .addSlider((s) => {
        s.setLimits(60, 400, 10).setValue(all.linkLength || 130).setDynamicTooltip();
        s.onChange((v) => this.setDefault('linkLength', v));
      });

    addRow('nodeScale', '节点大小', '卡图/节点的缩放倍数')
      .addSlider((s) => {
        s.setLimits(0.5, 2, 0.02).setValue(all.nodeScale == null ? 1.16 : all.nodeScale).setDynamicTooltip();
        s.onChange((v) => this.setDefault('nodeScale', v));
      });

    addRow('edgeWidth', '连线粗细', '边的线宽')
      .addSlider((s) => {
        s.setLimits(0.5, 4, 0.1).setValue(all.edgeWidth == null ? 1 : all.edgeWidth).setDynamicTooltip();
        s.onChange((v) => this.setDefault('edgeWidth', v));
      });

    addRow('labelAlpha', '文字透明度', '卡名标签的不透明度')
      .addSlider((s) => {
        s.setLimits(0, 1, 0.02).setValue(all.labelAlpha == null ? 0.85 : all.labelAlpha).setDynamicTooltip();
        s.onChange((v) => this.setDefault('labelAlpha', v));
      });

    addRow('orphans', '孤立聚类', '没有任何连线的卡自动聚成一组并放到图下方')
      .addToggle((t) => {
        t.setValue(all.orphans !== false);
        t.onChange((v) => this.setDefault('orphans', v));
      });

    addRow('showLabels', '显示标签', '在节点下方显示卡名')
      .addToggle((t) => {
        t.setValue(all.showLabels !== false);
        t.onChange((v) => this.setDefault('showLabels', v));
      });

    // 底部操作
    new Setting(containerEl)
      .setName('恢复内置默认')
      .setDesc('清空全局默认参数，回到插件内置值')
      .addButton((b) => {
        b.setButtonText('恢复').setWarning().onClick(async () => {
          this.plugin.settings.defaults = {};
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('清除所有块的覆盖')
      .setDesc('删除各矩阵块单独保存的参数覆盖，全部回到全局默认')
      .addButton((b) => {
        b.setButtonText('清除').setWarning().onClick(async () => {
          this.plugin.settings.ui = {};
          await this.plugin.saveSettings();
          new Notice('已清除所有覆盖参数');
          this.display();
        });
      });

    const uiCount = Object.keys(this.plugin.settings.ui || {}).length;
    new Setting(containerEl)
      .setName('当前覆盖数量')
      .setDesc(uiCount ? `有 ${uiCount} 个矩阵块保存了自己的覆盖参数` : '所有块都使用上面的全局默认值');

    this.refreshPreviews();
  }
}
