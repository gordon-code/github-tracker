import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { visualizer } from "rollup-plugin-visualizer";

export default defineConfig({
  plugins: [
    solid(),
    tailwindcss(),
    cloudflare(),
    ...(process.env.BUNDLE_REPORT === "1"
      ? [
          {
            ...visualizer({
              template: "raw-data",
              filename: "dist-report/stats.json",
            }),
            applyToEnvironment: (env: { name: string }) => env.name === "client",
          },
        ]
      : []),
  ],
  build: {
    outDir: "dist",
  },
  environments: {
    client: {
      build: {
        assetsDir: "_app",
      },
    },
  },
});
