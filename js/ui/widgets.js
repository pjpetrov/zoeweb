/*
 * ZoeWeb — small DOM/canvas widget toolkit (tiles, gauges, bars, heatmaps, plots).
 */

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.substring(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.append(c.nodeType ? c : document.createTextNode(c));
  }
  return e;
}

/** Value tile bound to a field. Returns {root, update(field)}. */
export function tile(label, unit = '', cls = '') {
  const value = el('div', { class: 'tile-value' }, '—');
  const root = el('div', { class: 'tile ' + cls },
    el('div', { class: 'tile-label' }, label),
    value,
    el('div', { class: 'tile-unit' }, unit));
  return {
    root,
    update(field) {
      value.textContent = field.format();
      value.classList.toggle('stale', Date.now() - field.lastUpdated > 15000);
    },
    set(text) { value.textContent = text; },
  };
}

/** Round gauge (CanZE "Tacho"). */
export function gauge(label, min, max, unit, opts = {}) {
  const size = opts.size || 190;
  const canvas = el('canvas', { width: size * 2, height: size * 2, style: `width:${size}px;height:${size}px` });
  const root = el('div', { class: 'gauge' }, canvas, el('div', { class: 'gauge-label' }, label));
  const ctx = canvas.getContext('2d');
  let current = NaN;

  function draw() {
    const s = size * 2, c = s / 2, r = c - 14;
    ctx.clearRect(0, 0, s, s);
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue('--fg').trim() || '#dde3ec';
    const dim = css.getPropertyValue('--dim').trim() || '#5b6675';
    const accent = opts.color || css.getPropertyValue('--accent').trim() || '#41b0f5';
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    ctx.lineCap = 'round';
    ctx.lineWidth = 16;
    ctx.strokeStyle = 'rgba(128,140,160,.18)';
    ctx.beginPath(); ctx.arc(c, c, r, a0, a1); ctx.stroke();
    if (!Number.isNaN(current)) {
      const frac = Math.min(1, Math.max(0, (current - min) / (max - min)));
      let from = a0, to = a0 + (a1 - a0) * frac;
      if (opts.zeroCentered) {
        const zero = a0 + (a1 - a0) * (0 - min) / (max - min);
        from = Math.min(zero, to); to = Math.max(zero, to);
      }
      ctx.strokeStyle = (opts.zeroCentered && current < 0) ? (opts.negColor || '#41d98c') : accent;
      ctx.beginPath(); ctx.arc(c, c, r, from, to); ctx.stroke();
    }
    // ticks
    ctx.lineWidth = 2; ctx.strokeStyle = dim;
    for (let i = 0; i <= 10; i++) {
      const a = a0 + (a1 - a0) * i / 10;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * (r - 16), c + Math.sin(a) * (r - 16));
      ctx.lineTo(c + Math.cos(a) * (r - 24), c + Math.sin(a) * (r - 24));
      ctx.stroke();
    }
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.font = `${s / 6}px system-ui`;
    ctx.fillText(Number.isNaN(current) ? '—' : current.toFixed(opts.decimals ?? 0), c, c + s / 24);
    ctx.font = `${s / 14}px system-ui`;
    ctx.fillStyle = dim;
    ctx.fillText(unit, c, c + s / 7);
  }
  draw();
  return { root, update(field) { current = typeof field === 'number' ? field : field.value; draw(); } };
}

