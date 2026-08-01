#!/usr/bin/env node
/**
 * Slag — single-file build.
 *
 * Inlines `index.html`, `styles.css` and the whole `src/` ES-module graph into
 * one self-contained `dist/slag.html` that runs by double-clicking it, without
 * any web server (`file://` blocks ES modules because of CORS — a classic
 * `<script>` is not affected).
 *
 * How it works
 * ------------
 * 1. Starting from the entry module referenced by the `<script type="module">`
 *    tag in `index.html`, the import graph is walked depth-first and ordered so
 *    that every module comes after its dependencies (topological order).
 * 2. Every module body keeps its own scope: it is emitted inside its own IIFE
 *    and publishes its exports into a shared registry object. This is what lets
 *    two modules have identically named *private* helpers without clashing.
 * 3. `import` statements are rewritten into destructuring reads from that
 *    registry, and the leading `export` keyword is stripped from declarations.
 * 4. Everything ends up in ONE classic (non-module) `<script>` at the end of
 *    `<body>`, wrapped in an IIFE and deferred until the DOM is ready — which
 *    matches the deferred execution semantics of `<script type="module">`.
 *
 * Usage:
 *   node tools/build-single.mjs
 *   node tools/build-single.mjs --out dist/slag.html --html index.html
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const DEFAULT_HTML = path.join(REPO_ROOT, 'index.html');
const DEFAULT_OUT = path.join(REPO_ROOT, 'dist', 'slag.html');
const FALLBACK_ENTRY = path.join(REPO_ROOT, 'src', 'main.js');

/** Registry variable name used inside the generated bundle. */
const REGISTRY = '__slagModules';

/**
 * Base directory the registry keys are relative to. Normally the repository
 * root; `main()` moves it when someone builds a project from elsewhere so that
 * the keys stay readable instead of turning into `../../..` chains.
 */
let keyBase = REPO_ROOT;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class BuildError extends Error {}

/** @param {string} absolutePath @returns {string} base-relative, forward slashes */
function rel(absolutePath) {
  return path.relative(keyBase, absolutePath).split(path.sep).join('/');
}

