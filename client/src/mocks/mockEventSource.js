// Hand-written stand-in for EventSource, emitting the same SSEEvent shape as
// GET /api/explore/stream/:sessionId and GET /api/demo/replay.
// Used by tests (manual control) and by the browser when the page has ?mock.

export const FAKE_EVENTS = [
  { type: "node", delayMs: 300, data: { id: "n1", file: "src/index.js", role: "App entry point, sets up the server.", imports: [], importance: "core" } },
  { type: "node", delayMs: 500, data: { id: "n2", file: "src/routes/api.js", role: "Defines the main API routes.", imports: ["src/index.js", "src/db.js"], importance: "core" } },
  { type: "node", delayMs: 500, data: { id: "n3", file: "src/utils/helpers.js", role: "Shared utility functions used across routes.", imports: ["src/routes/api.js"], importance: "support" } },
  { type: "node", delayMs: 500, data: { id: "n4", file: "config/settings.json", role: "Environment configuration values.", imports: [], importance: "config" } },
  // Arrives after api.js, so api.js -> db.js only gets its line once this node renders.
  { type: "node", delayMs: 600, data: { id: "n5", file: "src/db.js", role: "Database connection pool.", imports: ["config/settings.json"], importance: "support" } },
  { type: "node", delayMs: 500, data: { id: "n6", file: "src/legacy/oldHandler.js", role: "An older request handler that nothing currently imports.", imports: [], importance: "support" } },
  { type: "done", delayMs: 800, data: { issue: "src/legacy/oldHandler.js is never imported anywhere — likely dead code.", evidence: "No other file references oldHandler.js.", files: ["src/legacy/oldHandler.js"] } },
];

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

/**
 * Returns an EventSource-compatible class.
 * - With `events`, each instance opens and plays them back on timers (like the demo replay).
 * - Without, the instance stays silent and tests drive it via open()/emit()/fail().
 */
export function createMockEventSource({ events = null, speed = 1 } = {}) {
  return class MockEventSource {
    static instances = [];

    constructor(url) {
      this.url = url;
      this.readyState = CONNECTING;
      this.listeners = {};
      this.timers = [];
      this.onopen = null;
      this.onerror = null;
      this.onmessage = null;
      MockEventSource.instances.push(this);
      if (events) this.play(events, speed);
    }

    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }

    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
    }

    close() {
      this.readyState = CLOSED;
      this.timers.forEach(clearTimeout);
      this.timers = [];
    }

    open() {
      this.readyState = OPEN;
      this.dispatch("open", { type: "open" });
    }

    emit(type, data) {
      this.dispatch(type, { type, data: typeof data === "string" ? data : JSON.stringify(data) });
    }

    // Simulates a network failure: an error event with no data.
    fail() {
      this.dispatch("error", { type: "error" });
    }

    dispatch(type, event) {
      if (this.readyState === CLOSED) return;
      (this.listeners[type] || []).forEach((fn) => fn(event));
      this[`on${type}`]?.(event);
    }

    play(list, speedFactor) {
      let t = 0;
      this.timers.push(setTimeout(() => this.open(), 0));
      for (const evt of list) {
        t += (evt.delayMs ?? 400) / speedFactor;
        this.timers.push(setTimeout(() => this.emit(evt.type, evt.data), t));
      }
    }
  };
}
