/* ===========================================================================
   build-static.mjs -- assemble dist/ for the Cloudflare worker.

   dist/client/  is the ASSETS bucket; worker/index.js rewrites "/" to
   "/game/NUKEM.html", so everything the game asks for has to resolve relative
   to /game/.

   THE BUG THIS FIXES
   ------------------
   The old build copied public/ and nothing else.  public/game/ holds only
   NUKEM.html and demo.js, but NUKEM.html carries seven module tags --
   nz-core, nz-shots, nz-render, nz-env, nz-enemies, nz-weapons, nz-audio --
   which live at the repo root and were never copied.  Every one of them 404'd
   in the deployed build.  They are classic scripts, so a 404 is silent: no
   exception, no console error the player would see, the NZ hook bus simply
   never gets a listener and the game falls back to its stock path.  The entire
   CS2 overhaul was missing from the shipped artifact while passing every test
   we had, because npm test only parses the INLINE scripts.

   So this script now (a) copies the modules and vendor/ into dist/client/game/,
   (b) takes NUKEM.html from the repo root rather than from the stale duplicate
   under public/, and (c) VERIFIES: it re-parses every <script src> in the
   built page and fails the build if any local one does not resolve to a file
   that exists.  A silent 404 cannot happen twice.
   ======================================================================== */
import { mkdir, rm, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = (...p) => path.join(HERE, ...p);

/* copy by read+write rather than fs.cp: cp() unlinks an existing destination
   before writing it, and some sandboxes mount the tree with unlink denied
   while allowing truncating writes.  Overwriting in place works everywhere. */
async function copyFile(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, await readFile(from));
}
async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const ent of await readdir(from, { withFileTypes: true })) {
    const src = path.join(from, ent.name), dst = path.join(to, ent.name);
    if (ent.isDirectory()) await copyTree(src, dst);
    else if (ent.isFile()) await copyFile(src, dst);
  }
}

const dist = R("dist");
const client = R("dist", "client");
const server = R("dist", "server");
const gameDir = path.join(client, "game");

/* The runtime modules NUKEM.html pulls in, in load order.  Kept explicit
   rather than globbed: a new nz-*.js that nobody wired into the page should
   not silently start shipping, and a module that goes missing should break the
   build loudly instead of being quietly dropped from the manifest. */
const MODULES = [
  "nz-core.js",
  "nz-render.js",
  "nz-env.js",
  "nz-arena.js",
  "nz-finale.js",
  "nz-street-sky.js",
  "nz-street-ground.js",
  "nz-buildings-asset.js",
  "nz-buildings.js",
  "nz-street.js",
  "nz-street-entrance.js",
  "nz-courier-asset.js",
  "nz-street-props.js",
  "nz-street-park.js",
  "nz-street-side.js",
  "nz-enemies.js",
  "nz-spider.js",
  "nz-apc.js",
  "nz-weapons.js",
  "nz-hero.js",
  "nz-audio.js",
  "nz-destruct.js",
  "demo.js",
  "nz-net.js",
];

/* PERSONAL files dress the local player.  nz-hero-look.js is the third-person
   figure's look, with a photograph of a real person in it.  It ships when it
   is in the folder -- the owner chose to put him on the live site
   (2026-11-14) -- and is skipped cleanly when it is not: a clone without it
   builds the stock figure instead of failing.  To leave it out on purpose:

       node build-static.mjs --without-look       or       NZ_SHIP_LOOK=0        */
const PERSONAL = ["nz-hero-look.js"];
const SHIP_LOOK = !(process.argv.includes("--without-look") || process.env.NZ_SHIP_LOOK === "0");

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

/* Best-effort clean.  Some sandboxes mount the project read-mostly and refuse
   unlink(); everything below overwrites in place, so a failed clean is a
   warning and not a build failure. */
try { await rm(dist, { recursive: true, force: true }); }
catch (e) { console.warn(`build: could not clean dist/ (${e.code || e.message}) -- overwriting in place`); }
await mkdir(client, { recursive: true });
await mkdir(server, { recursive: true });

