import { createRequire } from "node:module";

// Works from both src/ (tsx) and dist/ (built), since both sit one level below package.json.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string; name: string };

export const VERSION = pkg.version;
export const NAME = pkg.name;
