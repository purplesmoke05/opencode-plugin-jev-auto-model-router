import type { PluginModule } from "@opencode-ai/plugin";
import ky from "ky";
import { z } from "zod";
import { parseOptions } from "../../src/config.js";
import { createHooks } from "../../src/hooks.js";
import { createHost } from "../../src/host.js";

const fixtureOptions = z.object({
  endpoint: z.url().refine((value) => new URL(value).hostname === "127.0.0.1"),
  router: z.unknown(),
});

export default {
  id: "jev-execution-e2e",
  server: async (input, rawOptions) => {
    const fixture = fixtureOptions.parse(rawOptions);
    const options = parseOptions(fixture.router);
    const host = createHost(input, options);
    return createHooks(
      {
        ...host,
        ...(host.execution
          ? {
              execution: {
                ...host.execution,
                report: async (sessionID, notice) => {
                  await host.execution?.report(sessionID, notice);
                  await ky.post(new URL("notice", fixture.endpoint), {
                    json: { sessionID, ...notice },
                    headers: { authorization: "Bearer e2e-dummy" },
                    timeout: 5000,
                    retry: 0,
                    redirect: "error",
                  });
                },
              },
            }
          : {}),
      },
      options,
      async () => ({ kind: "selected", model: "a/deepseek", confidence: 1 }),
    );
  },
} satisfies PluginModule;
