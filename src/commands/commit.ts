import os from "node:os";
import { AiError, cleanCommitMessage, prompts } from "../core/ai/index.js";
import { tildify } from "../core/format.js";
import { heuristicMessage } from "../core/commit-heuristic.js";
import { loadConfig, type Lang } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { commit, findRepoRoot, hasGit, pendingChanges, recentSubjects, stageAll, stagedChanges, stagedDiff, type FileChange } from "../core/git.js";
import { t } from "../i18n/index.js";
import { box, cmd, titleBlock, status } from "../ui/components.js";
import { withKeyboardReleased } from "../ui/keys.js";
import { blank, print } from "../ui/print.js";
import { confirm, isCancel, select } from "../ui/prompts.js";
import { columns, isInteractive, write } from "../ui/terminal.js";
import { c, P } from "../ui/theme.js";
import { complete, getProvider } from "./ai-common.js";

export interface CommitOptions {
  yes?: boolean;
  dryRun?: boolean;
  ai?: boolean;
  msgLang?: string;
  all?: boolean;
}

/** File status as a coloured pixel tile: A (added), M (modified), D (deleted)… */
function statusColor(s: string): string {
  const ch = s.trim()[0] ?? "?";
  if (ch === "A" || ch === "?") return c.tile("A", P.ok);
  if (ch === "D") return c.tile("D", P.err);
  if (ch === "R") return c.tile("R", P.info);
  return c.tile(ch, P.warn);
}

function fileList(changes: FileChange[], max = 12): string[] {
  const lines = changes.slice(0, max).map((f) => "  " + statusColor(f.status) + " " + f.path);
  if (changes.length > max) lines.push(c.faint(`  … ${t("commit.more", { n: changes.length - max })}`));
  return lines;
}

export async function commitCommand(opts: CommitOptions, ctx: Ctx): Promise<void> {
  if (!hasGit()) throw new Error(t("commit.noGit"));
  const root = findRepoRoot();
  if (!root) throw new Error(t("commit.notRepo"));
  const lang: Lang = opts.msgLang === "vi" || opts.msgLang === "en" ? opts.msgLang : (loadConfig().commitLang ?? "en");
  const interactive = isInteractive() && !opts.dryRun;

  if (!opts.dryRun) {
    blank();
    print(...titleBlock("COMMIT", tildify(root, os.homedir())));
    blank();
  }

  // 1. Make sure something is staged.
  let staged = await stagedChanges(root);
  if (staged.length === 0) {
    const pending = await pendingChanges(root);
    if (pending.length === 0) {
      print(" " + status.ok(t("commit.clean")));
      blank();
      return;
    }
    let stage = Boolean(opts.all);
    if (!stage && interactive) {
      print(" " + c.muted(t("commit.nothingStaged")));
      print(...fileList(pending));
      blank();
      const ok = await confirm({ message: t("commit.stageAll", { n: pending.length }), initial: true, signal: ctx.signal });
      if (isCancel(ok)) return;
      stage = ok;
    }
    if (!stage) {
      print(" " + status.warn(t("commit.stageFirst", { cmd: cmd("git add <files>"), flag: cmd("--all") })));
      blank();
      return;
    }
    await stageAll(root);
    staged = await stagedChanges(root);
  }

  if (!opts.dryRun) {
    print(" " + c.muted(t("commit.staged", { n: staged.length })));
    print(...fileList(staged));
    blank();
  }

  // 2. Write the message: AI when available, offline heuristic otherwise.
  const generate = async (previous?: string): Promise<{ message: string; source: string }> => {
    if (opts.ai !== false) {
      try {
        const provider = await getProvider(true);
        const [{ diff, stat, truncated }, recent] = await Promise.all([stagedDiff(root), recentSubjects(root)]);
        const user = [
          recent.length ? "Recent commit subjects (match their style and language when sensible):\n" + recent.map((s) => "- " + s).join("\n") : "",
          "Changed files:\n" + stat,
          diff ? "Diff" + (truncated ? " (truncated)" : "") + ":\n" + diff : "(Only lockfiles or binary files changed.)",
          previous ? `A previous suggestion was rejected, write a different one:\n${previous}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        const reply = await complete(
          provider,
          [
            { role: "system", content: prompts.commit(lang) },
            { role: "user", content: user },
          ],
          ctx.signal,
          t("commit.writing", { model: provider.model ?? "" }),
          previous ? 0.7 : 0.2,
        );
        const message = cleanCommitMessage(reply);
        if (message) return { message, source: provider.model ?? "AI" };
      } catch (e) {
        if (e instanceof AiError && e.code === "aborted") throw e;
        if (!opts.dryRun) print(" " + status.warn(t("commit.aiUnavailable", { reason: (e as Error).message })));
      }
    }
    return { message: heuristicMessage(staged, lang), source: t("commit.offline") };
  };

  let { message, source } = await generate();

  if (opts.dryRun) {
    write(message + "\n");
    return;
  }

  for (;;) {
    const w = Math.min(columns() - 2, 90);
    print(...box(message.split("\n"), { title: t("commit.suggestion", { source }), width: w }).map((l) => " " + l));
    blank();
    if (opts.yes || !interactive) break;
    const choice = await select({
      message: t("commit.what"),
      options: [
        { value: "commit", label: t("commit.doCommit") },
        { value: "edit", label: t("commit.doEdit"), hint: t("commit.editHint") },
        { value: "again", label: t("commit.doRegenerate") },
        { value: "cancel", label: t("commit.doCancel") },
      ],
      signal: ctx.signal,
    });
    if (isCancel(choice) || choice === "cancel") {
      print(" " + status.hint(t("commit.cancelled")));
      blank();
      return;
    }
    if (choice === "again") {
      ({ message, source } = await generate(message));
      continue;
    }
    if (choice === "edit") {
      const r = await withKeyboardReleased(() => commit(root, message, true));
      print(r.ok ? " " + status.ok(t("commit.done")) : " " + status.warn(t("commit.abortedByEditor")));
      blank();
      return;
    }
    break;
  }

  const r = await commit(root, message);
  if (r.ok) {
    const first = r.output.split("\n")[0] ?? "";
    print(" " + status.ok(t("commit.done")) + (first ? "  " + c.faint(first) : ""));
  } else {
    print(" " + status.fail(t("commit.failed")));
    print(...r.output.split("\n").map((l) => "   " + c.muted(l)));
    process.exitCode = 1;
  }
  blank();
}
