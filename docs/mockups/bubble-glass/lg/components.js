/*
 * Liquid Glass components as light-DOM custom elements, so page CSS and document-level SVG
 * filters reach them: <lg-switch>, <lg-slider>, <lg-segmented>, <lg-tabbar>, <lg-menu>, <lg-sheet>.
 */
import { glass, presets, spring, pressable, motion, themeOf, browserEngine } from './liquid-glass.js';

const feel = (precision) => ({ stiffness: motion.stiffness, dampingRatio: motion.dampingRatio, precision });

const h = (tag, className, parent) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  parent?.appendChild(el);
  return el;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Past the ends, movement shrinks like iOS overscroll. */
const rubber = (v, lo, hi, k = 0.35) => (v < lo ? lo - (lo - v) * k : v > hi ? hi + (v - hi) * k : v);

/** Tracks pointer velocity in px/s with light smoothing. */
class Velocity {
  reset(x) {
    this.x = x;
    this.t = performance.now();
    this.v = 0;
  }
  push(x) {
    const now = performance.now();
    const dt = Math.max(now - this.t, 1) / 1000;
    this.v = this.v * 0.6 + ((x - this.x) / dt) * 0.4;
    this.x = x;
    this.t = now;
    return this.v;
  }
}

/**
 * A knob that turns into a lens while held: it grows, its white face fades so the glass shows,
 * and it stretches along the direction it's moving.
 */
class Knob {
  constructor(el, face, scene, { grow = 1.45, growY } = {}) {
    this.el = el;
    this.face = face;
    this.grow = grow;
    this.growY = growY ?? grow;
    // The lens preset is tuned on a 68px knob. Smaller knobs get the same lens scaled down, so a
    // 24px thumb looks like the big one in miniature; at full size a 12px band covers the whole of
    // a small thumb and smears what's under it.
    const h = el.offsetHeight || 24;
    const k = Math.min(1, Math.max(0.3, h / 68));
    // WebKit samples a steep bend on glass this small coarsely and the track comes out lumpy, so
    // its knobs bend more gently (Chromium and Firefox render the full bend smoothly).
    const refraction = browserEngine === 'webkit' && h < 40 ? 0.4 : 1;
    this.glass = glass(el, { ...presets.lens, scene, zoom: 0.08, refraction, bezel: presets.lens.bezel * k, thickness: presets.lens.thickness * k });
    this.x = spring(0, feel(0.01), () => this.render());
    this.press = spring(0, { ...feel(0.0005), dampingRatio: 0.6 }, () => this.updateFace());
    this.stretch = spring(0, { stiffness: 300, damping: 22, precision: 0.0005 }, () => this.render());
    this.retheme();
    document.addEventListener('lg-retheme', () => this.retheme());
  }
  /** Default: a white face hides the glass at rest. Themes with clearKnobs show the glass always. */
  retheme() {
    this.clear = !!themeOf(this.el).clearKnobs;
    this.updateFace();
  }
  updateFace() {
    const v = this.press.value;
    this.face.style.opacity = this.clear ? 0 : clamp(1 - v * 1.4, 0, 1);
    // A clear knob at rest is a gentle bubble; it swells into the full lens as it's pressed.
    // At rest the white face covers the glass completely, so don't pay for refraction.
    if (this.clear || v > 0.02 || this.press.target > 0) this.glass.resume();
    else if (this.press.settled) this.glass.suspend();
    this.render();
  }
  render() {
    const p = this.press.value;
    const s = this.stretch.value;
    const sx = 1 + (this.grow - 1) * p + s;
    const sy = 1 + (this.growY - 1) * p - s * 0.55;
    this.el.style.translate = `${this.x.value.toFixed(2)}px 0`;
    this.el.style.scale = `${sx.toFixed(4)} ${sy.toFixed(4)}`;
    this.glass.requestSync();
  }
  moveVelocity(v) {
    this.stretch.to(clamp((Math.abs(v) / 1000) * motion.elongation * 2, 0, 0.22));
  }
}

