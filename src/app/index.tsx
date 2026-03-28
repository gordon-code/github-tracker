import "./index.css";
import { render } from "solid-js/web";
import { initSentry } from "./lib/sentry";
import App from "./App";

// Initialize Sentry before rendering — captures errors from first paint.
// No-ops in dev/test (guarded by import.meta.env.DEV check).
initSentry();

render(() => <App />, document.getElementById("app")!);
