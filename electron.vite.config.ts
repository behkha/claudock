import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')
// scripts/shot.mjs builds into its own folder so parallel runs never clobber each other.
const out = resolve(__dirname, process.env.CLAUDOCK_OUT_DIR || 'out')

/** Strict CSP for production builds only (the dev server needs inline scripts for HMR; src/main/index.ts sends the dev policy as a header). Keep in sync with `cspFor()` in src/main/index.ts. */
const csp = {
  name: 'claudock-csp',
  apply: 'build' as const,
  transformIndexHtml: (html: string): string =>
    html.replace(
      '<meta charset="UTF-8" />',
      `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; worker-src 'self'; base-uri 'none'; form-action 'none'" />`
    )
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    define: { __APP_VERSION__: JSON.stringify((JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version) },
    build: { outDir: resolve(out, 'main'), rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: { outDir: resolve(out, 'preload'), rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@shared': shared, '@': resolve(__dirname, 'src/renderer') } },
    plugins: [react(), csp],
    build: { outDir: resolve(out, 'renderer'), rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } }
  }
})
