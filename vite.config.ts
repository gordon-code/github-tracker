import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [solid(), tailwindcss(), cloudflare()],
  build: {
    outDir: "dist",
  },
});
