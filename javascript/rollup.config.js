import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";

const tsPlugin = (extraOpts = {}) =>
  typescript({
    tsconfig: "./tsconfig.json",
    declaration: false,
    declarationDir: undefined,
    ...extraOpts,
  });

// Rewrite bundled hypha-rpc's webpack chunk init from `this.webpackChunk...`
// to `globalThis.webpackChunk...` (both bracket and dot-notation variants —
// terser may minify bracket access to dots). In a classic <script>, `this`
// is the global object, but when the bundle is eval'd (e.g. from a
// bookmarklet that bypasses CSP via fetch+eval), the enclosing factory is
// strict mode, making nested IIFE `this` be `undefined` and the webpack
// init throw TypeError: Cannot read properties of undefined.
const patchWebpackThis = () => ({
  name: "patch-webpack-this",
  renderChunk(code) {
    return (
      code
        // Bracket notation: this["webpackChunk..."]
        .replace(
          /\bthis\[(["']webpackChunk[^"']+["'])\]/g,
          'globalThis[$1]',
        )
        // Dot notation: this.webpackChunk...
        .replace(
          /\bthis\.webpackChunk([A-Za-z_$][A-Za-z0-9_$]*)/g,
          'globalThis.webpackChunk$1',
        )
    );
  },
});

// hypha-rpc is webpack-built and its runtime eagerly derives `publicPath` from
// `document.currentScript.src` / the last <script> tag. When the bundle is run
// INLINE (eval'd, or embedded literally in a `javascript:` bookmarklet) there is
// no such script element, so webpack throws:
//   "Automatic publicPath is not supported in this browser"
// We inline every chunk (inlineDynamicImports), so publicPath is never actually
// used — rewrite the throw to fall back to an empty (relative) path. Loading via
// a normal <script src> is unaffected (currentScript still wins before this).
const patchWebpackPublicPath = () => ({
  name: "patch-webpack-public-path",
  renderChunk(code) {
    // Whitespace-tolerant so it patches BOTH the minified outputs (`if(!e)throw…`)
    // and the unminified `dist/hypha-debugger.js` (`if (!scriptUrl) throw …`).
    return code.replace(
      /if\s*\(\s*!([A-Za-z_$][\w$]*)\s*\)\s*throw new Error\(\s*"Automatic publicPath is not supported in this browser"\s*\)/g,
      'if(!$1)$1=""',
    );
  },
});

// hypha-rpc resolves typed-array constructors at module init with
// `typedArrayToDtypeKeys.push(eval(arrType))` (arrType is a name like
// "Int8Array"). `eval` is blocked on strict-CSP pages (no 'unsafe-eval'),
// throwing immediately on load. Resolve the constructor from globalThis instead
// — identical result, CSP-safe. Matches the `.push(eval(IDENT))` form only, so
// it never touches `eval(script.content)` (a member expr, on-demand feature).
const patchHyphaRpcEval = () => ({
  name: "patch-hypha-rpc-eval",
  renderChunk(code) {
    return code.replace(
      /\.push\(eval\(([A-Za-z_$][\w$]*)\)\)/g,
      ".push(globalThis[$1])",
    );
  },
});

export default [
  // ESM build (hypha-rpc is external — users import it separately)
  {
    input: "src/index.ts",
    output: {
      file: "dist/hypha-debugger.mjs",
      format: "esm",
      sourcemap: true,
    },
    external: ["hypha-rpc"],
    plugins: [resolve(), commonjs(), tsPlugin()],
  },
  // UMD build — everything bundled (single script tag, no dependencies)
  {
    input: "src/index.ts",
    output: {
      file: "dist/hypha-debugger.js",
      format: "umd",
      name: "hyphaDebugger",
      sourcemap: true,
      inlineDynamicImports: true,
    },
    plugins: [
      resolve({ browser: true }),
      commonjs(),
      tsPlugin(),
      patchWebpackThis(),
      patchWebpackPublicPath(),
      patchHyphaRpcEval(),
    ],
  },
  // Minified UMD build — everything bundled
  {
    input: "src/index.ts",
    output: {
      file: "dist/hypha-debugger.min.js",
      format: "umd",
      name: "hyphaDebugger",
      sourcemap: true,
      inlineDynamicImports: true,
    },
    plugins: [
      resolve({ browser: true }),
      commonjs(),
      tsPlugin(),
      terser(),
      patchWebpackThis(),
      patchWebpackPublicPath(),
      patchHyphaRpcEval(),
    ],
  },
  // Slim minified UMD build — same features, squeezed as hard as is safe.
  // Used to generate the self-contained bookmarklet (scripts/build-bookmarklet.mjs).
  // NOTE: property mangling is deliberately OFF — hypha-rpc serializes by
  // property name (RPC schemas, msgpack keys), so renaming props breaks calls.
  // The floor is hypha-rpc itself (~124 KB min); everything else is already small.
  {
    input: "src/index.ts",
    output: {
      file: "dist/hypha-debugger.slim.min.js",
      format: "umd",
      name: "hyphaDebugger",
      sourcemap: false,
      inlineDynamicImports: true,
    },
    treeshake: {
      moduleSideEffects: false,
      propertyReadSideEffects: false,
      tryCatchDeoptimization: false,
    },
    plugins: [
      resolve({ browser: true }),
      commonjs(),
      tsPlugin(),
      terser({
        ecma: 2020,
        module: false,
        compress: {
          passes: 3,
          ecma: 2020,
          toplevel: true,
          pure_getters: true,
          booleans_as_integers: true,
          drop_debugger: true,
          // keep console.* — the debugger logs useful status to it
        },
        mangle: {
          toplevel: true,
          // properties: false  (default) — must stay off for hypha-rpc
        },
        format: { comments: false, ecma: 2020 },
      }),
      patchWebpackThis(),
      patchWebpackPublicPath(),
      patchHyphaRpcEval(),
    ],
  },
];