/* 1. public/ first: og.png and anything else static */
await copyTree(R("public"), client);
await mkdir(gameDir, { recursive: true });

/* 2. the canonical page.  public/game/NUKEM.html is a COPY of the root file
   and drifts; the root one is what every agent edits and what the harnesses
   render, so that is the one that ships.  Say so when they differ rather than
   overwriting in silence. */
const rootHtml = await readFile(R("NUKEM.html"), "utf8");
if (await exists(R("public", "game", "NUKEM.html"))) {
  const pubHtml = await readFile(R("public", "game", "NUKEM.html"), "utf8");
  if (pubHtml !== rootHtml) {
    console.warn(
      `build: public/game/NUKEM.html differs from ./NUKEM.html ` +
      `(${pubHtml.length} vs ${rootHtml.length} bytes) -- shipping the root copy`);
  }
}
let outHtml = rootHtml;
const held = [], shipped = [];
for (const f of PERSONAL) {
  if (SHIP_LOOK && (await exists(R(f)))) { shipped.push(f); continue; }
  const tag = new RegExp(`[ \\t]*<script\\s+src=["']${f.replace(/[.]/g, "\\.")}["']\\s*>\\s*</script>[ \\t]*\\r?\\n?`, "g");
  if (tag.test(outHtml)) { outHtml = outHtml.replace(tag, ""); held.push(f); }
}
await writeFile(path.join(gameDir, "NUKEM.html"), outHtml);

/* 3. the modules, next to the page that asks for them */
const copied = [];
for (const m of [...shipped, ...MODULES]) {
  if (!(await exists(R(m)))) { console.warn(`build: missing module ${m} -- not copied`); continue; }
  await copyFile(R(m), path.join(gameDir, m));
  copied.push(m);
}

/* 4. vendor/ -- three.js is loaded from unpkg with a cdnjs fallback, but a
   vendored copy next to the game is what makes an offline / blocked-CDN load
   recoverable, and it is what the headless harnesses already use. */
if (await exists(R("vendor"))) {
  await copyTree(R("vendor"), path.join(gameDir, "vendor"));
}

/* Locally shipped sky photography; gameplay never depends on the asset host. */
await copyFile(R("assets", "sky", "overcast-soil-4k.jpg"),
  path.join(gameDir, "assets", "sky", "overcast-soil-4k.jpg"));
await copyFile(R("assets", "sky", "README.md"),
  path.join(gameDir, "assets", "sky", "README.md"));

/* 5. the worker */
await copyFile(R("worker", "index.js"), path.join(server, "index.js"));

/* ------------------------------------------------------------------ verify */
/* Re-read what was actually written and resolve every script tag against it.
   This is the check that was missing: `npm test` only Function()-parses the
   inline scripts, so a page whose every external module 404s passes it. */
const built = await readFile(path.join(gameDir, "NUKEM.html"), "utf8");
const srcs = [...built.matchAll(/<script[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
const missing = [];
let local = 0;
for (const src of srcs) {
  if (/^(https?:)?\/\//i.test(src) || src.startsWith("data:")) continue;
  local++;
  const p = path.join(gameDir, src.replace(/^\.?\//, ""));
  if (!(await exists(p))) missing.push(src);
}
if (missing.length) {
  console.error(
    `build FAILED: ${missing.length} script tag(s) in dist/client/game/NUKEM.html ` +
    `do not resolve:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

console.log(
  `build ok: ${copied.length} module(s) + NUKEM.html -> dist/client/game/, ` +
  `${local}/${srcs.length} script tags local and all resolved`);
if (shipped.length) console.log(`build: ${shipped.join(", ")} is in this build (personal: public wherever it is deployed)`);
if (held.length) console.log(`build: left out ${held.join(", ")} (${SHIP_LOOK ? "not in the folder" : "--without-look"})`);