/* ------------------------------------------------------------------------------------------------
 * <lg-switch checked disabled>
 * ---------------------------------------------------------------------------------------------- */

class LgSwitch extends HTMLElement {
  static observedAttributes = ['checked', 'disabled'];

  connectedCallback() {
    if (this.track) return;
    this.setAttribute('role', 'switch');
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
    this.track = h('span', 'lg-switch-track', this);
    h('span', 'lg-switch-fill', this.track);
    const knob = h('span', 'lg-switch-knob', this.track);
    const face = h('span', 'lg-switch-face', knob);
    this.knob = new Knob(knob, face, this.track, { grow: 1.5, growY: 1.6 });
    this.vel = new Velocity();
    this.sync(false);

    this.addEventListener('pointerdown', (e) => this.down(e));
    this.addEventListener('pointermove', (e) => this.move(e));
    this.addEventListener('pointerup', (e) => this.up(e));
    this.addEventListener('pointercancel', (e) => this.up(e, true));
    this.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        this.toggle();
      }
    });
    this.addEventListener('click', (e) => e.preventDefault());
  }

  attributeChangedCallback() {
    if (this.track) this.sync(true);
  }

  get checked() {
    return this.hasAttribute('checked');
  }
  set checked(v) {
    this.toggleAttribute('checked', !!v);
  }
  get disabled() {
    return this.hasAttribute('disabled');
  }

  get travel() {
    return this.offsetWidth - this.knob.el.offsetWidth - this.knob.el.offsetLeft * 2;
  }

  sync(animate) {
    this.setAttribute('aria-checked', String(this.checked));
    this.setAttribute('aria-disabled', String(this.disabled));
    this.toggleAttribute('data-on', this.checked);
    const x = this.checked ? this.travel : 0;
    if (animate) this.knob.x.to(x);
    else this.knob.x.set(x);
  }

  toggle() {
    if (this.disabled) return;
    this.checked = !this.checked;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }

  down(e) {
    if (this.disabled || e.button > 0) return;
    this.setPointerCapture(e.pointerId);
    this.drag = { x0: e.clientX, from: this.knob.x.value, moved: false };
    this.vel.reset(e.clientX);
    this.knob.press.to(1);
  }

  move(e) {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x0;
    if (Math.abs(dx) > 3) this.drag.moved = true;
    if (!this.drag.moved) return;
    const x = rubber(this.drag.from + dx, 0, this.travel);
    this.knob.x.set(x);
    this.knob.moveVelocity(this.vel.push(e.clientX));
    this.toggleAttribute('data-on', x > this.travel / 2);
  }

  up(e, cancelled) {
    if (!this.drag) return;
    const { moved } = this.drag;
    this.drag = null;
    this.knob.press.to(0);
    this.knob.stretch.to(0);
    if (cancelled) return this.sync(true);
    const next = moved ? this.knob.x.value > this.travel / 2 : !this.checked;
    if (next !== this.checked) {
      this.checked = next;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
    } else this.sync(true);
  }
}

/* ------------------------------------------------------------------------------------------------
 * <lg-slider min max step value disabled>
 * ---------------------------------------------------------------------------------------------- */

class LgSlider extends HTMLElement {
  static observedAttributes = ['value', 'min', 'max', 'disabled'];

  connectedCallback() {
    if (this.track) return;
    this.setAttribute('role', 'slider');
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
    this.track = h('span', 'lg-slider-track', this);
    this.fill = h('span', 'lg-slider-fill', this.track);
    const thumb = h('span', 'lg-slider-thumb', this);
    const face = h('span', 'lg-slider-face', thumb);
    this.knob = new Knob(thumb, face, this.track, { grow: 1.5, growY: 1.4 });
    const render = this.knob.render.bind(this.knob);
    this.knob.render = () => {
      render();
      this.fill.style.width = `${(this.knob.x.value + thumb.offsetWidth / 2).toFixed(1)}px`;
    };
    this.vel = new Velocity();
    this._value = this.parse(this.getAttribute('value') ?? 50);
    this.place(false);
    new ResizeObserver(() => this.place(false)).observe(this);

    this.addEventListener('pointerdown', (e) => this.down(e));
    this.addEventListener('pointermove', (e) => this.move(e));
    this.addEventListener('pointerup', (e) => this.up(e));
    this.addEventListener('pointercancel', (e) => this.up(e));
    this.addEventListener('keydown', (e) => this.key(e));
  }

