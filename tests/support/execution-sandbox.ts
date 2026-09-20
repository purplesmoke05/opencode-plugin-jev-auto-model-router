import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "@opencode-ai/sdk/v2";
import { ExecutionHarnessError } from "./execution-signals.js";

export async function executionSandbox(endpoint: URL) {
  await mkdir("/tmp/opencode", { recursive: true });
  const root = await mkdtemp("/tmp/opencode/jev-execution-e2e-");
  const cwd = join(root, "work");
  const env = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    TMPDIR: join(root, "tmp"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_CONFIG: join(root, "opencode.json"),
    TYPESAFE_API_KEY: "e2e-dummy",
    DO_NOT_TRACK: "1",
    NO_COLOR: "1",
  };
  try {
    await Promise.all(
      [
        cwd,
        env.HOME,
        env.XDG_CONFIG_HOME,
        env.XDG_CACHE_HOME,
        env.XDG_DATA_HOME,
        env.XDG_STATE_HOME,
        env.TMPDIR,
      ].map((path) => mkdir(path, { recursive: true })),
    );
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./execution-plugin.ts", import.meta.url))],
      target: "bun",
      format: "esm",
      outdir: root,
    });
    if (!build.success) throw new ExecutionHarnessError(build.logs.map(String).join("\n"));
    const model = {
      tool_call: true,
      reasoning: true,
      limit: { context: 32000, output: 4096 },
      modalities: { input: ["text"], output: ["text"] },
      variants: { max: { reasoningEffort: "max" } },
    } satisfies NonNullable<NonNullable<Config["provider"]>[string]["models"]>[string];
    const providers = Object.fromEntries(
      ["a", "b", "c"].map((name) => [
        name,
        {
          npm: "@ai-sdk/openai-compatible",
          name: `Execution fixture ${name}`,
          options: { apiKey: "e2e-dummy", baseURL: new URL(`${name}/v1`, endpoint).href },
          models: { deepseek: model, other: model },
        },
      ]),
    );
    const config = {
      plugin: [
        [
          join(root, "execution-plugin.js"),
          {
            endpoint: endpoint.href,
            router: {
              candidates: [{ model: "a/deepseek", variant: "max", description: "Fixture model" }],
              fallback: "a/deepseek",
              notify: false,
              executionFallbacks: [
                {
                  models: ["a", "b", "c"].map((provider) => ({
                    model: `${provider}/deepseek`,
                    variant: "max",
                  })),
                },
              ],
            },
          },
        ],
      ],
      enabled_providers: ["a", "b", "c", "jev-router"],
      model: "a/deepseek",
      small_model: "a/other",
      provider: providers,
      agent: {
        title: { disable: true },
        summary: { disable: true },
        build: { model: "a/deepseek", variant: "max" },
        explore: { model: "a/other", variant: "max" },
      },
      permission: { "*": "deny", read: "allow" },
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      lsp: false,
      formatter: false,
      compaction: { auto: false },
    } satisfies Config;
    await Bun.write(env.OPENCODE_CONFIG, JSON.stringify(config));
    return {
      cwd,
      env,
      async [Symbol.asyncDispose]() {
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