/** Horizontal bar with min/max range; optionally zero-centered. */
export function hbar(label, min, max, unit, opts = {}) {
  const fill = el('div', { class: 'hbar-fill' });
  const valEl = el('span', { class: 'hbar-value' }, '—');
  const root = el('div', { class: 'hbar' },
    el('div', { class: 'hbar-head' }, el('span', {}, label), valEl),
    el('div', { class: 'hbar-track' }, fill));
  return {
    root,
    update(field) {
      const v = typeof field === 'number' ? field : field.value;
      if (Number.isNaN(v)) { valEl.textContent = '—'; fill.style.width = '0'; return; }
      valEl.textContent = v.toFixed(opts.decimals ?? 0) + ' ' + unit;
      const frac = Math.min(1, Math.max(0, (v - min) / (max - min)));
      if (opts.zeroCentered) {
        const zero = (0 - min) / (max - min);
        fill.style.left = (Math.min(zero, frac) * 100) + '%';
        fill.style.width = (Math.abs(frac - zero) * 100) + '%';
        fill.style.background = v < 0 ? 'var(--good)' : 'var(--accent)';
      } else {
        fill.style.left = '0';
        fill.style.width = (frac * 100) + '%';
      }
    },
  };
}

/** Heatmap grid of n cells; color scale between lo and hi. */
export function heatmap(n, lo, hi, decimals, unit) {
  const cells = [];
  const root = el('div', { class: 'heatmap' });
  for (let i = 0; i < n; i++) {
    const c = el('div', { class: 'heatcell', title: `#${i + 1}` }, '·');
    cells.push(c);
    root.append(c);
  }
  return {
    root,
    update(i, v) {
      const c = cells[i];
      if (!c || Number.isNaN(v)) return;
      c.textContent = v.toFixed(decimals);
      const frac = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
      const hue = 210 - frac * 210; // blue → red
      c.style.background = `hsla(${hue}, 75%, 45%, .55)`;
      c.title = `#${i + 1}: ${v.toFixed(decimals)} ${unit}`;
    },
  };
}

/** Scrolling time plot for one or more series. */
export function timeplot(seriesDefs, opts = {}) {
  const W = opts.width || 800, H = opts.height || 260;
  const canvas = el('canvas', { width: W * 2, height: H * 2, style: 'width:100%;max-width:100%' });
  const root = el('div', { class: 'timeplot' }, canvas);
  const ctx = canvas.getContext('2d');
  const span = (opts.spanSec || 300) * 1000;
  const data = seriesDefs.map(() => []);

  function draw() {
    const now = Date.now();
    ctx.clearRect(0, 0, W * 2, H * 2);
    ctx.strokeStyle = 'rgba(128,140,160,.25)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = (H * 2) * i / 4;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W * 2, y); ctx.stroke();
    }
    seriesDefs.forEach((def, si) => {
      const pts = data[si].filter(p => now - p.t < span);
      data[si] = pts;
      if (pts.length < 2) return;
      ctx.strokeStyle = def.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = (1 - (now - p.t) / span) * W * 2;
        const y = H * 2 - ((p.v - def.min) / (def.max - def.min)) * H * 2;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    });
    // legend
    ctx.font = '22px system-ui';
    ctx.textAlign = 'left';
    seriesDefs.forEach((def, i) => {
      ctx.fillStyle = def.color;
      const last = data[i][data[i].length - 1];
      ctx.fillText(`${def.label}${last ? ': ' + last.v.toFixed(def.decimals ?? 1) : ''} ${def.unit || ''}`, 14, 30 + i * 30);
    });
  }
  draw();
  return {
    root,
    push(si, v) {
      if (Number.isNaN(v)) return;
      data[si].push({ t: Date.now(), v });
      draw();
    },
  };
}

/** Modern ring gauge: sweeping gradient arc with a big inline value + unit.
 *  Responsive — fills its container (sized by CSS). */
