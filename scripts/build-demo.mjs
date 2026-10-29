// Builds the static GitHub Pages demo into ./demo: the real frontend plus the server bundled for the browser.
import { build } from 'esbuild';
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'demo');
const shim = (f) => join(root, 'demo-src/shims', f);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'public'), out, { recursive: true });
cpSync(join(root, 'node_modules/sql.js/dist/sql-wasm.wasm'), join(out, 'sql-wasm.wasm'));

await build({
  entryPoints: [join(root, 'demo-src/main.js')],
  outfile: join(out, 'carehours-demo.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  loader: { '.sql': 'text' },
  inject: [shim('inject.js')],
  alias: {
    'node:sqlite': shim('sqlite.js'), 'node:crypto': shim('crypto.js'), 'node:fs': shim('fs.js'),
    'node:path': shim('path.js'), 'node:os': shim('os.js'), express: shim('express.js'),
    fs: shim('fs.js'), path: shim('path.js'), crypto: shim('crypto.js'),
  },
  define: { __dirname: '"/app"' },
  logLevel: 'warning',
});

// Demo page: relative paths (served from /home-care-agency/demo/) and a clear demo banner.
let html = readFileSync(join(root, 'public/index.html'), 'utf8')
  .replace('href="/css/styles.css"', 'href="css/styles.css"')
  .replace('<title>CareHours</title>', '<title>CareHours Demo</title>')
  .replace('<script type="module" src="/js/app.js"></script>', '<script src="carehours-demo.js"></script>')
  .replace('<div id="root">', `<div class="demo-banner" role="note"><strong>Demo</strong> · Runs entirely in your browser with fictional SAMPLE data. Do not enter real client information.
    Sign in as <code>admin</code>, <code>sample.manager</code>, <code>sample.nurse</code> or caregiver <code>maria.sample</code> — password <code>Demo-Pass-2026</code>.
    <a href="?reset">Reset demo data</a></div>\n  <div id="root">`);
writeFileSync(join(out, 'index.html'), html);
writeFileSync(join(out, 'css/styles.css'), readFileSync(join(out, 'css/styles.css'), 'utf8') +
  `\n/* demo banner */\n.demo-banner { background: #6b4fbf; color: #fff; padding: .5rem 1rem; font-size: .85rem; text-align: center; position: relative; z-index: 70; }\n.demo-banner code { background: rgba(255,255,255,.18); color: #fff; }\n.demo-banner a { color: #fff; font-weight: 600; margin-left: .5rem; }\n`);
console.log('Demo built in ./demo');
