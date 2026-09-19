import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "@opencode-ai/sdk/v2";
import { z } from "zod";

const cliEvent = z.object({
  type: z.string(),
  sessionID: z.string().optional(),
  part: z.object({ type: z.string(), text: z.string().optional() }).optional(),
});

export class HarnessError extends Error {
  override readonly name = "HarnessError";
}

export async function isolatedOpenCode(endpoint: URL) {
  await mkdir("/tmp/opencode", { recursive: true });
  const root = await mkdtemp("/tmp/opencode/jev-e2e-");
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
      entrypoints: [fileURLToPath(new URL("./plugin.ts", import.meta.url))],
      target: "bun",
      format: "esm",
      outdir: root,
    });
    if (!build.success) throw new HarnessError(build.logs.map(String).join("\n"));
    const model = {
      tool_call: true,
      limit: { context: 32000, output: 4096 },
      modalities: { input: ["text"], output: ["text"] },
    } satisfies NonNullable<NonNullable<Config["provider"]>[string]["models"]>[string];
    const config = {
      $schema: "https://opencode.ai/config.json",
      plugin: [
        [
          join(root, "plugin.js"),
          {
            endpoint: new URL("jev", endpoint).href,
            router: {
              candidates: [
                { model: "mock/fast", description: "Simple" },
                { model: "mock/strong", description: "Hard" },
              ],
              fallback: "mock/strong",
              agents: ["build", "quick"],
              notify: true,
            },
          },
        ],
      ],
      enabled_providers: ["mock", "jev-router"],
      model: "jev-router/auto",
      small_model: "mock/fast",
      provider: {
        mock: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local E2E",
          options: { apiKey: "e2e-dummy", baseURL: new URL("v1", endpoint).href },
          models: { fast: model, strong: model },
        },
      },
      agent: { title: { disable: true }, summary: { disable: true } },
      permission: "deny",
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      lsp: false,
      formatter: false,
      compaction: { auto: false },
    } satisfies Config;
    await Bun.write(env.OPENCODE_CONFIG, JSON.stringify(config));
    const version = (await command(["--version"])).stdout.trim();
    if (version !== "1.18.31") throw new HarnessError(`Expected OpenCode 1.18.31, got ${version}`);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  async function command(args: readonly string[]) {
    const child = Bun.spawn([process.env["OPENCODE_E2E_BINARY"] ?? "opencode", ...args], {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 45_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) {
        throw new HarnessError(
          `opencode ${args.join(" ")} exited ${exitCode}\n${stdout}\n${stderr}`,
        );
      }
      return { stdout, stderr };
    } finally {
      clearTimeout(deadline);
      child.kill();
      await child.exited;
    }
  }

  return {
    root,
    cwd,
    env,
    command,
    async turn(selection: { readonly model?: string; readonly sessionID?: string } = {}) {
      const args = [
        "run",
        "--print-logs",
        "--log-level",
        "DEBUG",
        "--format",
        "json",
        "--title",
        "Isolated routing test",
        "--agent",
        "build",
      ];
      if (selection.model) args.push("-m", selection.model);
      if (selection.sessionID) args.push("--session", selection.sessionID);
      args.push("Reply with a short greeting.");
      const output = await command(args);
      const events = output.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parsed: unknown = JSON.parse(line);
          return cliEvent.parse(parsed);
        });
      if (events.some((event) => event.type === "error") || events.length === 0) {
        throw new HarnessError(
          `OpenCode did not complete a turn\n${output.stdout}\n${output.stderr}`,
        );
      }
      return events;
    },
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
