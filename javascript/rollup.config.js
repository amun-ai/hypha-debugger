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
  // ESM build (hypha-rpc is external)
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
  // UMD build (bundles everything, hypha-rpc expected as global)
  {
    input: "src/index.ts",
    output: {
      file: "dist/hypha-debugger.js",
      format: "umd",
      name: "hyphaDebugger",
      sourcemap: true,
      globals: {
        "hypha-rpc": "hyphaWebsocketClient",
      },
      inlineDynamicImports: true,
    },
    external: ["hypha-rpc"],
    plugins: [resolve({ browser: true }), commonjs(), tsPlugin()],
  },
  // Minified UMD build
  {
    input: "src/index.ts",
    output: {
      file: "dist/hypha-debugger.min.js",
      format: "umd",
      name: "hyphaDebugger",
      sourcemap: true,
      globals: {
        "hypha-rpc": "hyphaWebsocketClient",
      },
      inlineDynamicImports: true,
    },
    external: ["hypha-rpc"],
    plugins: [resolve({ browser: true }), commonjs(), tsPlugin(), terser()],
  },
];