export function ringGauge(label, min, max, unit, opts = {}) {
  const R = 460; // internal render resolution
  const canvas = el('canvas', { width: R * 2, height: R * 2, style: 'width:100%;height:100%;display:block' });
  const big = el('div', { class: 'ring-val' }, '—');
  const sub = el('div', { class: 'ring-unit' }, unit);
  const cap = el('div', { class: 'ring-cap' }, label);
  const root = el('div', { class: 'ring ' + (opts.hud ? 'ring-hud' : '') }, canvas,
    el('div', { class: 'ring-center' }, big, sub, cap));
  const ctx = canvas.getContext('2d');
  const size = R;
  let current = NaN, shown = NaN;

  function draw() {
    const s = size * 2, c = s / 2, r = c - 48;
    ctx.clearRect(0, 0, s, s);
    const css = getComputedStyle(document.documentElement);
    const accent = opts.color || css.getPropertyValue('--accent').trim() || '#41b0f5';
    const neg = opts.negColor || css.getPropertyValue('--good').trim() || '#41d98c';
    const a0 = Math.PI * 0.72, a1 = Math.PI * 2.28;
    const frac = Number.isNaN(shown) ? 0 : Math.min(1, Math.max(0, (shown - min) / (max - min)));
    const col = (opts.zeroCentered && shown < 0) ? neg : accent;

    // fine tick ring (game-style graduations)
    ctx.save();
    for (let i = 0; i <= 60; i++) {
      const a = a0 + (a1 - a0) * i / 60;
      const major = i % 10 === 0;
      const lit = i / 60 <= frac;
      ctx.strokeStyle = lit ? col : 'rgba(128,140,160,.22)';
      ctx.lineWidth = major ? 6 : 3;
      const inner = major ? r - 40 : r - 30;
      if (lit) { ctx.shadowBlur = 12; ctx.shadowColor = col; } else ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
      ctx.lineTo(c + Math.cos(a) * inner, c + Math.sin(a) * inner);
      ctx.stroke();
    }
    ctx.restore();

    // main track
    ctx.lineCap = 'round';
    ctx.lineWidth = 22;
    ctx.strokeStyle = 'rgba(128,140,160,.12)';
    ctx.beginPath(); ctx.arc(c, c, r - 4, a0, a1); ctx.stroke();
    // value arc with glow
    if (!Number.isNaN(shown)) {
      let from = a0, to = a0 + (a1 - a0) * frac;
      if (opts.zeroCentered) {
        const zero = a0 + (a1 - a0) * (0 - min) / (max - min);
        from = Math.min(zero, to); to = Math.max(zero, to);
      }
      const g = ctx.createLinearGradient(0, 0, s, s);
      g.addColorStop(0, col + '66'); g.addColorStop(1, col);
      ctx.save();
      ctx.shadowBlur = 30; ctx.shadowColor = col;
      ctx.strokeStyle = g; ctx.lineWidth = 22;
      ctx.beginPath(); ctx.arc(c, c, r - 4, from, to); ctx.stroke();
      ctx.restore();
      // glowing tip
      ctx.save(); ctx.shadowBlur = 26; ctx.shadowColor = col; ctx.fillStyle = '#fff';
      const ta = opts.zeroCentered && shown < 0 ? from : to;
      ctx.beginPath(); ctx.arc(c + Math.cos(ta) * (r - 4), c + Math.sin(ta) * (r - 4), 9, 0, 7); ctx.fill();
      ctx.restore();
    }
  }

  // smooth animation toward target
  function tick() {
    if (!Number.isNaN(current)) {
      if (Number.isNaN(shown)) shown = current;
      else shown += (current - shown) * 0.25;
      if (Math.abs(current - shown) < 0.05) shown = current;
    }
    big.textContent = Number.isNaN(shown) ? '—' : shown.toFixed(opts.decimals ?? 0);
    draw();
    root._raf = requestAnimationFrame(tick);
  }
  tick();
  return {
    root,
    update(f) { current = typeof f === 'number' ? f : f.value; },
    stop() { cancelAnimationFrame(root._raf); },
  };
}

/** Tesla-style vertical power/regen bar: fills up from centre for drive power,
 *  down (green) for regeneration. */
