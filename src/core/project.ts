// What `pikaclow dev` needs to know about a JavaScript project: where it is, which
// package manager it uses, which script starts it, and which port that will take.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface Project {
  root: string;
  name: string;
  pm: PackageManager;
  /** Why this package manager: "packageManager field", "pnpm-lock.yaml"… */
  pmReason: string;
  scripts: Record<string, string>;
  deps: Set<string>;
  hasNodeModules: boolean;
}

interface PackageJson {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const LOCKFILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/** Order in which scripts are tried when none is named. */
export const DEV_SCRIPTS = ["dev", "start:dev", "develop", "serve", "start"];

function readPackage(dir: string): PackageJson | null {
  try {
    const data = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as unknown;
    return data && typeof data === "object" ? (data as PackageJson) : null;
  } catch {
    return null;
  }
}

/** Package manager from the packageManager field, else the nearest lockfile (workspace roots included). */
export function detectPackageManager(root: string, pkg: PackageJson): { pm: PackageManager; reason: string } {
  const field = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager ?? "");
  if (field) return { pm: field[1] as PackageManager, reason: "packageManager" };
  for (let dir = root, i = 0; i < 6; i++) {
    for (const [file, pm] of LOCKFILES) if (existsSync(join(dir, file))) return { pm, reason: file };
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { pm: "npm", reason: "default" };
}

/** The nearest folder with a package.json, walking up from `start`. */
export function findProject(start: string): Project | null {
  for (let dir = start; ; ) {
    const pkg = readPackage(dir);
    if (pkg) {
      const { pm, reason } = detectPackageManager(dir, pkg);
      return {
        root: dir,
        name: pkg.name || basename(dir),
        pm,
        pmReason: reason,
        scripts: pkg.scripts ?? {},
        deps: new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]),
        hasNodeModules: existsSync(join(dir, "node_modules")),
      };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function pickScript(scripts: Record<string, string>, wanted?: string): string | null {
  if (wanted) return wanted in scripts ? wanted : null;
  return DEV_SCRIPTS.find((s) => s in scripts) ?? null;
}

export interface Framework {
  name: string;
  port: number;
  /** CLI flags that move the server to another port; null when only $PORT works. */
  portFlag: string | null;
  /** The port is hard-coded in the script, so it cannot be changed from outside. */
  fixedPort: boolean;
}

const FRAMEWORKS: { re: RegExp; dep?: string; name: string; port: number; flag: string | null }[] = [
  { re: /\bnext\s+(dev|start)\b/, dep: "next", name: "Next.js", port: 3000, flag: "-p" },
  { re: /\bnuxi?\s+(dev|start)\b/, dep: "nuxt", name: "Nuxt", port: 3000, flag: "--port" },
  { re: /\bastro\s+(dev|preview)\b/, dep: "astro", name: "Astro", port: 4321, flag: "--port" },
  { re: /\bng\s+serve\b/, dep: "@angular/cli", name: "Angular", port: 4200, flag: "--port" },
  { re: /\bremix\s+vite:dev\b/, name: "Remix", port: 5173, flag: "--port" },
  { re: /\bremix\s+dev\b/, dep: "@remix-run/dev", name: "Remix", port: 3000, flag: null },
  { re: /\b(vite|svelte-kit dev)\b/, dep: "vite", name: "Vite", port: 5173, flag: "--port" },
  { re: /\breact-scripts\s+start\b/, dep: "react-scripts", name: "Create React App", port: 3000, flag: null },
  { re: /\bgatsby\s+develop\b/, dep: "gatsby", name: "Gatsby", port: 8000, flag: "-p" },
  { re: /\bvue-cli-service\s+serve\b/, dep: "@vue/cli-service", name: "Vue CLI", port: 8080, flag: "--port" },
  { re: /\bwebpack(-dev-server|\s+serve)\b/, dep: "webpack-dev-server", name: "webpack", port: 8080, flag: "--port" },
  { re: /\bdocusaurus\s+start\b/, dep: "@docusaurus/core", name: "Docusaurus", port: 3000, flag: "--port" },
  { re: /\bstorybook\s+dev\b|\bstart-storybook\b/, dep: "storybook", name: "Storybook", port: 6006, flag: "-p" },
  { re: /\bexpo\s+start\b/, dep: "expo", name: "Expo", port: 8081, flag: "--port" },
  { re: /\bwrangler\s+(dev|pages dev)\b/, dep: "wrangler", name: "Wrangler", port: 8787, flag: "--port" },
  { re: /\bparcel\b/, dep: "parcel", name: "Parcel", port: 1234, flag: "--port" },
];

const PORT_IN_SCRIPT = /(?:--port[=\s]+|-p\s+|\bPORT=)(\d{2,5})\b/;

/** Recognizes the dev server a script starts and the port it will listen on. */
export function detectFramework(script: string, deps: Set<string> = new Set()): Framework | null {
  const explicit = PORT_IN_SCRIPT.exec(script);
  const hit = FRAMEWORKS.find((f) => f.re.test(script));
  if (hit) {
    return { name: hit.name, port: explicit ? Number(explicit[1]) : hit.port, portFlag: explicit ? null : hit.flag, fixedPort: !!explicit };
  }
  if (explicit) return { name: "", port: Number(explicit[1]), portFlag: null, fixedPort: true };
  // A wrapper script (turbo, concurrently, a custom file): fall back to dependencies, port only.
  const byDep = FRAMEWORKS.find((f) => f.dep && deps.has(f.dep) && /\b(dev|start|serve|develop)\b/.test(script));
  return byDep ? { name: byDep.name, port: byDep.port, portFlag: null, fixedPort: false } : null;
}

/** Arguments for `<pm> run <script> [extra…]`; npm needs "--" before script arguments. */
export function runArgs(pm: PackageManager, script: string, extra: string[] = []): string[] {
  if (!extra.length) return ["run", script];
  return pm === "npm" ? ["run", script, "--", ...extra] : ["run", script, ...extra];
}

/** Install command for the package manager, honouring the lockfile. */
export function installCommand(pm: PackageManager): string {
  return pm === "yarn" ? "yarn install" : `${pm} install`;
}
