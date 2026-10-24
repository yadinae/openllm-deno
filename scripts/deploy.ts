#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run --allow-net
/**
 * Reproducible Deno Deploy for openllm.
 *
 * WHY THIS EXISTS
 * The `deno deploy` CLI collects files with `use_gitignore=true`. This repo's
 * .gitignore excludes `dist/` and `db/data.json`, but Deno Deploy still needs
 * them (SPA assets + optional first-boot seed). A bare `deno deploy .` therefore
 * uploads the source without those files and the app boots with an empty SPA
 * (see notes/2026-10-18-deploy-warmup-boot-failed-gitignore-and-schema-drift.md).
 *
 * This script copies a whitelist of runtime files into a clean staging dir that
 * has no .gitignore, then deploys from there. As a side effect, secrets such as
 * .env never leave the machine and stray files (dist.bak-*, *.bak, notes/) are
 * never uploaded.
 *
 * USAGE
 *   deno task deploy                       # prod, org/app from deno.json
 *   deno task deploy --no-seed             # skip db/data.json (DB is truth)
 *   deno task deploy --dry-run             # show staging without deploying
 *   DENO_DEPLOY_TOKEN=ddp_... deno task deploy
 *
 * FLAGS
 *   --org <org>      default: deno.json deploy.org
 *   --app <app>      default: deno.json deploy.app
 *   --token <token>  default: $DENO_DEPLOY_TOKEN
 *   --preview        deploy a preview instead of prod
 *   --no-seed        do not stage db/data.json
 *   --dry-run, --dry list staged files, do not deploy
 */

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/\/$/, "");

/** Runtime files copied into the staging dir (relative to repo root). */
const INCLUDE = [
  "main.ts",
  "deno.json",
  "deno.lock",
  "db",
  "routes",
  "services",
  "providers",
  "shared",
  "dist",
];

/** Never staged, even under an INCLUDE dir. */
const SKIP_NAMES = new Set([".env", ".git", ".gitignore", "node_modules", ".DS_Store"]);

function argValue(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = Deno.args[i + 1];
  return next && !next.startsWith("--") ? next : "";
}
function flag(name: string): boolean {
  return Deno.args.includes(`--${name}`);
}

const cfg = JSON.parse(await Deno.readTextFile(`${ROOT}/deno.json`)) as {
  deploy?: { org?: string; app?: string };
};
const org = argValue("org") || cfg.deploy?.org;
const app = argValue("app") || cfg.deploy?.app;
const token = argValue("token") || Deno.env.get("DENO_DEPLOY_TOKEN");
const prod = !flag("preview");
const dryRun = flag("dry-run") || flag("dry");
const seed = !flag("no-seed");

// Defensive: strip any stray --token from Deno.args that the caller may have
// already forwarded (e.g. `deno run scripts/deploy.ts --token X --no-seed`).
// We re-add it ourselves below so the child deno process gets exactly one.
const childArgs = Deno.args.filter((a) => a !== "--token" && !a.startsWith("--token="));

if (!org || !app) {
  console.error("Missing --org/--app (set them in deno.json deploy.* or pass flags).");
  Deno.exit(1);
}

const staged: string[] = [];
async function copy(src: string, dest: string, rel: string): Promise<void> {
  const st = await Deno.stat(src);
  if (st.isDirectory) {
    await Deno.mkdir(dest, { recursive: true });
    for await (const e of Deno.readDir(src)) {
      if (SKIP_NAMES.has(e.name)) continue;
      if (e.name.endsWith(".bak") || e.name.endsWith(".log")) continue;
      if (e.name === "data.json" && !seed) continue;
      await copy(`${src}/${e.name}`, `${dest}/${e.name}`, `${rel}/${e.name}`);
    }
    return;
  }
  await Deno.copyFile(src, dest);
  staged.push(rel);
}

const tmp = await Deno.makeTempDir({ prefix: "openllm-deploy-" });
try {
  for (const entry of INCLUDE) {
    const src = `${ROOT}/${entry}`;
    try {
      await Deno.stat(src);
    } catch {
      if (entry === "dist") {
        console.warn(`[deploy] WARNING: ${entry}/ is missing — the SPA will 404. Build the frontend first.`);
      } else {
        console.warn(`[deploy] WARNING: ${entry} is missing — skipping.`);
      }
      continue;
    }
    await copy(src, `${tmp}/${entry}`, entry);
  }

  const hasSeed = staged.includes("db/data.json");
  const hasDist = staged.some((f) => f.startsWith("dist/"));
  console.log(`[deploy] staged ${staged.length} files in ${tmp}`);
  console.log(`[deploy]   db/data.json seed: ${hasSeed ? "included" : "excluded"} | dist/: ${hasDist ? "included" : "MISSING"}`);

  if (!hasDist) {
    console.error("[deploy] ERROR: dist/ is missing — the SPA will 404. Run `deno task build` first (or `npm run build` in the frontend).");
    Deno.exit(1);
  }

  if (dryRun) {
    for (const f of staged.sort()) console.log("  ", f);
    console.log("[deploy] --dry-run: not deploying.");
  } else {
    // IMPORTANT: never pass --org/--app here — `deno deploy` reads them from
    // `deno.json` deploy.org/app already, and the CLI treats a second copy
    // of the same flag as a "found several times" error and exits 2.
    // --prod and --token are the only things we add explicitly.
    const args = ["deploy", "--prod", "--non-interactive"];
    if (token) args.push("--token", token);
    console.log(`[deploy] ${Deno.execPath()} ${args.map((a) => (a === token ? "***" : a)).join(" ")}`);
    const child = new Deno.Command(Deno.execPath(), {
      args,
      cwd: tmp,
      env: token ? { DENO_DEPLOY_TOKEN: token } : {},
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const { code } = await child.status;
    if (code !== 0) {
      console.error(`[deploy] deploy failed with exit code ${code}`);
      Deno.exit(code);
    }
  }
} finally {
  if (!dryRun) await Deno.remove(tmp, { recursive: true }).catch(() => {});
}