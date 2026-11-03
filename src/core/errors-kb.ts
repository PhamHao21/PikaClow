// Offline knowledge base of common developer errors. `explain` shows these instantly,
// before (or instead of) asking an AI, and can act on some of them (e.g. free a port).

export interface KnownError {
  id: string;
  /** Captured values, e.g. { port: "3000" }. */
  vars: Record<string, string>;
  /** Suggested commands to run. */
  fixes: string[];
  /** Something PikaClow can do right away. */
  action?: { type: "kill-port"; port: number };
}

interface Pattern {
  id: string;
  re: RegExp;
  vars?: (m: RegExpExecArray) => Record<string, string>;
  fixes?: (v: Record<string, string>, os: NodeJS.Platform) => string[];
  action?: (v: Record<string, string>) => KnownError["action"];
}

const PATTERNS: Pattern[] = [
  {
    id: "portInUse",
    re: /EADDRINUSE[^\n]*?:(\d{2,5})|address already in use[^\n]*?:(\d{2,5})|port (\d{2,5}) is (?:already )?in use|Port (\d{2,5}) is in use|bind: address already in use[^\n]*?(\d{2,5})/i,
    vars: (m) => ({ port: m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "" }),
    fixes: (v) => [`pikaclow ports ${v.port} --kill`],
    action: (v) => (Number(v.port) > 0 ? { type: "kill-port", port: Number(v.port) } : undefined),
  },
  {
    id: "execPolicy",
    re: /running scripts is disabled on this system|cannot be loaded because running scripts is disabled/i,
    fixes: () => ["Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned"],
  },
  {
    id: "cmdNotFoundWin",
    re: /'([^'\r\n]+)' is not recognized as an internal or external command/i,
    vars: (m) => ({ cmd: m[1] ?? "" }),
  },
  {
    id: "cmdNotFoundPs",
    re: /The term '([^'\r\n]+)' is not recognized as (?:the )?name of a cmdlet/i,
    vars: (m) => ({ cmd: m[1] ?? "" }),
  },
  {
    id: "cmdNotFoundUnix",
    re: /(?:command not found: (\S+)|(\S+): command not found|(\S+): not found$)/im,
    vars: (m) => ({ cmd: m[1] ?? m[2] ?? m[3] ?? "" }),
  },
  {
    id: "pythonStoreAlias",
    re: /Python was not found; run without arguments to install from the Microsoft Store/i,
    fixes: () => ["winget install Python.Python.3.12"],
  },
  {
    id: "moduleNotFoundNode",
    re: /Cannot find (?:module|package) '([^']+)'|ERR_MODULE_NOT_FOUND[^\n]*'([^']+)'/,
    vars: (m) => ({ module: m[1] ?? m[2] ?? "" }),
    fixes: (v) => (v.module && !v.module.startsWith(".") && !/[\\/]/.test(v.module.replace(/^@[^/]+\//, "")) ? ["npm install", `npm install ${v.module}`] : ["npm install"]),
  },
  {
    id: "moduleNotFoundPy",
    re: /ModuleNotFoundError: No module named '([^']+)'/,
    vars: (m) => ({ module: m[1] ?? "" }),
    fixes: (v) => [`pip install ${(v.module ?? "").split(".")[0]}`],
  },
  { id: "heapOom", re: /JavaScript heap out of memory|Reached heap limit/i, fixes: (_v, os) => [os === "win32" ? '$env:NODE_OPTIONS="--max-old-space-size=4096"' : 'export NODE_OPTIONS="--max-old-space-size=4096"'] },
  { id: "eresolve", re: /ERESOLVE (?:unable to resolve|could not resolve)/i, fixes: () => ["npm install --legacy-peer-deps"] },
  { id: "npm404", re: /npm (?:ERR!|error) code E404|404 Not Found - GET https:\/\/registry\.npmjs\.org\/([^\s]+)/i },
  { id: "gyp", re: /gyp ERR!|node-gyp|MSB8036|Could not find any Visual Studio installation/i, fixes: (_v, os) => (os === "win32" ? ["winget install Microsoft.VisualStudio.2022.BuildTools"] : ["xcode-select --install"]) },
  { id: "esmImport", re: /Cannot use import statement outside a module/ },
  { id: "requireEsm", re: /ERR_REQUIRE_ESM|require\(\) of ES Module/ },
  { id: "enospcWatch", re: /ENOSPC: System limit for number of file watchers reached/i, fixes: () => ["echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p"] },
  { id: "enospc", re: /ENOSPC|No space left on device|There is not enough space on the disk/i, fixes: () => ["pikaclow clean", "pikaclow clean --caches"] },
  { id: "eacces", re: /EACCES|EPERM|Permission denied|Access is denied|UnauthorizedAccessException/i },
  { id: "enoentFile", re: /ENOENT: no such file or directory,? (?:open|stat|scandir|lstat) '([^']+)'/, vars: (m) => ({ file: m[1] ?? "" }) },
  { id: "notGitRepo", re: /not a git repository/i, fixes: () => ["git init"] },
  { id: "sshPublickey", re: /Permission denied \(publickey\)/, fixes: () => ["ssh-keygen -t ed25519", "ssh -T git@github.com"] },
  { id: "unrelatedHistories", re: /refusing to merge unrelated histories/, fixes: () => ["git pull origin main --allow-unrelated-histories"] },
  { id: "gitPushRejected", re: /\[rejected\][^\n]*\(fetch first\)|Updates were rejected because the remote contains work/i, fixes: () => ["git pull --rebase", "git push"] },
  { id: "certs", re: /UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT_IN_CHAIN|self[- ]signed certificate|CERT_HAS_EXPIRED|unable to get local issuer certificate/i },
  { id: "connRefused", re: /ECONNREFUSED\s+([\d.:[\]a-f]+)/i, vars: (m) => ({ addr: m[1] ?? "" }) },
  { id: "timeout", re: /ETIMEDOUT|ESOCKETTIMEDOUT|network timeout/i },
  { id: "tsError", re: /error TS(\d{4,5}):/, vars: (m) => ({ code: m[1] ?? "" }) },
  { id: "crlf", re: /LF will be replaced by CRLF|CRLF will be replaced by LF/i, fixes: () => ["git config --global core.autocrlf true"] },
];

export function matchKnownErrors(output: string, platform: NodeJS.Platform = process.platform): KnownError[] {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const found: KnownError[] = [];
  const seen = new Set<string>();
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    // Some patterns overlap (ENOSPC for watchers vs disk); keep the more specific one.
    if (p.id === "enospc" && seen.has("enospcWatch")) continue;
    if (p.id.startsWith("cmdNotFound") && [...seen].some((s) => s.startsWith("cmdNotFound"))) continue;
    const vars = p.vars?.(m) ?? {};
    const action = p.action?.(vars);
    found.push({ id: p.id, vars, fixes: p.fixes?.(vars, platform) ?? [], ...(action ? { action } : {}) });
    seen.add(p.id);
  }
  return found;
}
