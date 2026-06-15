// Pixie the mascot: a coral pixel creature rendered procedurally on a canvas.
// It acts out what the agent is doing - typing, reading, searching, running,
// debugging - via a small finite state machine with min-dwell debouncing and
// one-shot success/error states.

const PALETTE = {
  body: "#d97757",
  bodyHi: "#e8a085",
  bodyLo: "#b85d40",
  eye: "#2b2a27",
  white: "#f7f4ec",
  ink: "#3a3833",
  paper: "#f4efe2",
  pencil: "#e3b341",
  glass: "#bfe0e8",
  green: "#7db36a",
  red: "#e0594e",
  term: "#1a1915",
  termText: "#7db36a",
  spark: "#f0c674",
  bug: "#4a4640",
  shadow: "rgba(0,0,0,0.18)",
};

const SCENE_W = 34;
const SCENE_H = 32;
const MIN_DWELL = 150; // ms - stops strobing between typing/thinking on bursts
const ONESHOT_MS = 1500;

// Map incoming agent activity strings to mascot states.
const STATE_LABELS = {
  idle: "Resting",
  thinking: "Thinking",
  typing: "Typing",
  reading: "Reading",
  writing: "Editing",
  searching: "Searching",
  running: "Running",
  debugging: "Debugging",
  success: "Done!",
  error: "Uh oh",
  waiting: "Waiting for you",
};

export class Mascot {
  constructor(canvas, { onLabel } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onLabel = onLabel || (() => {});
    this.state = "idle";
    this.target = "idle";
    this.lastSwitch = 0;
    this.oneShotUntil = 0;
    this.t0 = performance.now();
    this.blinkAt = 0;
    this.running = true;
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this._resize();
    window.addEventListener("resize", () => this._resize());
    document.addEventListener("visibilitychange", () => {
      this.running = !document.hidden;
      if (this.running) requestAnimationFrame((t) => this._loop(t));
    });
    requestAnimationFrame((t) => this._loop(t));
  }

  setActivity(state) {
    if (!STATE_LABELS[state]) state = "thinking";
    const now = performance.now();
    if (state === "success" || state === "error") {
      this.state = state;
      this.target = state;
      this.oneShotUntil = now + ONESHOT_MS;
      this.lastSwitch = now;
      this.onLabel(STATE_LABELS[state]);
      return;
    }
    this.target = state;
    this.onLabel(STATE_LABELS[state]);
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(160, rect.width || 280);
    const h = Math.max(160, rect.height || 280);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.ctx.imageSmoothingEnabled = false;
    this.W = this.canvas.width;
    this.H = this.canvas.height;
    this.u = Math.floor(Math.min(this.W / SCENE_W, this.H / SCENE_H));
    this.ox = Math.floor((this.W - SCENE_W * this.u) / 2);
    this.oy = Math.floor((this.H - SCENE_H * this.u) / 2);
  }

  _loop(now) {
    if (!this.running) return;
    // Resolve target with min-dwell, unless mid one-shot.
    if (now > this.oneShotUntil) {
      if (this.state !== this.target && now - this.lastSwitch >= MIN_DWELL) {
        this.state = this.target;
        this.lastSwitch = now;
      }
      if ((this.state === "success" || this.state === "error") && now > this.oneShotUntil) {
        this.state = this.target === this.state ? "idle" : this.target;
        this.target = this.state;
      }
    }
    this._draw(now);
    requestAnimationFrame((t) => this._loop(t));
  }

  // --- drawing helpers (scene-cell coordinates) ---
  _rect(x, y, w, h, color) {
    const u = this.u;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(this.ox + Math.round(x * u), this.oy + Math.round(y * u), Math.ceil(w * u), Math.ceil(h * u));
  }
  _dot(x, y, color) { this._rect(x, y, 1, 1, color); }

