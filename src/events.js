// A tiny Server-Sent-Events hub. The agent emits normalized events; every
// connected browser tab receives them. Keeps a small replay buffer so a tab that
// reconnects (Last-Event-ID) does not miss events.
export class EventHub {
  constructor({ bufferSize = 2000 } = {}) {
    this.clients = new Set();
    this.buffer = [];
    this.bufferSize = bufferSize;
    this.seq = 0;
  }

  addClient(res, lastEventId) {
    this.clients.add(res);
    // Replay anything the client missed.
    if (lastEventId != null) {
      const from = Number(lastEventId);
      // If the buffer rolled past the client's last id, it cannot fully catch
      // up - tell it so it can resync instead of resuming with a hole.
      if (this.buffer.length && from < this.buffer[0]._id - 1) {
        this.#write(res, { type: "resync", t: Date.now(), _id: this.seq });
      }
      for (const e of this.buffer) {
        if (e._id > from) this.#write(res, e);
      }
    }
    res.on("close", () => this.clients.delete(res));
  }

  removeClient(res) {
    this.clients.delete(res);
  }

  emit(type, data = {}) {
    const event = { type, t: Date.now(), ...data, _id: ++this.seq };
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    for (const res of this.clients) this.#write(res, event);
    return event;
  }

  #write(res, event) {
    try {
      res.write(`id: ${event._id}\n`);
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      this.clients.delete(res);
    }
  }
}
