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
    plugins: [resolve({ browser: true }), commonjs(), tsPlugin()],
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
    plugins: [resolve({ browser: true }), commonjs(), tsPlugin(), terser()],
  },
];