  attributeChangedCallback(name, _, v) {
    if (!this.track) return;
    if (name === 'value' && !this.drag) this._value = this.parse(v);
    this.place(true);
  }

  get min() {
    return Number(this.getAttribute('min') ?? 0);
  }
  get max() {
    return Number(this.getAttribute('max') ?? 100);
  }
  get step() {
    return Number(this.getAttribute('step') ?? 1);
  }
  get value() {
    return this._value;
  }
  set value(v) {
    this._value = this.parse(v);
    this.place(true);
  }
  get disabled() {
    return this.hasAttribute('disabled');
  }

  parse(v) {
    const { min, max, step } = this;
    const n = clamp(Number(v), min, max);
    return step > 0 ? clamp(Math.round((n - min) / step) * step + min, min, max) : n;
  }

  get usable() {
    return this.offsetWidth - this.knob.el.offsetWidth;
  }

  xFor(value) {
    return ((value - this.min) / (this.max - this.min || 1)) * this.usable;
  }

  place(animate) {
    this.setAttribute('aria-valuemin', this.min);
    this.setAttribute('aria-valuemax', this.max);
    this.setAttribute('aria-valuenow', this._value);
    const x = this.xFor(this._value);
    if (animate) this.knob.x.to(x);
    else this.knob.x.set(x);
  }

  emit(type) {
    this.dispatchEvent(new Event(type, { bubbles: true }));
  }

  fromPointer(e) {
    const r = this.getBoundingClientRect();
    const x = e.clientX - r.left - this.knob.el.offsetWidth / 2;
    return { x, value: this.min + (clamp(x, 0, this.usable) / (this.usable || 1)) * (this.max - this.min) };
  }

  down(e) {
    if (this.disabled || e.button > 0) return;
    this.setPointerCapture(e.pointerId);
    const { x, value } = this.fromPointer(e);
    const onThumb = Math.abs(x - this.knob.x.value) < this.knob.el.offsetWidth / 2;
    this.drag = { offset: onThumb ? this.knob.x.value - x : 0 };
    this.vel.reset(e.clientX);
    this.knob.press.to(1);
    if (!onThumb) {
      this._value = this.parse(value);
      this.knob.x.to(this.xFor(this._value));
      this.setAttribute('aria-valuenow', this._value);
      this.emit('input');
    }
  }

  move(e) {
    if (!this.drag) return;
    const { x } = this.fromPointer(e);
    const pos = x + this.drag.offset;
    const raw = this.min + (clamp(pos, 0, this.usable) / (this.usable || 1)) * (this.max - this.min);
    this.knob.x.to(rubber(pos, 0, this.usable, 0.15));
    this.knob.moveVelocity(this.vel.push(e.clientX));
    const v = this.parse(raw);
    if (v !== this._value) {
      this._value = v;
      this.setAttribute('aria-valuenow', v);
      this.emit('input');
    }
  }

  up() {
    if (!this.drag) return;
    this.drag = null;
    this.knob.press.to(0);
    this.knob.stretch.to(0);
    this.knob.x.to(this.xFor(this._value));
    this.emit('change');
  }

