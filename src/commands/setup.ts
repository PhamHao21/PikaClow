import { OllamaProvider, OLLAMA_DEFAULT_URL } from "../core/ai/ollama.js";
import { OpenAiProvider } from "../core/ai/openai.js";
import { pickDefaultModel } from "../core/ai/index.js";
import type { ModelInfo, Provider } from "../core/ai/provider.js";
import { configPath, loadConfig, saveConfig, type AiConfig, type Lang } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { setLang, t } from "../i18n/index.js";
import { cmd, titleBlock, status } from "../ui/components.js";
import { blank, print } from "../ui/print.js";
import { input, isCancel, select } from "../ui/prompts.js";
import { spinner } from "../ui/spinner.js";
import { isInteractive } from "../ui/terminal.js";
import { c } from "../ui/theme.js";
import { NonInteractiveError } from "../ui/keys.js";
import { modelsCommand } from "./models.js";

const PRESETS: { id: string; label: string; url: string; keyEnv: string; needsKey: boolean }[] = [
  { id: "lmstudio", label: "LM Studio (local)", url: "http://127.0.0.1:1234/v1", keyEnv: "", needsKey: false },
  { id: "openrouter", label: "OpenRouter", url: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", needsKey: true },
  { id: "groq", label: "Groq", url: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", needsKey: true },
  { id: "gemini", label: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY", needsKey: true },
  { id: "openai", label: "OpenAI", url: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", needsKey: true },
  { id: "deepseek", label: "DeepSeek", url: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY", needsKey: true },
  { id: "custom", label: "", url: "", keyEnv: "OPENAI_API_KEY", needsKey: true },
];

async function chooseModel(models: ModelInfo[], current: string | undefined, ctx: Ctx): Promise<string | null> {
  if (models.length === 0) return null;
  if (models.length > 20) {
    const r = await input({
      message: t("setup.modelName", { n: models.length }),
      initial: current ?? pickDefaultModel(models) ?? "",
      validate: (v) => (v.trim() ? undefined : t("setup.required")),
      signal: ctx.signal,
    });
    return isCancel(r) ? null : r.trim();
  }
  const r = await select({
    message: t("setup.pickModel"),
    options: models.map((m) => ({ value: m.name, label: m.name, hint: [m.parameters, m.size ? (m.size / 1024 ** 3).toFixed(1) + " GB" : ""].filter(Boolean).join(" · ") })),
    initial: Math.max(0, models.findIndex((m) => m.name === (current ?? pickDefaultModel(models)))),
    signal: ctx.signal,
  });
  return isCancel(r) ? null : r;
}

/** Sends a tiny prompt to prove the connection works. */
async function testProvider(p: Provider, ctx: Ctx): Promise<boolean> {
  const s = spinner(t("setup.testing", { model: p.model ?? "" }));
  const start = Date.now();
  try {
    const reply = await p.chat([{ role: "user", content: "Reply with exactly: pika pika!" }], { signal: ctx.signal, temperature: 0, maxTokens: 400 });
    s.succeed(t("setup.testOk", { ms: ((Date.now() - start) / 1000).toFixed(1), reply: c.brand(reply.trim().slice(0, 60)) }));
    return true;
  } catch (e) {
    s.fail(t("setup.testFail", { reason: (e as Error).message }));
    return false;
  }
}

async function setupOllama(ctx: Ctx): Promise<boolean> {
  const prev = loadConfig().ai;
  let url = prev?.provider === "ollama" && prev.baseUrl ? prev.baseUrl : OLLAMA_DEFAULT_URL;
  let p = new OllamaProvider(url, undefined);
  let st = await p.status();
  if (!st.ok) {
    print(status.warn(t("setup.ollamaOffline", { url })));
    print("  " + c.muted(t("setup.ollamaInstall")) + " " + cmd("https://ollama.com/download"));
    const r = await input({ message: t("setup.ollamaUrl"), initial: url, signal: ctx.signal });
    if (isCancel(r)) return false;
    url = r.trim() || OLLAMA_DEFAULT_URL;
    p = new OllamaProvider(url, undefined);
    st = await p.status();
    if (!st.ok) {
      saveConfig({ ai: { provider: "ollama", baseUrl: url } as AiConfig });
      print(status.hint(t("setup.savedForLater", { cmd: cmd("pikaclow models") })));
      return false;
    }
  }
  print(status.ok(t("setup.ollamaFound", { v: st.version ?? "", url })));
  const models = await p.models();
  if (!models.length) {
    print(status.info(t("setup.noModelsYet")));
    saveConfig({ ai: { provider: "ollama", baseUrl: url } as AiConfig });
    await modelsCommand({}, ctx);
    return true;
  }
  const model = await chooseModel(models, prev?.model, ctx);
  if (!model) return false;
  saveConfig({ ai: { provider: "ollama", baseUrl: url, model } });
  p.model = model;
  return testProvider(p, ctx);
}

async function setupOpenAi(ctx: Ctx): Promise<boolean> {
  const preset = await select({
    message: t("setup.pickService"),
    options: PRESETS.map((x) => ({ value: x, label: x.label || t("setup.customUrl"), hint: x.url })),
    signal: ctx.signal,
  });
  if (isCancel(preset)) return false;
  let url = preset.url;
  if (!url) {
    const r = await input({ message: t("setup.baseUrl"), placeholder: "https://…/v1", validate: (v) => (/^https?:\/\//.test(v.trim()) ? undefined : t("setup.badUrl")), signal: ctx.signal });
    if (isCancel(r)) return false;
    url = r.trim();
  }
  let apiKey: string | undefined;
  let apiKeyEnv: string | undefined;
  if (preset.needsKey) {
    const how = await select({
      message: t("setup.keyHow"),
      options: [
        { value: "env", label: t("setup.keyEnv"), hint: t("setup.recommended") },
        { value: "paste", label: t("setup.keyPaste"), hint: configPath() },
      ],
      signal: ctx.signal,
    });
    if (isCancel(how)) return false;
    if (how === "env") {
      const r = await input({ message: t("setup.envName"), initial: preset.keyEnv, signal: ctx.signal });
      if (isCancel(r)) return false;
      apiKeyEnv = r.trim();
      if (!process.env[apiKeyEnv]) print(status.warn(t("setup.envMissing", { name: apiKeyEnv })));
    } else {
      const r = await input({ message: t("setup.pasteKey"), mask: true, validate: (v) => (v.trim() ? undefined : t("setup.required")), signal: ctx.signal });
      if (isCancel(r)) return false;
      apiKey = r.trim();
    }
  }
  const key = apiKey ?? (apiKeyEnv ? process.env[apiKeyEnv] : undefined);
  const probe = new OpenAiProvider(url, undefined, key);
  const s = spinner(t("setup.listing"));
  let models: ModelInfo[] = [];
  try {
    models = await probe.models();
    s.stop();
  } catch (e) {
    s.fail((e as Error).message);
  }
  let model = await chooseModel(models, loadConfig().ai?.model, ctx);
  if (!model) {
    const r = await input({ message: t("setup.modelManual"), validate: (v) => (v.trim() ? undefined : t("setup.required")), signal: ctx.signal });
    if (isCancel(r)) return false;
    model = r.trim();
  }
  const ai: AiConfig = { provider: "openai", baseUrl: url, model };
  if (apiKeyEnv) ai.apiKeyEnv = apiKeyEnv;
  if (apiKey) ai.apiKey = apiKey;
  // The whole "ai" block is replaced, so a key from another service never lingers.
  saveConfig({ ai });
  return testProvider(new OpenAiProvider(url, model, key), ctx);
}

export async function setupCommand(ctx: Ctx): Promise<void> {
  if (!isInteractive()) throw new NonInteractiveError();
  blank();
  print(...titleBlock("SETUP", configPath()));
  blank();

  const lang = await select<Lang>({
    message: "Language / Ngôn ngữ",
    options: [
      { value: "en", label: "English" },
      { value: "vi", label: "Tiếng Việt" },
    ],
    initial: (loadConfig().lang ?? "en") === "vi" ? 1 : 0,
    signal: ctx.signal,
  });
  if (isCancel(lang)) return;
  saveConfig({ lang });
  setLang(lang);

  const provider = await select({
    message: t("setup.pickProvider"),
    options: [
      { value: "ollama", label: t("setup.ollama"), hint: t("setup.ollamaHint") },
      { value: "openai", label: t("setup.openai"), hint: t("setup.openaiHint") },
      { value: "skip", label: t("setup.skipAi") },
    ],
    initial: loadConfig().ai?.provider === "openai" ? 1 : 0,
    signal: ctx.signal,
  });
  if (isCancel(provider)) return;
  let ok = false;
  if (provider === "ollama") ok = await setupOllama(ctx);
  else if (provider === "openai") ok = await setupOpenAi(ctx);

  if (provider !== "skip") {
    const cl = await select<Lang>({
      message: t("setup.commitLang"),
      options: [
        { value: "en", label: "English", hint: "feat: add login page" },
        { value: "vi", label: "Tiếng Việt", hint: "feat: thêm trang đăng nhập" },
      ],
      initial: (loadConfig().commitLang ?? "en") === "vi" ? 1 : 0,
      signal: ctx.signal,
    });
    if (!isCancel(cl)) saveConfig({ commitLang: cl });
  }

  blank();
  print(ok || provider === "skip" ? status.ok(t("setup.done")) : status.warn(t("setup.partial")));
  print("  " + c.muted(t("setup.try")) + " " + [cmd("pikaclow"), cmd("pikaclow commit"), cmd('pikaclow sh "…"'), cmd("pikaclow doctor")].join(c.faint(" · ")));
  blank();
}
