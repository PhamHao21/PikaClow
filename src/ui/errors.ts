import { AiError } from "../core/ai/provider.js";
import { isAbortError } from "../core/context.js";
import { t } from "../i18n/index.js";
import { NonInteractiveError } from "./keys.js";
import { print } from "./print.js";
import { c, sym } from "./theme.js";

/** Prints an error the way users should see it: one clear line, plus a hint when we have one. */
export function reportError(e: unknown): void {
  if (isAbortError(e) || (e instanceof AiError && e.code === "aborted")) {
    print(c.faint(sym("diamondOpen") + " " + t("common.cancelled")));
    return;
  }
  if (e instanceof AiError) {
    print(c.err(sym("fail") + " " + e.message));
    if (e.hint) print(c.faint("  " + sym("pointerSmall") + " ") + c.muted(e.hint));
    return;
  }
  if (e instanceof NonInteractiveError) {
    print(c.err(sym("fail") + " " + t("common.needsTty")));
    return;
  }
  const err = e as Error;
  print(c.err(sym("fail") + " " + (err?.message || String(e))));
  if (process.env.PIKACLOW_DEBUG) print(c.faint(err?.stack ?? ""));
  else print(c.faint("  " + t("common.debugHint")));
}