  key(e) {
    if (this.disabled) return;
    const big = (this.max - this.min) / 10;
    const delta = { ArrowRight: this.step, ArrowUp: this.step, ArrowLeft: -this.step, ArrowDown: -this.step, PageUp: big, PageDown: -big }[e.key];
    let next;
    if (delta !== undefined) next = this._value + delta;
    else if (e.key === 'Home') next = this.min;
    else if (e.key === 'End') next = this.max;
    else return;
    e.preventDefault();
    this.value = next;
    this.emit('input');
    this.emit('change');
  }
}

/* ------------------------------------------------------------------------------------------------
 * <lg-segmented value> with <button value> children. <lg-tabbar> is the same control, larger.
 * ---------------------------------------------------------------------------------------------- */

class LgSegmented extends HTMLElement {
  itemRole = 'radio';
  groupRole = 'radiogroup';
  checkedAttr = 'aria-checked';

  connectedCallback() {
    if (this.row) return;
    this.setAttribute('role', this.groupRole);
    const buttons = [...this.querySelectorAll(':scope > button')];
    glass(this, this.containerOptions());
    this.row = h('span', 'lg-seg-row', this);
    this.bubble = h('span', 'lg-seg-bubble', this.row);
    for (const b of buttons) {
      b.type = 'button';
      b.setAttribute('role', this.itemRole);
      this.row.appendChild(b);
    }
    this.buttons = buttons;
    this.lens = h('span', 'lg-seg-lens', this);
    this.lensGlass = glass(this.lens, { ...presets.lens, scene: this.row, zoom: this.lensZoom() });
    this.lensGlass.suspend();

    // Each edge of the bubble has its own spring; the trailing edge starts a beat late, so the
    // bubble stretches across neighbours while it travels and gathers up when it lands.
    this.left = spring(0, feel(0.01), () => this.render());
    this.right = spring(0, feel(0.01), () => this.render());
    this.press = spring(0, { ...feel(0.0005), dampingRatio: 0.6 }, () => this.render());
    this.stretch = spring(0, { stiffness: 300, dampingRatio: 0.6, precision: 0.0005 }, () => this.render());
    this.vel = new Velocity();

    const initial = this.getAttribute('value') ?? buttons[0]?.value;
    this.index = Math.max(0, buttons.findIndex((b) => b.value === initial));
    this.layout();
    new ResizeObserver(() => this.layout()).observe(this);

    this.addEventListener('pointerdown', (e) => this.down(e));
    this.addEventListener('pointermove', (e) => this.move(e));
    this.addEventListener('pointerup', (e) => this.up(e));
    this.addEventListener('pointercancel', (e) => this.up(e, true));
    this.addEventListener('keydown', (e) => this.key(e));
    this.addEventListener('click', (e) => e.preventDefault());
  }

  containerOptions() {
    return { ...presets.clear };
  }
  lensZoom() {
    return 0.1;
  }
  lensGrow() {
    return [1.18, 1.3];
  }

  get value() {
    return this.buttons[this.index]?.value;
  }
  set value(v) {
    const i = this.buttons.findIndex((b) => b.value === v);
    if (i >= 0) this.select(i, false);
  }

  segWidth() {
    return this.row.offsetWidth / this.buttons.length;
  }

  layout() {
    const w = this.segWidth();
    this.bubble.style.width = `${w}px`;
    this.lens.style.width = `${w}px`;
    this.lens.style.height = `${this.row.offsetHeight}px`;
    this.left.set(this.index * w);
    this.right.set(this.index * w + w);
    this.markSelected();
  }

  render() {
    const p = this.press.value;
    const s = this.stretch.value;
    // The lens is invisible at rest: only refract while it's showing.
    if (p > 0.01 || this.press.target > 0) this.lensGlass.resume();
    else if (this.press.settled) this.lensGlass.suspend();
    const [gx, gy] = this.lensGrow();
    const w = this.segWidth();
    const L = this.left.value;
    const R = this.right.value;
    const x = (L + R) / 2 - w / 2;
    const sx = (R - L) / w;
    this.bubble.style.translate = `${x.toFixed(2)}px 0`;
    this.bubble.style.scale = `${sx.toFixed(4)} 1`;
    this.bubble.style.opacity = (1 - p).toFixed(3);
    this.lens.style.translate = `${x.toFixed(2)}px 0`;
    this.lens.style.opacity = clamp(p * 1.6, 0, 1).toFixed(3);
    this.lens.style.scale = `${(sx * (1 + (gx - 1) * p) + s).toFixed(4)} ${(1 + (gy - 1) * p - s * 0.5).toFixed(4)}`;
    this.lensGlass.requestSync();
  }

