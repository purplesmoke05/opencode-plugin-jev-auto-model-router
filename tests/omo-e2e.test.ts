import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { startBackends } from "./support/backends.js";
import { isolatedOpenCode } from "./support/opencode.js";

const pluginPath = process.env["OPENCODE_E2E_OMO_PLUGIN"];
const configSchema = z.looseObject({
  plugin: z.array(z.unknown()),
  agent: z.record(z.string(), z.looseObject({})),
});
const toolsSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() })),
  tools: z.array(
    z.object({
      function: z.object({
        name: z.string(),
        parameters: z.object({ properties: z.record(z.string(), z.unknown()) }),
      }),
    }),
  ),
});

function observeTools(endpoint: URL) {
  const requests: z.infer<typeof toolsSchema>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const pathname = new URL(request.url).pathname;
      if (pathname === "/v1/chat/completions") {
        const parsed: unknown = JSON.parse(body);
        requests.push(toolsSchema.parse(parsed));
      }
      return fetch(new URL(pathname, endpoint), {
        method: request.method,
        headers: request.headers,
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(5_000),
      });
    },
  });
  return {
    url: server.url,
    requests,
    async [Symbol.asyncDispose]() {
      await server.stop(true);
    },
  };
}

async function configureOmo(cli: Awaited<ReturnType<typeof isolatedOpenCode>>) {
  const parsed: unknown = await Bun.file(cli.env.OPENCODE_CONFIG).json();
  const config = configSchema.parse(parsed);
  await Bun.write(
    cli.env.OPENCODE_CONFIG,
    JSON.stringify({
      ...config,
      model: "mock/strong",
      plugin: [z.string().min(1).parse(pluginPath), ...config.plugin],
      agent: { ...config.agent, build: { model: "mock/strong", mode: "primary" } },
    }),
  );
  const directory = join(cli.env.HOME, ".omo");
  await mkdir(directory);
  await Bun.write(
    join(directory, "omo.jsonc"),
    JSON.stringify({
      telemetry: false,
      auto_update: false,
      model_fallback: false,
      runtime_fallback: { enabled: true, restore_primary_after_cooldown: false },
      model_capabilities: { enabled: false, auto_refresh_on_start: false },
      sisyphus_agent: { disabled: true },
      team_mode: { enabled: false },
      tmux: { enabled: false },
      claude_code: {
        mcp: false,
        commands: false,
        skills: false,
        agents: false,
        hooks: false,
        plugins: false,
      },
      disabled_mcps: ["websearch", "context7", "grep_app"],
      disabled_skills: ["security-research", "security-review"],
      disabled_hooks: [
        "todo-continuation-enforcer",
        "goal",
        "ulw-execute",
        "atlas",
        "auto-update-checker",
        "ast-grep-sg-provision",
        "startup-toast",
        "session-notification",
        "background-notification",
        "model-fallback",
      ],
      agents: Object.fromEntries(
        [
          "sisyphus",
          "hephaestus",
          "sisyphus-junior",
          "prometheus",
          "atlas",
          "oracle",
          "explore",
          "librarian",
          "multimodal-looker",
          "metis",
          "momus",
        ].map((name) => [name, { model: "mock/strong" }]),
      ),
    }),
  );
}

describe.skipIf(process.env["OPENCODE_E2E"] !== "1" || !pluginPath)(
  "force routing with actual installed OMO (OPENCODE_E2E_OMO_PLUGIN)",
  () => {
    test("routes an actual OMO delegated child despite its configured model", async () => {
      await using backend = startBackends();
      backend.behavior.delegate = true;
      backend.behavior.omoTask = true;
      await using observer = observeTools(backend.url);
      await using cli = await isolatedOpenCode(observer.url, "force");
      await configureOmo(cli);
      await cli.turn({ model: "mock/strong" });
      const task = observer.requests[0]?.tools.find((tool) => tool.function.name === "task");
      expect(Object.keys(task?.function.parameters.properties ?? {})).toContain(
        "run_in_background",
      );
      const toolResults = observer.requests.flatMap((request) =>
        request.messages.filter((message) => message.role === "tool"),
      );
      const traces = await Bun.file(join(cli.cwd, "hook-trace.jsonl")).text();
      expect(backend.classifications, `${JSON.stringify(toolResults)}\n${traces}`).toHaveLength(2);
      expect(backend.completions.map((request) => request.model)).toEqual(["fast", "fast", "fast"]);
      expect(backend.rejected).toEqual([]);
    }, 60_000);

    test.each([
      {
        name: "routes an explicit main model",
        prompt: "Reply with a short greeting.",
        model: "fast",
        classifications: 1,
      },
      {
        name: "preserves an internal retry model",
        prompt:
          "Retry the prior request.\n<!-- OMO_RUNTIME_FALLBACK_RETRY -->\n<!-- OMO_INTERNAL_INITIATOR -->",
        model: "strong",
        classifications: 0,
      },
      {
        name: "preserves an internal notification model",
        prompt: "Task completed.\n<!-- OMO_INTERNAL_INITIATOR -->",
        model: "strong",
        classifications: 0,
      },
    ])(
      "$name",
      async ({ prompt, model, classifications }) => {
        // Given
        await using backend = startBackends();
        await using observer = observeTools(backend.url);
        await using cli = await isolatedOpenCode(observer.url, "force");
        await configureOmo(cli);
        // When
        const events = await cli.turn({ model: "mock/strong", prompt });
        // Then
        const task = observer.requests[0]?.tools.find((tool) => tool.function.name === "task");
        expect(Object.keys(task?.function.parameters.properties ?? {})).toEqual(
          expect.arrayContaining(["category", "load_skills", "run_in_background"]),
        );
        expect(backend.classifications).toHaveLength(classifications);
        expect(backend.completions.map((request) => request.model)).toEqual([model]);
        expect(events.some((event) => event.part?.text === `fixture:${model}`)).toBe(true);
        expect(backend.rejected).toEqual([]);
      },
      60_000,
    );
  },
);