  _draw(now) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);
    const t = this.reduced ? 0 : (now - this.t0) / 1000;
    const state = this.state;

    // Gentle vertical bob; success jumps higher.
    let bob = Math.sin(t * 3) * 0.5;
    if (state === "success") bob = -Math.abs(Math.sin(t * 9)) * 2.2;
    let shake = 0;
    if (state === "error") shake = Math.sin(t * 40) * 0.6;

    // blink timing
    if (now > this.blinkAt) this.blinkAt = now + 2200 + Math.random() * 2600;
    const blinking = !this.reduced && now > this.blinkAt - 140;

    // shadow
    this._rect(11.5, 25.5, 11, 1.4, PALETTE.shadow);

    this._drawProps(state, t, now);

    const bx = 10 + shake;
    const by = 8 + bob;
    this._drawCreature(bx, by, state, t, blinking);

    this._drawOverlays(state, t, now, bx, by);
  }

  _drawCreature(bx, by, state, t, blinking) {
    const BW = 14, BH = 11;
    const body = PALETTE.body;

    // legs (4) with a little wiggle
    const lp = Math.sin(t * 6);
    const legXs = [bx + 1.5, bx + 4.5, bx + BW - 5.5, bx + BW - 2.5];
    legXs.forEach((lx, i) => {
      const off = state === "running" || state === "searching" ? Math.sin(t * 8 + i) * 0.4 : lp * 0.2 * (i % 2 ? 1 : -1);
      this._rect(lx, by + BH - 0.5 + off, 1.6, 2.6, PALETTE.bodyLo);
    });

    // antennae
    const sway = Math.sin(t * 2.2) * 0.5;
    const pulse = state === "thinking" ? Math.abs(Math.sin(t * 5)) * 0.6 : 0;
    for (const side of [-1, 1]) {
      const ax = side < 0 ? bx + 3 : bx + BW - 4;
      this._rect(ax, by - 2.4 - pulse, 1, 2.8 + pulse, body);
      this._rect(ax - 0.6 + side * sway, by - 3.6 - pulse, 2.2, 1.6, PALETTE.bodyHi);
    }

    // body (rounded by trimming corners)
    this._rect(bx + 1, by, BW - 2, BH, body);
    this._rect(bx, by + 1, BW, BH - 2, body);
    // soft top highlight + bottom shade
    this._rect(bx + 2, by + 0.6, BW - 4, 1, PALETTE.bodyHi);
    this._rect(bx + 1, by + BH - 1.4, BW - 2, 1.4, PALETTE.bodyLo);

    // eyes
    this._drawEyes(bx, by, BW, state, t, blinking);

    // mouth
    this._drawMouth(bx, by, BW, BH, state, t);
  }

  _drawEyes(bx, by, BW, state, t, blinking) {
    const eyeY = by + 3.4;
    const lx = bx + 3.3, rx = bx + BW - 5.3;
    const look = state === "reading" ? Math.sin(t * 3) * 0.8 : state === "searching" ? Math.sin(t * 2) * 0.6 : 0;
    const up = state === "thinking" ? -0.7 : 0;

    const drawEye = (ex) => {
      if (state === "success") {
        // happy ^ ^
        this._rect(ex, eyeY + 0.6, 1, 1, PALETTE.eye);
        this._rect(ex + 1, eyeY, 1, 1, PALETTE.eye);
        this._rect(ex + 2, eyeY + 0.6, 1, 1, PALETTE.eye);
        return;
      }
      if (state === "error") {
        // x x
        this._rect(ex, eyeY, 1, 1, PALETTE.eye);
        this._rect(ex + 2, eyeY, 1, 1, PALETTE.eye);
        this._rect(ex + 1, eyeY + 1, 1, 1, PALETTE.eye);
        this._rect(ex, eyeY + 2, 1, 1, PALETTE.eye);
        this._rect(ex + 2, eyeY + 2, 1, 1, PALETTE.eye);
        return;
      }
      if (blinking) {
        this._rect(ex, eyeY + 1.4, 3, 0.8, PALETTE.eye);
        return;
      }
      this._rect(ex, eyeY, 3, 3.2, PALETTE.eye);
      // glint / pupil direction
      this._rect(ex + 1.7 + look, eyeY + 0.4 + up, 0.9, 0.9, PALETTE.white);
    };
    drawEye(lx);
    drawEye(rx);
  }

  _drawMouth(bx, by, BW, BH, state, t) {
    const mx = bx + BW / 2 - 1.5;
    const my = by + BH - 3.4;
    if (state === "success") {
      this._rect(mx, my, 0.8, 1, PALETTE.bodyLo);
      this._rect(mx + 0.8, my + 0.8, 1.6, 0.8, PALETTE.bodyLo);
      this._rect(mx + 2.4, my, 0.8, 1, PALETTE.bodyLo);
    } else if (state === "error" || state === "debugging") {
      this._rect(mx + 0.4, my + 0.8, 2.4, 0.8, PALETTE.bodyLo);
      this._rect(mx, my + 0.2, 0.8, 0.8, PALETTE.bodyLo);
      this._rect(mx + 2.6, my + 0.2, 0.8, 0.8, PALETTE.bodyLo);
    } else if (state === "thinking") {
      this._rect(mx + 0.8, my + 0.6, 1.6, 0.8, PALETTE.bodyLo);
    } else {
      this._rect(mx + 0.4, my + 0.4, 2.4, 0.8, PALETTE.bodyLo);
    }
  }

  // props in front of / around the creature per state
  _drawProps(state, t, now) {
    if (state === "typing" || state === "running" || state === "debugging") {
      // a little laptop the creature works at
      const lx = 12, ly = 21.5;
      this._rect(lx, ly + 3, 10, 1.2, PALETTE.bodyLo); // base
      this._rect(lx + 0.5, ly - 4, 9, 7, PALETTE.ink); // screen frame
      if (state === "running") {
        this._rect(lx + 1.2, ly - 3.2, 7.6, 5.4, PALETTE.term);
        // blinking prompt + scrolling lines
        this._rect(lx + 2, ly - 2.4, 1, 0.8, PALETTE.termText);
        if (Math.floor(t * 2) % 2) this._rect(lx + 3.2, ly - 2.4, 1.6, 0.8, PALETTE.termText);
        this._rect(lx + 2, ly - 1, 4, 0.7, "rgba(125,179,106,0.6)");
        this._rect(lx + 2, ly + 0.1, 5.4, 0.7, "rgba(125,179,106,0.4)");
      } else {
        this._rect(lx + 1.2, ly - 3.2, 7.6, 5.4, PALETTE.glass);
        // code lines
        for (let i = 0; i < 3; i++) this._rect(lx + 2, ly - 2.4 + i * 1.4, 4 + (i % 2) * 2, 0.7, "rgba(43,42,39,0.45)");
        if (state === "debugging") this._rect(lx + 6.5, ly - 1, 1, 0.9, PALETTE.red);
      }
    }
  }

  _drawOverlays(state, t, now, bx, by) {
    if (state === "thinking") {
      // rising dots / question mark above the head
      for (let i = 0; i < 3; i++) {
        const ph = (t * 1.2 + i * 0.4) % 1;
        const y = by - 4 - ph * 4;
        const x = bx + 11 + i * 1.4;
        this._rect(x, y, 1 + i * 0.2, 1 + i * 0.2, `rgba(217,119,87,${1 - ph})`);
      }
    }
    if (state === "reading") {
      // a document held up front
      const dx = 13, dy = 18;
      this._rect(dx, dy, 8, 6, PALETTE.paper);
      this._rect(dx - 0.4, dy - 0.4, 8.8, 0.6, PALETTE.bodyLo);
      const scan = Math.floor((Math.sin(t * 3) * 0.5 + 0.5) * 3);
      for (let i = 0; i < 4; i++) {
        this._rect(dx + 1, dy + 1 + i * 1.2, i === scan ? 6 : 5, 0.7, i === scan ? PALETTE.body : PALETTE.ink);
      }
    }
    if (state === "writing") {
      // paper + a pencil scribbling
      const dx = 12.5, dy = 19;
      this._rect(dx, dy, 9, 6, PALETTE.paper);
      const prog = (Math.sin(t * 2) * 0.5 + 0.5);
      this._rect(dx + 1, dy + 1.5, 1 + prog * 6, 0.7, PALETTE.ink);
      this._rect(dx + 1, dy + 3, 1 + ((prog + 0.3) % 1) * 6, 0.7, PALETTE.ink);
      // pencil
      const px = dx + 1 + prog * 6;
      this._rect(px, dy + 0.2, 1, 3.4, PALETTE.pencil);
      this._rect(px, dy + 3.4, 1, 0.8, PALETTE.ink);
    }
    if (state === "searching") {
      // a magnifier sweeping an arc
      const cx = bx + 7 + Math.cos(t * 2) * 6;
      const cy = by + 14 + Math.sin(t * 2) * 3;
      this._ring(cx, cy, 2.4, PALETTE.ink);
      this._rect(cx + 0.4, cy + 0.4, 1.6, 1.6, PALETTE.glass);
      this._rect(cx + 2, cy + 2, 2.4, 1, PALETTE.ink); // handle
      if (Math.floor(t * 3) % 2) this._dot(cx - 3, cy - 3, PALETTE.spark);
    }
    if (state === "debugging") {
      // a bug scuttling along the floor, with a sweat/!
      const bxg = 9 + ((t * 4) % 16);
      const jit = Math.sin(t * 30) * 0.3;
      this._rect(bxg, 24 + jit, 2.4, 1.6, PALETTE.bug);
      this._dot(bxg - 0.6, 24 + jit, PALETTE.bug);
      this._dot(bxg + 2.4, 24 + jit, PALETTE.bug);
      this._dot(bxg + 0.4, 23.4 + jit, PALETTE.red); // eye
      if (Math.floor(t * 2) % 2) {
        this._rect(bx + 12, by - 3, 0.9, 2, PALETTE.red); // !
        this._dot(bx + 12, by - 0.6, PALETTE.red);
      }
    }
    if (state === "success") {
      // sparkles + a check
      const spk = [[6, 4], [26, 6], [28, 18], [5, 16]];
      spk.forEach(([x, y], i) => {
        if (Math.floor(t * 6 + i) % 2) {
          this._dot(x, y - Math.sin(t * 4 + i) * 1.5, PALETTE.spark);
          this._dot(x + 1, y - 1 - Math.sin(t * 4 + i) * 1.5, PALETTE.white);
        }
      });
      // check mark badge
      this._rect(24, 20, 1, 1, PALETTE.green);
      this._rect(25, 21, 1, 1, PALETTE.green);
      this._rect(26, 20, 1, 1, PALETTE.green);
      this._rect(27, 19, 1, 1, PALETTE.green);
      this._rect(28, 18, 1, 1, PALETTE.green);
    }
    if (state === "error") {
      // sweat drop
      this._rect(bx + 13, by + 2, 1, 1.6, PALETTE.glass);
      this._dot(bx + 13, by + 3.4, PALETTE.glass);
    }
  }

  _ring(cx, cy, r, color) {
    // crude pixel ring
    const steps = 16;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      this._dot(cx + Math.cos(a) * r, cy + Math.sin(a) * r, color);
    }
  }
}

export { STATE_LABELS };
