// The mascot must draw every state without error and obey its state machine.
import { test } from "node:test";
import assert from "node:assert/strict";

function stubDom() {
  let fillRects = 0;
  const ctx = new Proxy({}, {
    get(_, p) {
      if (p === "fillRect") return () => { fillRects++; };
      if (p === "clearRect") return () => {};
      return undefined;
    },
    set() { return true; },
  });
  globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, devicePixelRatio: 1 };
  globalThis.document = { hidden: false, addEventListener() {} };
  globalThis.performance = { now: () => globalThis.__t || 0 };
  globalThis.requestAnimationFrame = () => {};
  const canvas = {
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 260, height: 260 }),
    width: 260, height: 260,
  };
  return { canvas, fillRects: () => fillRects };
}

test("draws all states without throwing and actually paints", async () => {
  const { canvas, fillRects } = stubDom();
  const { Mascot, STATE_LABELS } = await import("../web/js/mascot.js");
  const m = new Mascot(canvas, { onLabel() {} });
  for (const s of Object.keys(STATE_LABELS)) {
    m.setActivity(s);
    for (let f = 0; f < 4; f++) {
      globalThis.__t = f * 120;
      assert.doesNotThrow(() => m._draw(globalThis.__t), `state ${s} draws`);
    }
  }
  assert.ok(fillRects() > 0, "mascot paints pixels");
});

test("success is one-shot and reverts to idle", async () => {
  const { canvas } = stubDom();
  const { Mascot } = await import("../web/js/mascot.js");
  const m = new Mascot(canvas, { onLabel() {} });
  globalThis.__t = 100000;
  m.setActivity("success");
  assert.equal(m.state, "success");
  globalThis.__t = 100000 + 1600;
  m._loop(globalThis.__t);
  assert.equal(m.state, "idle");
});

test("min-dwell debounces rapid switches", async () => {
  const { canvas } = stubDom();
  const { Mascot } = await import("../web/js/mascot.js");
  const m = new Mascot(canvas, { onLabel() {} });
  globalThis.__t = 200000;
  m.state = "thinking"; m.target = "thinking"; m.lastSwitch = 200000; m.oneShotUntil = 0;
  m.setActivity("typing");
  globalThis.__t = 200000 + 50;
  m._loop(globalThis.__t);
  assert.equal(m.state, "thinking", "held during dwell");
  globalThis.__t = 200000 + 200;
  m._loop(globalThis.__t);
  assert.equal(m.state, "typing", "switched after dwell");
});
