// Static risk check for shell commands, independent of any AI. Suggested commands are
// shown with this verdict; "danger" requires typing an explicit confirmation.

export type Risk = "safe" | "caution" | "danger";

export interface RiskRule {
  level: Exclude<Risk, "safe">;
  re: RegExp;
  /** i18n key suffix under "risk." */
  reason: string;
}

export const RISK_RULES: RiskRule[] = [
  // Deleting things
  { level: "danger", re: /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*|(--recursive|-r)\b.*(--force|-f)\b|(--force|-f)\b.*(--recursive|-r)\b)/i, reason: "recursiveDelete" },
  { level: "danger", re: /\brm\s+-\w*r\w*\s+(\/|~|\*|\.|\$HOME|\/\*)(\s|$)/i, reason: "deleteEverything" },
  { level: "danger", re: /\b(Remove-Item|rm|ri|del|erase|rmdir|rd)\b[^|;&]*\s-(Recurse|r)\b/i, reason: "recursiveDelete" },
  { level: "danger", re: /\b(rd|rmdir)\s+(\/s|\/q)/i, reason: "recursiveDelete" },
  { level: "danger", re: /\b(del|erase)\s+[^|&]*\/[sq]\b/i, reason: "recursiveDelete" },
  { level: "danger", re: /\bgit\s+clean\s+-\w*f/i, reason: "gitClean" },
  { level: "danger", re: /\bgit\s+reset\s+--hard\b/i, reason: "gitResetHard" },
  { level: "danger", re: /\b(mv|move|Move-Item)\b.*\s(\/dev\/null|NUL)\s*$/i, reason: "deleteEverything" },
  // Disks and system
  { level: "danger", re: /\bformat(\.com)?\s+[a-z]:/i, reason: "disk" },
  { level: "danger", re: /\b(mkfs(\.\w+)?|fdisk|diskpart|parted|wipefs|sgdisk)\b/i, reason: "disk" },
  { level: "danger", re: /\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i, reason: "disk" },
  { level: "danger", re: /\bdd\s+[^|]*\bof=\/dev\//i, reason: "disk" },
  { level: "danger", re: />\s*\/dev\/(sd|nvme|hd|disk)/i, reason: "disk" },
  { level: "danger", re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "forkBomb" },
  { level: "danger", re: /\b(bcdedit|vssadmin\s+delete|wbadmin\s+delete|cipher\s+\/w)\b/i, reason: "system" },
  { level: "danger", re: /\breg(\.exe)?\s+delete\b|Remove-Item(Property)?\b[^|;]*\bHK(LM|CU|CR|U|CC):/i, reason: "registry" },
  { level: "danger", re: /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|Invoke-Expression|python\d?|pwsh|powershell)\b/i, reason: "remoteScript" },
  { level: "danger", re: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, reason: "database" },
  { level: "danger", re: /\bsetx\s+PATH\b/i, reason: "setxPath" },
  { level: "danger", re: /\bchmod\s+-R\s+[0-7]*7[0-7]*\s+\/(\s|$)|\bchown\s+-R\s+\S+\s+\/(\s|$)/i, reason: "permissionsRoot" },
  // Needs a second look
  { level: "caution", re: /\b(shutdown|reboot|halt|poweroff)\b|\b(Stop|Restart)-Computer\b/i, reason: "power" },
  { level: "caution", re: /\bgit\s+push\b[^|;]*\s(--force|-f|--force-with-lease)\b/i, reason: "gitForcePush" },
  { level: "caution", re: /\bgit\s+(checkout\s+--\s+\.|restore\s+\.|stash\s+(drop|clear))/i, reason: "gitDiscard" },
  { level: "caution", re: /\bSet-ExecutionPolicy\b/i, reason: "execPolicy" },
  { level: "caution", re: /\bsudo\b|\brunas\b|Start-Process\b[^|]*-Verb\s+RunAs/i, reason: "admin" },
  { level: "caution", re: /\b(kill|pkill|killall)\s+-9\b|\bStop-Process\b|\btaskkill\b/i, reason: "killProcess" },
  { level: "caution", re: /\bchmod\s+(-R\s+)?777\b/i, reason: "permissions" },
  { level: "caution", re: /\bchown\s+-R\b/i, reason: "permissions" },
  { level: "caution", re: /\b(npm|pnpm|yarn)\s+(publish|unpublish)\b/i, reason: "publish" },
  { level: "caution", re: /\bdocker\s+(system\s+prune|volume\s+(rm|prune)|rm\s+-f|rmi\s+-f)/i, reason: "docker" },
  { level: "caution", re: /\[Environment\]::SetEnvironmentVariable|\bsetx\b/i, reason: "envVar" },
  { level: "caution", re: />\s*~?\/?[\w./-]*\.(bashrc|zshrc|profile|bash_profile)\b(?!\s*>>)/i, reason: "overwriteConfig" },
  { level: "caution", re: /\b(Remove-Item|rm|del|erase|unlink|ri)\b/i, reason: "delete" },
  { level: "caution", re: /(^|[^>\d])>\s*(?!(\$null|nul|\/dev\/null)(\s|$))[^>&|\s]+/i, reason: "overwriteFile" },
  { level: "caution", re: /\b(npm|pnpm|yarn)\s+(i|install|add)\s+(-g|--global)\b|\bnpm\s+-g\s+(i|install)\b/i, reason: "globalInstall" },
];

export interface RiskReport {
  level: Risk;
  reasons: string[];
}

export function assessCommand(command: string): RiskReport {
  const reasons: string[] = [];
  let level: Risk = "safe";
  for (const rule of RISK_RULES) {
    if (!rule.re.test(command)) continue;
    if (!reasons.includes(rule.reason)) reasons.push(rule.reason);
    if (rule.level === "danger") level = "danger";
    else if (level === "safe") level = "caution";
  }
  // A generic "delete" note is noise once a stronger delete reason exists.
  if (reasons.length > 1) {
    const i = reasons.indexOf("delete");
    if (i >= 0 && reasons.some((r) => r === "recursiveDelete" || r === "deleteEverything")) reasons.splice(i, 1);
  }
  return { level, reasons };
}
