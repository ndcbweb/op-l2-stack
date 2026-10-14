import { cpSync, mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/main.js"],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  outfile: "dist/app.js",
});
cpSync("public", "dist", { recursive: true });
console.log("web built into dist/");
