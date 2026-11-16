import "./index.css";
import { render } from "solid-js/web";
import { installEarlyErrorCapture, startSentryLoad } from "./lib/sentry-facade";
import { installChunkReloadHandler } from "./lib/chunk-reload";
import App from "./App";

// Capture early errors synchronously before first paint, then lazy-load the
// Sentry SDK on idle after render. No-ops in dev/test or without DSN.
installEarlyErrorCapture();
installChunkReloadHandler();

render(() => <App />, document.getElementById("app")!);

startSentryLoad();
