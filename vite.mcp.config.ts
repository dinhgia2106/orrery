// Bundles the MCP server (src/mcp/server.ts) for Node: `npm run build:mcp` → dist-mcp/server.mjs.
// Sketch, docs and prebuilt .hex files are inlined; npm packages stay external and load from node_modules.
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'src/mcp/server.ts',
    outDir: 'dist-mcp',
    emptyOutDir: true,
    target: 'node18',
    minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'server.mjs' } },
  },
});