export function powerBar(maxDrive, maxRegen, opts = {}) {
  const up = el('div', { class: 'pbar-fill pbar-up' });
  const down = el('div', { class: 'pbar-fill pbar-down' });
  const track = el('div', { class: 'pbar-track' },
    up, down, el('div', { class: 'pbar-mid' }));
  const val = el('div', { class: 'pbar-val' }, '—');
  const unit = el('div', { class: 'pbar-unit' }, opts.unit || 'kW');
  const tag = el('div', { class: 'pbar-tag' }, '');
  const root = el('div', { class: 'pbar' },
    el('div', { class: 'pbar-head' }, val, unit),
    track, tag);
  let cur = NaN, shown = NaN;

  function render() {
    if (Number.isNaN(shown)) { up.style.height = down.style.height = '0'; val.textContent = '—'; tag.textContent = ''; return; }
    val.textContent = (shown >= 0 ? '+' : '') + shown.toFixed(1);
    if (shown >= 0) {
      up.style.height = Math.min(100, shown / maxDrive * 100) + '%';
      down.style.height = '0';
      tag.textContent = shown > 0.3 ? 'POWER' : '';
      tag.className = 'pbar-tag';
    } else {
      down.style.height = Math.min(100, -shown / maxRegen * 100) + '%';
      up.style.height = '0';
      tag.textContent = 'REGEN';
      tag.className = 'pbar-tag regen';
    }
  }
  function tick() {
    if (!Number.isNaN(cur)) {
      shown = Number.isNaN(shown) ? cur : shown + (cur - shown) * 0.3;
      if (Math.abs(cur - shown) < 0.02) shown = cur;
    }
    render();
    root._raf = requestAnimationFrame(tick);
  }
  tick();
  return {
    root,
    update(f) { cur = typeof f === 'number' ? f : f.value; },
    stop() { cancelAnimationFrame(root._raf); },
  };
}

/** Vertical battery bar: fills bottom-up, colour shifts green→amber→red by level. */
export function socBar(opts = {}) {
  const fill = el('div', { class: 'sbar-fill' });
  const track = el('div', { class: 'sbar-track' }, fill, el('div', { class: 'sbar-cap' }));
  const val = el('div', { class: 'sbar-val' }, '—');
  const unit = el('div', { class: 'pbar-unit' }, '%');
  const tag = el('div', { class: 'pbar-tag' }, opts.label || 'CHARGE');
  const root = el('div', { class: 'pbar' },
    el('div', { class: 'pbar-head' }, val, unit), track, tag);
  let cur = NaN, shown = NaN;
  function render() {
    if (Number.isNaN(shown)) { fill.style.height = '0'; val.textContent = '—'; return; }
    val.textContent = shown.toFixed(0);
    fill.style.height = Math.min(100, Math.max(0, shown)) + '%';
    const col = shown > 40 ? 'var(--good)' : shown > 15 ? 'var(--warn)' : 'var(--bad)';
    fill.style.background = `linear-gradient(0deg, ${col}, ${col}cc)`;
    fill.style.boxShadow = `0 0 22px ${col}`;
  }
  function tick() {
    if (!Number.isNaN(cur)) shown = Number.isNaN(shown) ? cur : shown + (cur - shown) * 0.2;
    render();
    root._raf = requestAnimationFrame(tick);
  }
  tick();
  return { root, update(f) { cur = typeof f === 'number' ? f : f.value; }, stop() { cancelAnimationFrame(root._raf); } };
}

/** Compact stat chip with icon, big value, small label. */
export function chip(label, unit, icon = '') {
  const v = el('div', { class: 'chip-val' }, '—');
  const root = el('div', { class: 'chip' },
    el('div', { class: 'chip-top' }, icon ? el('span', { class: 'chip-ico' }, icon) : null,
      el('span', { class: 'chip-label' }, label)),
    el('div', { class: 'chip-row' }, v, el('span', { class: 'chip-unit' }, unit)));
  return {
    root,
    update(f) {
      v.textContent = f.format ? f.format() : (typeof f === 'number' ? f.toFixed(1) : f.value);
      v.classList.toggle('stale', f.lastUpdated && Date.now() - f.lastUpdated > 15000);
    },
    set(t) { v.textContent = t; },
  };
}

export function section(title, ...children) {
  return el('div', { class: 'card' }, title ? el('h3', {}, title) : null, ...children);
}
