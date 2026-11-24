import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stubsDir = dirname(fileURLToPath(import.meta.url));

/**
 * Vite `resolve`/`define` settings that stand in for the build-meta plugin
 * (`vite-plugins/build-meta.ts`) in every Vitest config: the `virtual:changelog`
 * module is aliased to a fixture and the build constants get fixed values.
 */
export const buildMetaTestConfig = {
  resolve: {
    alias: {
      "virtual:changelog": resolve(stubsDir, "virtual-changelog.ts"),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify("0.1.0"),
    __GIT_SHA__: JSON.stringify("abcdef123456"),
    __SCHEMA_FP__: JSON.stringify("0123456789ab"),
  },
};
