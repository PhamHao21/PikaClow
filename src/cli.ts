#!/usr/bin/env node
import { Command, Help } from "commander";
import { loadConfig } from "./core/config.js";
import { cliContext, isAbortError, type Ctx } from "./core/context.js";
import { setLang, t, type MessageKey } from "./i18n/index.js";
import { reportError } from "./ui/errors.js";
import { print } from "./ui/print.js";
import { isInteractive, restoreTerminal } from "./ui/terminal.js";
import { c, setGlyphs, setTheme } from "./ui/theme.js";
import { fit } from "./ui/text.js";
import { smallLogo } from "./ui/logo.js";
import { VERSION } from "./version.js";
import { askCommand } from "./commands/ask.js";
import { cleanCommand } from "./commands/clean.js";
import { commitCommand } from "./commands/commit.js";
import { dashCommand } from "./commands/dash.js";
import { doctorCommand } from "./commands/doctor.js";
import { explainCommand } from "./commands/explain.js";
import { homeCommand } from "./commands/home.js";
import { modelsCommand } from "./commands/models.js";
import { portsCommand } from "./commands/ports.js";
import { setupCommand } from "./commands/setup.js";
import { shCommand } from "./commands/sh.js";

// ── Settings from config, env and global flags (before anything renders) ───────
const config = loadConfig();
if (config.lang) setLang(config.lang);
if (config.theme && !process.env.PIKACLOW_THEME) setTheme(config.theme);
const argv = process.argv;
const langAt = argv.findIndex((a) => a === "--lang" || a.startsWith("--lang="));
const langValue = langAt > 0 ? (argv[langAt]!.includes("=") ? argv[langAt]!.split("=")[1] : argv[langAt + 1]) : undefined;
if (langValue === "vi" || langValue === "en") setLang(langValue);
if (argv.includes("--ascii")) setGlyphs("ascii");

/** Wraps a command action: cancellation context, friendly errors, exit code. */
function action<A extends unknown[]>(fn: (ctx: Ctx, ...args: A) => Promise<void>) {
  return async (...args: A) => {
    const ctx = cliContext();
    try {
      await fn(ctx, ...args);
    } catch (e) {
      reportError(e);
      process.exitCode = isAbortError(e) ? 130 : 1;
    } finally {
      ctx.dispose();
      restoreTerminal();
    }
  };
}

// ── Help ───────────────────────────────────────────────────────────────────────
const GROUPS: { title: MessageKey; commands: [string, MessageKey][] }[] = [
  {
    title: "help.system",
    commands: [
      ["dash", "cli.dash"],
      ["top", "cli.top"],
      ["ports [port]", "cli.ports"],
      ["clean [path]", "cli.clean"],
      ["doctor", "cli.doctor"],
    ],
  },
  {
    title: "help.ai",
    commands: [
      ["ask <question>", "cli.ask"],
      ["sh <task>", "cli.sh"],
      ["explain -- <cmd>", "cli.explain"],
      ["commit", "cli.commit"],
      ["models", "cli.models"],
      ["setup", "cli.setup"],
    ],
  },
];

function rootHelp(): string {
  const lines: string[] = [];
  lines.push("", " " + smallLogo() + c.faint("  v" + VERSION) + "  " + c.muted(t("cli.description")), "");
  lines.push(" " + c.bold(t("help.usage")) + "  " + c.brand("pikaclow") + c.soft(" [command] [options]") + c.faint("   (" + t("help.interactive") + ")"), "");
  for (const g of GROUPS) {
    lines.push(" " + c.bold(t(g.title)));
    for (const [name, desc] of g.commands) lines.push("   " + c.brand(fit(name, 20)) + c.muted(t(desc)));
    lines.push("");
  }
  lines.push(" " + c.bold(t("help.options")));
  const opts: [string, MessageKey | null][] = [
    ["--lang <en|vi>", "cli.opt.lang"],
    ["--ascii", "cli.opt.ascii"],
    ["--no-color", "cli.opt.noColor"],
    ["-v, --version", null],
  ];
  for (const [o, d] of opts) lines.push("   " + c.soft(fit(o, 20)) + c.muted(d ? t(d) : "version"));
  lines.push("", " " + c.bold(t("help.examples")));
  for (const ex of ["pikaclow ports 3000 --kill", "pikaclow clean ~/code", "pikaclow explain -- npm run build", 'pikaclow sh "find files bigger than 100MB"', "git add . && pikaclow commit"]) {
    lines.push("   " + c.faint("$ ") + ex);
  }
  lines.push("", " " + c.faint(t("help.more", { cmd: "pikaclow <command> --help" })), "");
  return lines.join("\n");
}

