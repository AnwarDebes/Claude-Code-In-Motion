// Shared test helpers: a mock LLM server writer and an SSE collector.
// Not a test file itself (the npm script only runs *.test.js).

export function writeSSE(res, objs) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const o of objs) res.write(`data: ${JSON.stringify(o)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

export function writeRaw(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(c);
  res.end();
}

export async function collect(url) {
  const events = [];
  const waiters = [];
  const res = await fetch(url + "/api/events");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  (async () => {
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split("\n").find((l) => l.startsWith("data:"));
        if (line) {
          try {
            const e = JSON.parse(line.slice(5).trim());
            events.push(e);
            for (let k = waiters.length - 1; k >= 0; k--) {
              if (waiters[k].pred(e)) { waiters[k].resolve(e); waiters.splice(k, 1); }
            }
          } catch { /* ignore non-json (comments) */ }
        }
      }
    }
  })();
  return {
    events,
    cancel: () => reader.cancel().catch(() => {}),
    waitFor(pred, ms = 5000) {
      const found = events.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error("timeout waiting for event")), ms);
      });
    },
  };
}

export function post(url, path, body) {
  return fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}
