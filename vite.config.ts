import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },


  build: {
    // Split heavy third-party libs into their own chunks so the main
    // bundle stays small on cold start. Each chunk is fetched lazily
    // when the feature that needs it actually mounts (see BlueprintNode,
    // PanoramaPanel, AnnotateToolEditor — all wrapped in React.lazy).
    rolldownOptions: {
      // Remove chatty production diagnostics, but retain warnings/errors and
      // side effects in call arguments. Development console output is untouched.
      treeshake: {
        manualPureFunctions: ['console.log', 'console.info', 'console.debug', 'console.trace'],
      },
      output: {
        codeSplitting: {
          groups: [
            { name: 'three', test: /\/node_modules\/three\// },
            { name: 'konva', test: /\/node_modules\/(?:konva|react-konva)\// },
            { name: 'pano', test: /\/node_modules\/@photo-sphere-viewer\/core\// },
            { name: 'markdown', test: /\/node_modules\/(?:react-markdown|remark-gfm|remark-breaks)\// },
            { name: 'reactflow', test: /\/node_modules\/@xyflow\// },
            { name: 'react-vendor', test: /\/node_modules\/(?:react|react-dom|scheduler)\// },
          ],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
