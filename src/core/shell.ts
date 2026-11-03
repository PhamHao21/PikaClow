import { spawn } from "node:child_process";
import { basename } from "node:path";
import { isWindows, which } from "./exec.js";

export type ShellKind = "powershell" | "pwsh" | "cmd" | "bash" | "zsh" | "fish" | "sh";

export interface ShellInfo {
  kind: ShellKind;
  exe: string;
  /** Human name for prompts: "PowerShell 5.1", "bash"… */
  label: string;
}

/**
 * Best guess of the shell the user is typing in.
 * Windows: Git Bash sets MSYSTEM, cmd.exe defines PROMPT, PowerShell 7 puts its own
 * module path in PSModulePath; otherwise Windows PowerShell. Unix: $SHELL.
 */
export function detectShell(override?: string): ShellInfo {
  const pick = (kind: ShellKind): ShellInfo => {
    switch (kind) {
      case "powershell":
        return { kind, exe: "powershell.exe", label: "Windows PowerShell 5.1" };
      case "pwsh":
        return { kind, exe: which("pwsh") ?? "pwsh", label: "PowerShell 7" };
      case "cmd":
        return { kind, exe: process.env.ComSpec ?? "cmd.exe", label: "cmd.exe" };
      default:
        return { kind, exe: which(kind) ?? kind, label: kind };
    }
  };
  if (override) {
    const k = override.toLowerCase().replace(/\.exe$/, "") as ShellKind;
    if (["powershell", "pwsh", "cmd", "bash", "zsh", "fish", "sh"].includes(k)) return pick(k);
  }
  const env = process.env;
  if (isWindows) {
    if (env.MSYSTEM || /bash/i.test(env.SHELL ?? "")) return { kind: "bash", exe: which("bash") ?? "bash", label: "Git Bash" };
    if (env.PROMPT && !env.PSModulePath?.includes("PowerShell\\7")) return pick("cmd");
    if (/PowerShell[\\/]7/i.test(env.PSModulePath ?? "") && which("pwsh")) return pick("pwsh");
    return pick("powershell");
  }
  const sh = basename(env.SHELL ?? "sh");
  if (sh === "zsh" || sh === "bash" || sh === "fish") return pick(sh);
  return pick("sh");
}

// -EncodedCommand (UTF-16LE base64) sidesteps every quoting pitfall of passing a command line.
function psArgs(command: string): string[] {
  return ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
}

/** Runs a command line in the given shell with the terminal attached. Resolves to the exit code. */
export function runInShell(command: string, shell: ShellInfo, cwd = process.cwd()): Promise<number | null> {
  let args: string[];
  switch (shell.kind) {
    case "powershell":
    case "pwsh":
      args = psArgs(command);
      break;
    case "cmd":
      args = ["/d", "/s", "/c", `"${command}"`];
      break;
    default:
      args = ["-c", command];
  }
  return new Promise((resolve) => {
    const child = spawn(shell.exe, args, { stdio: "inherit", cwd, windowsVerbatimArguments: shell.kind === "cmd" });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
}

/**
 * Runs a command line in the shell while showing its output live and capturing it
 * (colors are kept via FORCE_COLOR). Used by `explain -- <command>`.
 */
export function runAndCapture(
  command: string,
  shell: ShellInfo,
  onData: (chunk: string) => void,
  cwd = process.cwd(),
): Promise<{ code: number | null; output: string }> {
  let args: string[];
  switch (shell.kind) {
    case "powershell":
    case "pwsh":
      args = psArgs(command);
      break;
    case "cmd":
      args = ["/d", "/s", "/c", `"${command}"`];
      break;
    default:
      args = ["-c", command];
  }
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(shell.exe, args, {
      cwd,
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
      windowsVerbatimArguments: shell.kind === "cmd",
    });
    const take = (d: Buffer) => {
      const s = d.toString("utf8");
      output += s;
      if (output.length > 400_000) output = output.slice(-200_000);
      onData(s);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (e) => resolve({ code: null, output: output + String(e) }));
    child.on("close", (code) => resolve({ code, output }));
  });
}

/** Copies text to the clipboard with the platform tool. */
export function copyToClipboard(text: string): Promise<boolean> {
  const tool: [string, string[]] | null = isWindows
    ? ["clip.exe", []]
    : process.platform === "darwin"
      ? ["pbcopy", []]
      : which("wl-copy")
        ? ["wl-copy", []]
        : which("xclip")
          ? ["xclip", ["-selection", "clipboard"]]
          : which("xsel")
            ? ["xsel", ["--clipboard", "--input"]]
            : null;
  if (!tool) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(tool[0], tool[1], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    // clip.exe reads the console code page; UTF-16LE with BOM keeps Vietnamese intact.
    if (isWindows) child.stdin?.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
    else child.stdin?.end(text);
  });
}
