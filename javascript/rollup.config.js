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
    ],
  },
];