/** @param {string} value @returns {string} a double-quoted JS string literal */
function q(value) {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Module parsing
// ---------------------------------------------------------------------------

/**
 * `import <clause> from '<spec>';` — the clause may span multiple lines.
 * `\bfrom\b` keeps identifiers such as `fromIndex` from being mistaken for the
 * `from` keyword.
 */
const IMPORT_FROM_RE = /^[ \t]*import\s+([\s\S]*?)\s*\bfrom\b\s*(['"])([^'"]+)\2\s*;?[ \t]*$/gm;

/** `import '<spec>';` — side-effect only import. */
const IMPORT_BARE_RE = /^[ \t]*import\s*(['"])([^'"]+)\1\s*;?[ \t]*$/gm;

/** `export { a, b as c };` */
const EXPORT_LIST_RE = /^[ \t]*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm;

/** The `export` keyword in front of a declaration. */
const EXPORT_KEYWORD_RE = /^export\s+(?=(?:const|let|var|function|class|async)\b)/gm;

/**
 * @typedef {object} ImportRecord
 * @property {string} statement the full source text of the import statement
 * @property {string} spec the raw specifier, e.g. `./config.js`
 * @property {string} target absolute path of the imported module
 * @property {Array<{ imported: string, local: string }>} names named imports
 * @property {string|null} namespace local name of `import * as ns`
 * @property {boolean} sideEffectOnly
 */

/**
 * @typedef {object} ModuleRecord
 * @property {string} file absolute path
 * @property {string} key repo-relative registry key
 * @property {string} source original text
 * @property {ImportRecord[]} imports
 * @property {Array<{ local: string, exported: string }>} exports
 */

/**
 * Splits an import clause such as `{ a, b as c }`, `* as ns` or `Foo`.
 *
 * @param {string} clause
 * @param {string} where human readable location for error messages
 * @returns {{ names: Array<{imported: string, local: string}>, namespace: string|null }}
 */
function parseImportClause(clause, where) {
  const trimmed = clause.trim();

  const namespaceMatch = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
  if (namespaceMatch) {
    return { names: [], namespace: namespaceMatch[1] };
  }

  const bracesMatch = /^\{([\s\S]*)\}$/.exec(trimmed);
  if (!bracesMatch) {
    throw new BuildError(
      `Nem támogatott import forma itt: ${where}\n  -> ${trimmed}\n` +
        '  Csak `import { a, b as c } from "./x.js"` és `import * as ns from "./x.js"` támogatott ' +
        '(alapértelmezett export nincs a projektben).',
    );
  }

  const names = bracesMatch[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const aliased = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part);
      if (aliased) return { imported: aliased[1], local: aliased[2] };
      if (!/^[A-Za-z_$][\w$]*$/.test(part)) {
        throw new BuildError(`Értelmezhetetlen import-elem itt: ${where}\n  -> ${part}`);
      }
      return { imported: part, local: part };
    });

  return { names, namespace: null };
}

/**
 * Reads a module and extracts its imports and exports.
 *
 * @param {string} file absolute path
 * @returns {Promise<ModuleRecord>}
 */
async function parseModule(file) {
  let source;
  try {
    source = await fsp.readFile(file, 'utf8');
  } catch {
    throw new BuildError(`Nem található modul: ${rel(file)}`);
  }

  const where = rel(file);

  // Constructs that simply cannot survive the "classic script" transformation.
  if (/^[ \t]*export\s+default\b/m.test(source)) {
    throw new BuildError(`\`export default\` nem támogatott (${where}) — használj nevesített exportot.`);
  }
  if (/^[ \t]*export\s*\*/m.test(source)) {
    throw new BuildError(`\`export *\` nem támogatott (${where}) — sorold fel a neveket.`);
  }
  if (/\bimport\s*\.\s*meta\b/.test(source)) {
    throw new BuildError(`\`import.meta\` nem használható az egyfájlos buildben (${where}).`);
  }

  /** @type {ImportRecord[]} */
  const imports = [];

  const collect = (statement, spec, clause) => {
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      throw new BuildError(
        `Csak relatív importok támogatottak (${where}): "${spec}".\n` +
          '  A játéknak nincs npm függősége, minden import relatív és `.js` végű.',
      );
    }
    const target = path.resolve(path.dirname(file), spec);
    if (clause === null) {
      imports.push({ statement, spec, target, names: [], namespace: null, sideEffectOnly: true });
      return;
    }
    const parsed = parseImportClause(clause, where);
    imports.push({
      statement,
      spec,
      target,
      names: parsed.names,
      namespace: parsed.namespace,
      sideEffectOnly: false,
    });
  };

  IMPORT_FROM_RE.lastIndex = 0;
  for (let m; (m = IMPORT_FROM_RE.exec(source)); ) collect(m[0], m[3], m[1]);

  IMPORT_BARE_RE.lastIndex = 0;
  for (let m; (m = IMPORT_BARE_RE.exec(source)); ) collect(m[0], m[2], null);

  /** @type {Array<{ local: string, exported: string }>} */
  const exports = [];
  const addExport = (local, exported = local) => {
    if (!exports.some((e) => e.exported === exported)) exports.push({ local, exported });
  };

  for (const m of source.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) addExport(m[1]);
  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) addExport(m[1]);
  for (const m of source.matchAll(/^export\s+class\s+([A-Za-z_$][\w$]*)/gm)) addExport(m[1]);

  EXPORT_LIST_RE.lastIndex = 0;
  for (let m; (m = EXPORT_LIST_RE.exec(source)); ) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim();
      if (!part) continue;
      const aliased = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part);
      if (aliased) addExport(aliased[1], aliased[2]);
      else if (/^[A-Za-z_$][\w$]*$/.test(part)) addExport(part);
      else throw new BuildError(`Értelmezhetetlen export-elem itt: ${where}\n  -> ${part}`);
    }
  }

  return { file, key: where, source, imports, exports };
}

/**
 * Walks the import graph starting at `entry`.
 *
 * @param {string} entry absolute path of the entry module
 * @returns {Promise<Map<string, ModuleRecord>>} keyed by absolute path
 */
async function loadGraph(entry) {
  /** @type {Map<string, ModuleRecord>} */
  const modules = new Map();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift();
    if (modules.has(file)) continue;
    const record = await parseModule(file);
    modules.set(file, record);
    for (const imp of record.imports) {
      if (!modules.has(imp.target)) queue.push(imp.target);
    }
  }

  return modules;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Depth-first topological order (dependencies first). Import cycles are broken
 * deterministically and reported to the caller.
 *
 * @param {Map<string, ModuleRecord>} modules
 * @param {string} entry
 * @returns {{ order: ModuleRecord[], cycles: string[] }}
 */
