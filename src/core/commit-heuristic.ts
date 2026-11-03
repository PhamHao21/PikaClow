import { basename, extname } from "node:path";
import type { FileChange } from "./git.js";
import type { Lang } from "./config.js";

// Offline commit message: guesses a Conventional Commit type and scope from which files
// changed. Not as good as an AI reading the diff, but it works everywhere, instantly.

const isDoc = (p: string) => /\.(md|mdx|txt|rst|adoc)$/i.test(p) || /(^|\/)(docs?|documentation)\//i.test(p) || /^(README|CHANGELOG|LICENSE|CONTRIBUTING)/i.test(basename(p));
const isTest = (p: string) => /(^|\/)(tests?|__tests__|spec|e2e)\//i.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p);
const isCi = (p: string) => /^\.github\/workflows\/|^\.gitlab-ci|^\.circleci\/|azure-pipelines|Jenkinsfile/i.test(p);
const isDeps = (p: string) => /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|requirements\.txt|go\.sum)$/i.test(p);
const isBuild = (p: string) =>
  /(^|\/)(package\.json|tsconfig[\w.-]*\.json|vite\.config\.\w+|webpack\.config\.\w+|rollup\.config\.\w+|Dockerfile|docker-compose\.ya?ml|Makefile|Cargo\.toml|pyproject\.toml|go\.mod|build\.gradle(\.kts)?)$/i.test(p);
const isStyle = (p: string) => /\.(css|scss|sass|less|styl)$/i.test(p);
const isConfig = (p: string) => /(^|\/)\.(gitignore|gitattributes|editorconfig|prettierrc[\w.]*|eslintrc[\w.]*|npmrc|nvmrc|env\.example)$|(^|\/)(eslint|prettier)\.config\.\w+$/i.test(p);

function commonScope(paths: string[]): string {
  const dirs = paths.map((p) => p.split("/").slice(0, -1));
  if (dirs.some((d) => d.length === 0)) return paths.length === 1 ? stem(paths[0]!) : "";
  // Deepest shared folder below src/lib/app/packages.
  const first = dirs[0]!;
  let depth = 0;
  while (depth < first.length && dirs.every((d) => d[depth] === first[depth])) depth++;
  const shared = first.slice(0, depth).filter((s) => !/^(src|lib|app|source|packages|pkg|internal)$/i.test(s));
  if (shared.length) return shared[shared.length - 1]!.toLowerCase();
  return paths.length === 1 ? stem(paths[0]!) : "";
}

function stem(p: string): string {
  const b = basename(p);
  return b.slice(0, b.length - extname(b).length).replace(/\.(test|spec)$/, "").toLowerCase();
}

function listNames(paths: string[], lang: Lang): string {
  const names = [...new Set(paths.map((p) => basename(p)))];
  if (names.length <= 2) return names.join(lang === "vi" ? " và " : " and ");
  return lang === "vi" ? `${names.slice(0, 2).join(", ")} và ${names.length - 2} tệp khác` : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

export function heuristicMessage(changes: FileChange[], lang: Lang = "en"): string {
  const paths = changes.map((c) => c.path.replace(/\\/g, "/"));
  const added = changes.filter((c) => c.status.startsWith("A"));
  const deleted = changes.filter((c) => c.status.startsWith("D"));
  const all = (fn: (p: string) => boolean) => paths.length > 0 && paths.every(fn);

  let type = "chore";
  if (all(isDoc)) type = "docs";
  else if (all(isTest)) type = "test";
  else if (all(isCi)) type = "ci";
  else if (all((p) => isDeps(p) || /(^|\/)package\.json$/.test(p))) type = "build";
  else if (all((p) => isBuild(p) || isDeps(p))) type = "build";
  else if (all(isStyle)) type = "style";
  else if (all((p) => isConfig(p) || isDoc(p))) type = "chore";
  else if (added.length > 0 && added.some((a) => !isTest(a.path) && !isDoc(a.path))) type = "feat";
  else if (deleted.length === changes.length) type = "refactor";

  const scope = type === "docs" || type === "ci" || type === "test" ? "" : commonScope(paths);
  const vi = lang === "vi";
  let verb: string;
  let target: string[];
  if (deleted.length === changes.length) {
    verb = vi ? "xoá" : "remove";
    target = paths;
  } else if (added.length === changes.length) {
    verb = vi ? "thêm" : "add";
    target = paths;
  } else {
    verb = vi ? "cập nhật" : "update";
    target = paths;
  }
  const subject = `${verb} ${listNames(target, lang)}`;
  const head = `${type}${scope ? `(${scope})` : ""}: ${subject}`;
  if (changes.length <= 1) return head;
  const body = changes.slice(0, 8).map((c) => {
    const s = c.status[0];
    const v = s === "A" ? (vi ? "thêm" : "add") : s === "D" ? (vi ? "xoá" : "remove") : vi ? "sửa" : "update";
    return `- ${v} ${c.path}`;
  });
  if (changes.length > 8) body.push(vi ? `- và ${changes.length - 8} tệp khác` : `- and ${changes.length - 8} more files`);
  return head + "\n\n" + body.join("\n");
}
