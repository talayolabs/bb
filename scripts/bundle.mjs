// Single-file build for container images and release tarballs: build/bb.mjs, runnable with `node build/bb.mjs`.
import { build } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/bb.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "build/bb.mjs",
  define: { "process.env.BB_BUNDLED_VERSION": JSON.stringify(pkg.version) },
  legalComments: "none",
});
chmodSync("build/bb.mjs", 0o755);
console.log(`build/bb.mjs (bb ${pkg.version})`);
