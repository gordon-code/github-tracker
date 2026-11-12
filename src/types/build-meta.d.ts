// Build-time metadata constants injected via Vite `define`.
declare const __APP_VERSION__: string;
declare const __GIT_SHA__: string;
declare const __SCHEMA_FP__: string;

declare module "virtual:changelog" {
  import type { ChangelogEntry } from "../shared/changelog-schema";
  const entries: ChangelogEntry[];
  export default entries;
}
