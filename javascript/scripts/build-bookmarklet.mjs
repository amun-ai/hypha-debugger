#!/usr/bin/env node
/**
 * build-bookmarklet.mjs
 *
 * Generates a FULLY SELF-CONTAINED `javascript:` bookmarklet that inlines the
 * entire minified bundle. Nothing is fetched at click time — no CDN, no
 * `<script src>`, no `eval`, no blob URL. This is what makes it work on pages
 * with a strict Content Security Policy such as:
 *
 *     script-src 'self' 'nonce-...'
 *
 * Code that runs *as the bookmarklet body itself* is a user-initiated action
 * and is exempt from CSP `script-src`. By contrast, fetching a script, eval-ing
 * a string, or injecting a `<script src>`/blob URL are all governed by CSP
 * (`script-src`/`connect-src`/`'unsafe-eval'`) and get blocked. So the only
 * CSP-proof option is to embed the literal code.
 *
 * URL-parser hazards we must neutralise so the decoded code is byte-identical
 * to the bundle: when the browser loads a `javascript:` URL it (a) strips ASCII
 * tab/newline/CR and (b) percent-decodes `%XX`. So we percent-escape `%`, `#`
 * (fragment delimiter), and `\n`/`\r`/`\t`. Everything else passes through.
 *
 * Outputs:
 *   - dist/bookmarklet.txt      raw bookmarklet (paste into a bookmark URL)
 *   - dist/bookmarklet.min.txt  alias kept for tooling
 *   - patches examples/bookmarklet.html and docs/index.html in place
 *
 * Usage: node scripts/build-bookmarklet.mjs [--bundle dist/hypha-debugger.slim.min.js]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, ".."); // javascript/
const repoRoot = resolve(root, "..");

// --- pick the bundle (prefer the slim, tree-shaken build if present) ---
const argv = process.argv.slice(2);
const bundleArgIdx = argv.indexOf("--bundle");
let bundlePath;
if (bundleArgIdx !== -1) {
  bundlePath = resolve(process.cwd(), argv[bundleArgIdx + 1]);
} else if (existsSync(resolve(root, "dist/hypha-debugger.slim.min.js"))) {
  bundlePath = resolve(root, "dist/hypha-debugger.slim.min.js");
} else {
  bundlePath = resolve(root, "dist/hypha-debugger.min.js");
}

const SERVER_URL = "https://hypha.aicell.io";

// --- read + clean the bundle ---
let bundle = readFileSync(bundlePath, "utf8");
// Strip the trailing `//# sourceMappingURL=...` comment. It is a single-line
// comment; if left in, the `}` we append to close the try-block would land on
// the same (commented-out) line and be swallowed.
bundle = bundle.replace(/\n?\/\/[#@]\s*sourceMappingURL=.*\s*$/, "");
bundle = bundle.trimEnd();

// --- wrap: guard + try/catch. The bundle's own autoStart() starts the
//     debugger with the default server (no <script> tag is found). ---
const body =
  `void function(){` +
  `if(window.__HYPHA_DEBUGGER__&&window.__HYPHA_DEBUGGER__.instance){` +
  `alert("Hypha Debugger is already running on this page.");return}` +
  `try{${bundle}}` +
  `catch(e){alert("Hypha Debugger failed to start: "+(e&&e.message?e.message:e))}` +
  `}();`;

// --- escape for the `javascript:` URL parser (order: % first) ---
function urlEscape(s) {
  return s
    .replace(/%/g, "%25")
    .replace(/#/g, "%23")
    .replace(/\n/g, "%0A")
    .replace(/\r/g, "%0D")
    .replace(/\t/g, "%09");
}

const rawBookmarklet = "javascript:" + urlEscape(body);

// --- HTML-escape for embedding in an href="" attribute / copy <span> ---
function htmlEscape(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
const htmlBookmarklet = htmlEscape(rawBookmarklet);

// --- sanity: percent-decoding must reproduce the original cleaned bundle ---
function urlDecodeSim(s) {
  // simulate the browser URL parser: strip tab/newline/CR, then percent-decode
  const stripped = s.replace(/[\t\n\r]/g, "");
  return stripped.replace(/%([0-9A-Fa-f]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16)),
  );
}
const decoded = urlDecodeSim(rawBookmarklet.slice("javascript:".length));
const expected = body;
if (decoded !== expected) {
  console.error("[build-bookmarklet] ROUND-TRIP MISMATCH — decoded != source");
  // find first diff
  for (let i = 0; i < Math.max(decoded.length, expected.length); i++) {
    if (decoded[i] !== expected[i]) {
      console.error(
        `  first diff at ${i}: decoded=${JSON.stringify(decoded.slice(i, i + 40))} expected=${JSON.stringify(expected.slice(i, i + 40))}`,
      );
      break;
    }
  }
  process.exit(1);
}
// parse-check: the decoded code must be syntactically valid
try {
  // eslint-disable-next-line no-new-func
  new Function(decoded);
} catch (e) {
  console.error("[build-bookmarklet] PARSE ERROR in inlined code:", e.message);
  process.exit(1);
}

// --- write raw output (paste into a bookmark URL) ---
writeFileSync(resolve(root, "dist/bookmarklet.txt"), rawBookmarklet);

// --- patch the HTML pages in place (idempotent regex replace) ---
function patchHtml(absPath) {
  if (!existsSync(absPath)) return;
  let html = readFileSync(absPath, "utf8");
  let changed = false;

  // IMPORTANT: use replacement *functions*, never a replacement string. The
  // bundle contains `$` characters; in a String.replace replacement string,
  // `$&` / `$\`` / `$'` / `$1` are special and would splice huge chunks of the
  // file in (a 200 KB bookmarklet exploded to multi-MB). A function replacement
  // treats the value as a literal.

  // 1) any draggable bookmarklet link href. Match ANY `href="javascript:void…"`
  //    (covers both the new inlined wrapper and any older variant, and both
  //    `bookmarklet-link` / `bm-link` class names). The href value is
  //    HTML-escaped so it contains no raw `"` — `[^"]*` matches the whole thing.
  const hrefRe = /(href=")javascript:void[^"]*(")/g;
  if (hrefRe.test(html)) {
    html = html.replace(hrefRe, (_m, p1, p2) => p1 + htmlBookmarklet + p2);
    changed = true;
  }

  // 2) the manual-copy spans (#bm-code / #bm-raw). Content is HTML-escaped so
  //    it contains no raw `</span>` — non-greedy match is safe.
  for (const id of ["bm-code", "bm-raw"]) {
    const spanRe = new RegExp(`(<span id="${id}">)[\\s\\S]*?(</span>)`);
    if (spanRe.test(html)) {
      html = html.replace(spanRe, (_m, p1, p2) => p1 + htmlBookmarklet + p2);
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(absPath, html);
    console.log(`  patched ${relative(repoRoot, absPath)}`);
  } else {
    console.log(`  (no bookmarklet markers found in ${relative(repoRoot, absPath)})`);
  }
}

patchHtml(resolve(repoRoot, "examples/bookmarklet.html"));
patchHtml(resolve(repoRoot, "docs/index.html"));

// --- report ---
const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log("[build-bookmarklet] OK");
console.log(`  bundle:      ${relative(repoRoot, bundlePath)} (${kb(bundle.length)})`);
console.log(`  bookmarklet: ${kb(rawBookmarklet.length)} raw  (${rawBookmarklet.length.toLocaleString()} chars)`);
console.log(`  round-trip:  byte-identical ✓   parse: ✓`);
console.log(`  Chrome bookmark/URL limit is ~2 MB — this fits with huge margin.`);