const program = new Command();
program
  .name("pikaclow")
  .description(t("cli.description"))
  .version(VERSION, "-v, --version")
  .option("--lang <lang>", t("cli.opt.lang"))
  .option("--ascii", t("cli.opt.ascii"))
  .option("--no-color", t("cli.opt.noColor"))
  .configureHelp({
    formatHelp: (cmd, helper) => (cmd.parent ? Help.prototype.formatHelp.call(helper, cmd, helper) : rootHelp()),
    styleTitle: (s) => c.bold(s),
    styleCommandText: (s) => c.brand(s),
    styleSubcommandText: (s) => c.brand(s),
    styleOptionText: (s) => c.soft(s),
    styleArgumentText: (s) => c.soft(s),
    styleDescriptionText: (s) => c.muted(s),
  })
  .argument("[command]")
  .allowExcessArguments()
  .action(
    action(async (_ctx, unknown: string | undefined) => {
      if (unknown) {
        const names = program.commands.flatMap((x) => [x.name(), ...x.aliases()]);
        const guess = names.map((n) => [n, distance(unknown, n)] as const).sort((a, b) => a[1] - b[1])[0];
        print(c.err(t("cli.unknownCommand", { name: unknown })) + (guess && guess[1] <= 2 ? "  " + c.muted(t("cli.didYouMean", { name: c.brand("pikaclow " + guess[0]) })) : ""));
        print(c.faint(t("cli.seeHelp", { cmd: "pikaclow --help" })));
        process.exitCode = 1;
        return;
      }
      if (isInteractive()) await homeCommand();
      else print(rootHelp());
    }),
  );

/** Edit distance, for "did you mean" suggestions. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

program
  .command("dash")
  .description(t("cli.dash"))
  .option("-1, --once", t("cli.opt.once"))
  .action(action((ctx, opts) => dashCommand(opts, ctx)));

program
  .command("top")
  .description(t("cli.top"))
  .action(action((ctx) => dashCommand({ view: "processes" }, ctx)));

program
  .command("ports [port]")
  .description(t("cli.ports"))
  .option("-a, --all", t("cli.opt.allPorts"))
  .option("-k, --kill", t("cli.opt.kill"))
  .option("-y, --yes", t("cli.opt.yes"))
  .option("-u, --udp", t("cli.opt.udp"))
  .option("-i, --pick", t("cli.opt.pick"))
  .option("--json", t("cli.opt.json"))
  .action(action((ctx, port: string | undefined, opts) => portsCommand(port, opts, ctx)));

program
  .command("clean [path]")
  .description(t("cli.clean"))
  .option("-n, --dry-run", t("cli.opt.dryRun"))
  .option("-y, --yes", t("cli.opt.yes"))
  .option("-d, --depth <n>", t("cli.opt.depth"))
  .option("-c, --caches", t("cli.opt.caches"))
  .option("--json", t("cli.opt.json"))
  .action(action((ctx, path: string | undefined, opts) => cleanCommand(path, opts, ctx)));

program
  .command("doctor")
  .description(t("cli.doctor"))
  .option("--json", t("cli.opt.json"))
  .action(action((ctx, opts) => doctorCommand(opts, ctx)));

program
  .command("ask [question...]")
  .description(t("cli.ask"))
  .action(action((ctx, words: string[]) => askCommand(words, ctx)));

program
  .command("sh [task...]")
  .description(t("cli.sh"))
  .option("-s, --shell <shell>", t("cli.opt.shell"))
  .option("-r, --run", t("cli.opt.run"))
  .option("-c, --copy", t("cli.opt.copy"))
  .action(action((ctx, words: string[], opts) => shCommand(words, opts, ctx)));

program
  .command("explain [text...]")
  .description(t("cli.explain"))
  .option("--no-ai", t("cli.opt.noAi"))
  .option("--always", t("cli.opt.always"))
  .action(
    action((ctx, words: string[], opts) => {
      // Everything after "--" is a command to run: pikaclow explain -- npm run build
      const dd = process.argv.indexOf("--");
      const command = dd >= 0 ? process.argv.slice(dd + 1) : undefined;
      return explainCommand(command ? [] : words, opts, ctx, command);
    }),
  );

program
  .command("commit")
  .description(t("cli.commit"))
  .option("-y, --yes", t("cli.opt.yes"))
  .option("-a, --all", t("cli.opt.stageAll"))
  .option("-n, --dry-run", t("cli.opt.commitDry"))
  .option("--no-ai", t("cli.opt.noAi"))
  .option("-L, --msg-lang <lang>", t("cli.opt.commitLang"))
  .action(action((ctx, opts) => commitCommand(opts, ctx)));

program
  .command("models")
  .alias("llm-check")
  .description(t("cli.models"))
  .option("-a, --all", t("cli.opt.allModels"))
  .option("--pull <model>", t("cli.opt.pull"))
  .option("--use <model>", t("cli.opt.use"))
  .option("--refresh", t("cli.opt.refresh"))
  .option("--json", t("cli.opt.json"))
  .action(action((ctx, opts) => modelsCommand(opts, ctx)));

program
  .command("setup")
  .description(t("cli.setup"))
  .action(action((ctx) => setupCommand(ctx)));

try {
  await program.parseAsync(process.argv);
} catch (e) {
  reportError(e);
  process.exitCode = 1;
}
