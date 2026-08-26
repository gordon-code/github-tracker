import { afterEach, beforeEach, vi } from "vitest";

// Network guard for the happy-dom unit-test suite (the "browser" project in
// vitest.workspace.ts). An unmocked fetch launches a real request via happy-dom;
// when vitest tears down the window it aborts pending requests, and happy-dom's
// abort path double-closes the response body stream ("Invalid state: Controller
// is already closed"), which surfaces as an uncaught error that fails the whole
// file — intermittently, since it only bites when the request is still in flight
// at teardown (i.e. under CI parallelism). Defaulting fetch to a fast network
// error makes a forgotten stub fail cheaply and deterministically instead of
// leaking a live request. Tests that need responses override this per-test with
// vi.stubGlobal("fetch", ...).
//
// Deliberately NOT part of tests/setup.ts: the live-network smoke suite
// (vitest.smoke.config.ts / *.smoke.test.ts) extends vitest.config.ts and shares
// tests/setup.ts, but must reach the real network. Wiring this guard only into
// the workspace browser project keeps the smoke suite unguarded.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.reject(
        new TypeError('Unmocked fetch in a unit test — stub it with vi.stubGlobal("fetch", ...)'),
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});