  markSelected() {
    this.buttons.forEach((b, i) => {
      b.setAttribute(this.checkedAttr, String(i === this.index));
      b.tabIndex = i === this.index ? 0 : -1;
    });
  }

  select(i, user) {
    i = clamp(i, 0, this.buttons.length - 1);
    const changed = i !== this.index;
    this.index = i;
    this.glide(i * this.segWidth());
    this.markSelected();
    if (changed && user) {
      this.setAttribute('value', this.value);
      this.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  /** Move the bubble to x: the leading edge goes now, the trailing edge after motion.widthDelay. */
  glide(x) {
    const w = this.segWidth();
    const right = x > this.left.value;
    const [lead, trail] = right ? [this.right, this.left] : [this.left, this.right];
    lead.to(right ? x + w : x);
    clearTimeout(this.trailTimer);
    this.trailTimer = setTimeout(() => trail.to(right ? x : x + w), motion.widthDelay);
  }

  /** Follow the finger directly, both edges together. */
  follow(x) {
    clearTimeout(this.trailTimer);
    this.left.to(x);
    this.right.to(x + this.segWidth());
  }

  pointerX(e) {
    const r = this.row.getBoundingClientRect();
    return e.clientX - r.left;
  }

  down(e) {
    if (e.button > 0) return;
    this.setPointerCapture(e.pointerId);
    const w = this.segWidth();
    const px = this.pointerX(e);
    const onSelected = px >= this.left.value && px <= this.left.value + w;
    this.drag = { offset: onSelected ? this.left.value - px : -w / 2, moved: false, x0: e.clientX };
    this.vel.reset(e.clientX);
    this.press.to(1);
  }

  move(e) {
    if (!this.drag) return;
    if (Math.abs(e.clientX - this.drag.x0) > 4) this.drag.moved = true;
    if (!this.drag.moved) return;
    const w = this.segWidth();
    const max = this.row.offsetWidth - w;
    this.follow(rubber(this.pointerX(e) + this.drag.offset, 0, max, 0.2));
    this.stretch.to(clamp((Math.abs(this.vel.push(e.clientX)) / 1000) * motion.elongation * 1.5, 0, 0.2));
  }

  up(e, cancelled) {
    if (!this.drag) return;
    const { moved } = this.drag;
    this.drag = null;
    this.stretch.to(0);
    let i = this.index;
    if (!cancelled) {
      const w = this.segWidth();
      i = moved ? Math.round(this.left.value / w) : Math.floor(this.pointerX(e) / w);
    }
    this.select(i, true);
    // Hold the lens a beat so a tap still shows it travelling.
    setTimeout(() => this.press.to(0), moved ? 60 : 160);
  }

  key(e) {
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    this.select(this.index + d, true);
    this.buttons[this.index].focus();
  }
}

class LgTabbar extends LgSegmented {
  itemRole = 'tab';
  groupRole = 'tablist';
  checkedAttr = 'aria-selected';
  lensZoom() {
    return 0.14;
  }
  lensGrow() {
    return [1.12, 1.22];
  }
}

/* ------------------------------------------------------------------------------------------------
 * <lg-menu value> : a trigger button and a [role=menu] panel that grows out of it.
 * ---------------------------------------------------------------------------------------------- */

class LgMenu extends HTMLElement {
  connectedCallback() {
    if (this.panel) return;
    this.trigger = this.querySelector(':scope > [slot=trigger]') || this.querySelector(':scope > button');
    this.panel = this.querySelector(':scope > [role=menu]');
    if (!this.trigger || !this.panel) return;
    this.trigger.setAttribute('aria-haspopup', 'menu');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.panel.classList.add('lg-menu-panel');
    this.panel.tabIndex = -1;
    if (!this.trigger.hasAttribute('data-glass') && !this.trigger.hasAttribute('data-plain')) glass(this.trigger);
    pressable(this.trigger);
    this.panelGlass = glass(this.panel, { ...presets.regular, blur: 4, dispersion: 0.18 });
    this.panelGlass.suspend();

    this.items = [...this.panel.querySelectorAll(':scope > button')];
    const selectable = this.hasAttribute('value');
    for (const it of this.items) {
      it.type = 'button';
      it.setAttribute('role', selectable && it.value ? 'menuitemradio' : 'menuitem');
      it.tabIndex = -1;
    }
    this.markValue();

    this.p = spring(0, { stiffness: motion.stiffness * 0.7, dampingRatio: motion.dampingRatio, precision: 0.0008 }, (v) => this.render(v));
    this.trigger.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    this.trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && !this.isOpen) {
        e.preventDefault();
        this.open();
      }
    });
    this.panel.addEventListener('click', (e) => {
      const it = e.target.closest('[role^=menuitem]');
      if (!it) return;
      if (it.getAttribute('role') === 'menuitemradio') {
        this.setAttribute('value', it.value);
        this.markValue();
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }
      this.dispatchEvent(new CustomEvent('select', { bubbles: true, detail: { item: it, value: it.value } }));
      this.close(true);
    });
    this.panel.addEventListener('keydown', (e) => this.key(e));
    this.outside = (e) => {
      if (!this.contains(e.target)) this.close();
    };
  }

  get value() {
    return this.getAttribute('value');
  }

  markValue() {
    for (const it of this.items) if (it.getAttribute('role') === 'menuitemradio') it.setAttribute('aria-checked', String(it.value === this.value));
  }

  place() {
    const t = this.trigger;
    const p = this.panel;
    const tr = t.getBoundingClientRect();
    const pw = p.offsetWidth;
    const ph = p.offsetHeight;
    const gap = 8;
    const below = tr.bottom + gap + ph < innerHeight || tr.top - gap - ph < 0;
    const alignEnd = tr.left + pw > innerWidth - 8;
    const left = alignEnd ? t.offsetLeft + t.offsetWidth - pw : t.offsetLeft;
    const top = below ? t.offsetTop + t.offsetHeight + gap : t.offsetTop - gap - ph;
    p.style.left = `${left}px`;
    p.style.top = `${top}px`;
    // Grow from the trigger: origin at the trigger's centre, in panel coordinates.
    this.origin = { x: t.offsetLeft + t.offsetWidth / 2 - left, y: t.offsetTop + t.offsetHeight / 2 - top };
    this.from = { sx: t.offsetWidth / pw, sy: t.offsetHeight / ph };
    p.style.transformOrigin = `${this.origin.x}px ${this.origin.y}px`;
  }

  render(v) {
    const p = this.panel;
    const k = clamp(v, 0, 1.2);
    const sx = this.from.sx + (1 - this.from.sx) * k;
    const sy = this.from.sy + (1 - this.from.sy) * k;
    p.style.transform = `scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
    p.style.opacity = clamp(v * 5, 0, 1).toFixed(3);
    const items = clamp((v - 0.35) / 0.5, 0, 1).toFixed(3);
    for (const it of this.items) it.style.opacity = items;
    this.trigger.style.opacity = clamp(1 - v * 1.6, 0, 1).toFixed(3);
    // Materialize: the lensing builds up as the panel grows, rather than the glass fading in.
    this.panelGlass.setStrength(clamp(v, 0, 1));
    this.panelGlass.requestSync();
    if (v <= 0.001 && this.p.target === 0) {
      p.removeAttribute('data-open');
      this.trigger.style.opacity = '';
      this.panelGlass.suspend();
    }
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.panel.setAttribute('data-open', '');
    this.panelGlass.resume();
    this.trigger.setAttribute('aria-expanded', 'true');
    this.place();
    this.p.to(1);
    document.addEventListener('pointerdown', this.outside, true);
    const checked = this.items.find((it) => it.getAttribute('aria-checked') === 'true');
    (checked || this.items[0])?.focus({ preventScroll: true });
  }

  close(refocus) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.trigger.setAttribute('aria-expanded', 'false');
    this.p.to(0);
    document.removeEventListener('pointerdown', this.outside, true);
    if (refocus) this.trigger.focus({ preventScroll: true });
  }

  key(e) {
    const i = this.items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      this.items[(i + d + this.items.length) % this.items.length].focus();
    } else if (e.key === 'Tab') this.close();
  }
}

/* ------------------------------------------------------------------------------------------------
 * <lg-sheet open> : bottom sheet, drag the grabber to dismiss.
 * ---------------------------------------------------------------------------------------------- */

class LgSheet extends HTMLElement {
  connectedCallback() {
    if (this.panel) return;
    this.scrim = h('div', 'lg-sheet-scrim');
    this.panel = h('div', 'lg-sheet-panel');
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    this.panel.tabIndex = -1;
    const grab = h('span', 'lg-sheet-grabber', this.panel);
    this.panel.append(...[...this.childNodes]);
    this.append(this.scrim, this.panel);
    this.panelGlass = glass(this.panel, { ...presets.regular });
    this.panelGlass.suspend();
    this.y = spring(1, { stiffness: 340, damping: 32, precision: 0.0005 }, (v) => this.render(v));
    this.render(1);

    this.scrim.addEventListener('click', () => this.close());
    this.addEventListener('keydown', (e) => e.key === 'Escape' && this.close());
    this.vel = new Velocity();
    grab.addEventListener('pointerdown', (e) => {
      grab.setPointerCapture(e.pointerId);
      this.drag = { y0: e.clientY, from: this.y.value };
      this.vel.reset(e.clientY);
    });
    grab.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const hgt = this.panel.offsetHeight + 8;
      const v = this.drag.from + (e.clientY - this.drag.y0) / hgt;
      this.y.set(v < 0 ? v * 0.2 : v);
      this.vel.push(e.clientY);
    });
    const release = () => {
      if (!this.drag) return;
      this.drag = null;
      const fling = this.vel.v / (this.panel.offsetHeight + 8);
      if (this.y.value > 0.3 || fling > 1.6) this.close(fling);
      else this.y.to(0, fling);
    };
    grab.addEventListener('pointerup', release);
    grab.addEventListener('pointercancel', release);
  }

  render(v) {
    const hgt = this.panel.offsetHeight + 8;
    this.panel.style.translate = `0 ${(v * hgt).toFixed(1)}px`;
    this.scrim.style.opacity = clamp(1 - v, 0, 1).toFixed(3);
    this.panelGlass.setStrength(clamp(1 - v, 0, 1));
    this.panelGlass.requestSync();
    if (v >= 0.999 && this.y.target === 1) {
      this.removeAttribute('open');
      this.panelGlass.suspend();
    }
  }

  open() {
    this.returnFocus = document.activeElement;
    this.setAttribute('open', '');
    this.panelGlass.resume();
    this.y.to(0);
    this.panel.focus({ preventScroll: true });
  }

  close(velocity) {
    this.y.to(1, typeof velocity === 'number' ? velocity : undefined);
    this.returnFocus?.focus?.({ preventScroll: true });
  }
}

customElements.define('lg-switch', LgSwitch);
customElements.define('lg-slider', LgSlider);
customElements.define('lg-segmented', LgSegmented);
customElements.define('lg-tabbar', LgTabbar);
customElements.define('lg-menu', LgMenu);
customElements.define('lg-sheet', LgSheet);