function topologicalOrder(modules, entry) {
  /** @type {ModuleRecord[]} */
  const order = [];
  const done = new Set();
  const onStack = new Set();
  /** @type {string[]} */
  const cycles = [];

  /** @param {string} file */
  function visit(file) {
    if (done.has(file)) return;
    if (onStack.has(file)) {
      // Back edge: a genuine import cycle. The binding is resolved lazily later.
      cycles.push(rel(file));
      return;
    }
    onStack.add(file);
    const record = modules.get(file);
    for (const imp of record.imports) visit(imp.target);
    onStack.delete(file);
    done.add(file);
    order.push(record);
  }

  visit(entry);
  return { order, cycles: [...new Set(cycles)] };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Fails the build when two modules export the same top-level name, and when an
 * import asks for a name the target module does not export.
 *
 * @param {ModuleRecord[]} order
 */
function validateModules(order) {
  /** @type {Map<string, string[]>} */
  const owners = new Map();
  for (const mod of order) {
    for (const exp of mod.exports) {
      const list = owners.get(exp.exported) ?? [];
      list.push(mod.key);
      owners.set(exp.exported, list);
    }
  }

  const clashes = [...owners.entries()].filter(([, files]) => files.length > 1);
  if (clashes.length > 0) {
    const detail = clashes.map(([name, files]) => `  • ${name}  →  ${files.join(', ')}`).join('\n');
    throw new BuildError(
      'Névütközés: több modul ugyanazt a nevet exportálja.\n' +
        `${detail}\n` +
        'Nevezd át az egyiket, különben az egyfájlos build kiszámíthatatlanul viselkedne.',
    );
  }

  const byFile = new Map(order.map((m) => [m.file, m]));
  for (const mod of order) {
    for (const imp of mod.imports) {
      if (imp.sideEffectOnly) continue;
      const target = byFile.get(imp.target);
      if (!target) continue;
      if (imp.namespace) continue;
      for (const name of imp.names) {
        if (!target.exports.some((e) => e.exported === name.imported)) {
          throw new BuildError(
            `A(z) ${mod.key} a(z) "${name.imported}" nevet importálja innen: ${target.key}, ` +
              'de az a modul nem exportálja.',
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

/**
 * Rewrites one module into a self-contained IIFE.
 *
 * @param {ModuleRecord} mod
 * @param {Map<string, number>} positions absolute path -> index in emit order
 * @param {string[]} lazyReport collects "module: name" entries for the log
 * @returns {string}
 */
function emitModule(mod, positions, lazyReport) {
  let body = mod.source;
  const selfPosition = positions.get(mod.file);

  // 1. Replace every import statement with a registry read.
  for (const imp of mod.imports) {
    const targetKey = rel(imp.target);
    let replacement;

    if (imp.sideEffectOnly) {
      replacement = `/* side-effect import of ${targetKey} (already inlined above) */`;
    } else if (imp.namespace) {
      replacement = `const ${imp.namespace} = ${REGISTRY}[${q(targetKey)}];`;
    } else if (imp.names.length === 0) {
      replacement = `/* empty import from ${targetKey} */`;
    } else {
      const targetPosition = positions.get(imp.target);
      // A dependency emitted *after* this module can only be an import cycle.
      // Its bindings are not populated yet, so bind them lazily.
      const isForwardReference = targetPosition !== undefined && targetPosition > selfPosition;

      if (isForwardReference) {
        replacement = imp.names
          .map((n) => {
            lazyReport.push(`${mod.key} ← ${targetKey}:${n.imported}`);
            return `const ${n.local} = __slagLazy(${q(targetKey)}, ${q(n.imported)});`;
          })
          .join('\n');
      } else {
        const bindings = imp.names
          .map((n) => (n.imported === n.local ? n.local : `${n.imported}: ${n.local}`))
          .join(', ');
        replacement = `const { ${bindings} } = ${REGISTRY}[${q(targetKey)}];`;
      }
    }

    // A function replacement keeps `$&`-style sequences in the generated code
    // from being interpreted as replacement patterns.
    body = body.replace(imp.statement, () => replacement);
  }

  // 2. Drop `export { … };` statements — the registry assignment replaces them.
  body = body.replace(EXPORT_LIST_RE, (match) => `/* ${match.trim()} */`);

  // 3. `export const X` -> `const X`, `export function f` -> `function f`, …
  body = body.replace(EXPORT_KEYWORD_RE, '');

  // 4. Publish the exports.
  const exported = mod.exports
    .map((e) => (e.exported === e.local ? e.local : `${e.exported}: ${e.local}`))
    .join(', ');
  const publish = `${REGISTRY}[${q(mod.key)}] = { ${exported} };`;

  return [
    `/* ═════════ ${mod.key} ═════════ */`,
    '(function () {',
    body.replace(/\s+$/, ''),
    '',
    publish,
    '})();',
    '',
  ].join('\n');
}

/**
 * Builds the full `<script>` payload.
 *
 * @param {ModuleRecord[]} order
 * @returns {{ code: string, lazyReport: string[] }}
 */
function emitBundle(order) {
  const positions = new Map(order.map((mod, index) => [mod.file, index]));
  /** @type {string[]} */
  const lazyReport = [];

  const bodies = order.map((mod) => emitModule(mod, positions, lazyReport));

  const code = `(function () {
'use strict';

/* Egyfájlos Slag build — a modulok saját hatókörben futnak, az exportjaikat
   a(z) ${REGISTRY} regiszterbe teszik. Generálta: tools/build-single.mjs */

function __slagBoot() {
var ${REGISTRY} = Object.create(null);

/* Késleltetett kötés körkörös importokhoz: a hívás pillanatában olvassa ki a
   tényleges függvényt/osztályt a regiszterből. */
function __slagLazy(modulePath, name) {
  return function slagLazyBinding() {
    var target = ${REGISTRY}[modulePath][name];
    if (new.target) return Reflect.construct(target, arguments, new.target);
    return target.apply(this, arguments);
  };
}

${bodies.join('\n')}
}

/* A <script type="module"> alapból késleltetve fut, ezt utánozzuk itt is,
   hogy a DOM (és a <canvas>) biztosan létezzen a start pillanatában. */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', __slagBoot, { once: true });
} else {
  __slagBoot();
}
})();
`;

  return { code, lazyReport };
}

// ---------------------------------------------------------------------------
// HTML assembly
// ---------------------------------------------------------------------------

/**
 * @param {string} html raw index.html
 * @param {string} htmlDir directory of index.html (for relative hrefs)
 * @returns {Promise<{ html: string, inlined: string[] }>}
 */
async function inlineStylesheets(html, htmlDir) {
  /** @type {string[]} */
  const inlined = [];
  const linkTags = [...html.matchAll(/<link\b[^>]*>/gi)];

  for (const match of linkTags) {
    const tag = match[0];
    if (!/\brel\s*=\s*["']?stylesheet["']?/i.test(tag)) continue;

    const hrefMatch = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!hrefMatch) continue;
    const href = hrefMatch[1];
    if (/^[a-z]+:/i.test(href) || href.startsWith('//')) continue; // external URL

    const cssPath = path.resolve(htmlDir, href.split(/[?#]/, 1)[0]);
    let css;
    try {
      css = await fsp.readFile(cssPath, 'utf8');
    } catch {
      throw new BuildError(`Az index.html hivatkozott stíluslapja nem található: ${href}`);
    }

    inlined.push(rel(cssPath));
    const styleTag = `<style>\n/* ${rel(cssPath)} */\n${css.trim()}\n</style>`;
    html = html.replace(tag, () => styleTag);
  }

  return { html, inlined };
}

/**
 * Removes the `<script type="module">` tag and returns the entry module path.
 *
 * @param {string} html
 * @param {string} htmlDir
 * @returns {{ html: string, entry: string|null }}
 */
function extractEntryScript(html, htmlDir) {
  const scriptRe = /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>\s*<\/script>/gi;
  const match = scriptRe.exec(html);
  if (!match) return { html, entry: null };

  const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[0]);
  if (!srcMatch) return { html, entry: null };

  const entry = path.resolve(htmlDir, srcMatch[1].split(/[?#]/, 1)[0]);
  const cleaned = html.replace(match[0], () => '<!-- a modulok az oldal aljára beágyazva -->');
  return { html: cleaned, entry };
}

/**
 * Escapes sequences that would prematurely terminate the `<script>` element.
 * @param {string} code
 * @returns {string}
 */
function escapeForScriptTag(code) {
  return code.replace(/<\/script/gi, '<\\/script');
}

/**
 * Injects the bundle right before `</body>` (or appends it as a last resort).
 * @param {string} html
 * @param {string} code
 * @returns {string}
 */
function injectBundle(html, code) {
  const scriptTag = `<script>\n${escapeForScriptTag(code)}</script>\n`;
  // Function replacements: the bundle is full of `$` sequences that must not be
  // treated as replacement patterns.
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, () => `${scriptTag}</body>`);
  if (/<\/html\s*>/i.test(html)) return html.replace(/<\/html\s*>/i, () => `${scriptTag}</html>`);
  return `${html}\n${scriptTag}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{ html: string, out: string }}
 */
function parseArgs(argv) {
  const opts = { html: DEFAULT_HTML, out: DEFAULT_OUT };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);

    switch (name) {
      case 'html':
        opts.html = path.resolve(process.cwd(), value ?? '');
        break;
      case 'out':
        opts.out = path.resolve(process.cwd(), value ?? '');
        break;
      case 'help':
        process.stdout.write(
          [
            'Slag egyfájlos build',
            '',
            'Használat: node tools/build-single.mjs [kapcsolók]',
            '',
            '  --html <fájl>  A forrás HTML (alapértelmezés: index.html)',
            '  --out <fájl>   A kimeneti fájl (alapértelmezés: dist/slag.html)',
            '',
          ].join('\n'),
        );
        process.exit(0);
        break;
      default:
        throw new BuildError(`Ismeretlen kapcsoló: ${arg}`);
    }
  }

  return opts;
}

/** @param {number} bytes @returns {string} */
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(opts.html)) {
    throw new BuildError(`Nem található a HTML forrás: ${rel(opts.html)}`);
  }

  const htmlDir = path.dirname(opts.html);

  // Keep the registry keys short and readable even when building a project that
  // does not live inside this repository.
  const insideRepo = !path.relative(REPO_ROOT, opts.html).startsWith('..');
  keyBase = insideRepo ? REPO_ROOT : htmlDir;

  let html = await fsp.readFile(opts.html, 'utf8');

  // 1. Inline the stylesheets.
  const styles = await inlineStylesheets(html, htmlDir);
  html = styles.html;

  // 2. Find (and remove) the module entry point.
  const extracted = extractEntryScript(html, htmlDir);
  html = extracted.html;
  const entry = extracted.entry ?? FALLBACK_ENTRY;
  if (!fs.existsSync(entry)) {
    throw new BuildError(
      `Nem található a belépési modul: ${rel(entry)}\n` +
        '  Az index.html-ben legyen egy <script type="module" src="./src/main.js"></script> sor.',
    );
  }

  // 3. Walk, order and validate the module graph.
  const modules = await loadGraph(entry);
  const { order, cycles } = topologicalOrder(modules, entry);
  validateModules(order);

  // 4. Generate and inject.
  const { code, lazyReport } = emitBundle(order);
  html = injectBundle(html, code);

  const banner = `<!--
  SLAG — egyfájlos build. NE szerkeszd kézzel!
  Generálta: tools/build-single.mjs — ${new Date().toISOString()}
  Modulok: ${order.length} db, forrás: ${rel(opts.html)}
-->
`;
  html = html.replace(/^(\s*<!doctype html>\s*)/i, (m) => `${m}${banner}`);
  if (!html.includes(banner)) html = banner + html;

  await fsp.mkdir(path.dirname(opts.out), { recursive: true });
  await fsp.writeFile(opts.out, html, 'utf8');

  const stats = await fsp.stat(opts.out);

  // 5. Report.
  const lines = [
    '',
    '  SLAG — egyfájlos build kész',
    '',
    `  Kimenet:  ${opts.out}`,
    `  Méret:    ${humanSize(stats.size)} (${stats.size} bájt)`,
    `  Modulok:  ${order.length} db — ${order.map((m) => path.basename(m.key)).join(' → ')}`,
  ];
  if (styles.inlined.length > 0) lines.push(`  CSS:      ${styles.inlined.join(', ')}`);
  if (cycles.length > 0) {
    lines.push('', `  Figyelem: körkörös import (${cycles.join(', ')}) — késleltetett kötéssel feloldva:`);
    for (const entryLine of [...new Set(lazyReport)]) lines.push(`            ${entryLine}`);
    lines.push('            (ez csak függvény/osztály exportokra működik)');
  }
  lines.push('', '  Nyisd meg dupla kattintással — nem kell hozzá szerver.', '', '');

  process.stdout.write(lines.join('\n'));
}

main().catch((err) => {
  if (err instanceof BuildError) {
    process.stderr.write(`\n  Build hiba:\n  ${err.message.split('\n').join('\n  ')}\n\n`);
  } else {
    process.stderr.write(`\n  Váratlan build hiba:\n${err && err.stack ? err.stack : String(err)}\n\n`);
  }
  process.exit(1);
});
