import { Buffer } from 'node:buffer';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const stripConsoleApi = (code) => code.replace(
  /\bconsole\s*\.\s*(?:log|debug|info|warn|error|trace|table|dir|assert|group|groupCollapsed|groupEnd|time|timeEnd|timeLog|count|countReset|clear|profile|profileEnd)\b/g,
  '(()=>{})',
);

const consoleFreeBrowserOutput = {
  name: 'console-free-browser-output',
  apply: 'build',
  generateBundle(_options, bundle) {
    Object.values(bundle).forEach((output) => {
      if (output.type === 'chunk') {
        output.code = stripConsoleApi(output.code);
        return;
      }

      if (!/\.(?:m?js|html)$/.test(output.fileName)) return;
      const source = typeof output.source === 'string'
        ? output.source
        : Buffer.from(output.source).toString('utf8');
      output.source = stripConsoleApi(source);
    });
  },
};

export default defineConfig({
  plugins: [react(), consoleFreeBrowserOutput],
  esbuild: {
    drop: ['console'],
  },
  server: {
    port: 5173,
  },
});
