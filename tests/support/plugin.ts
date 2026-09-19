import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginModule } from "@opencode-ai/plugin";
import { z } from "zod";
import { parseOptions } from "../../src/config.js";
import { createHooks } from "../../src/hooks.js";
import { createHost } from "../../src/host.js";
import { createDecider } from "../../src/jev.js";
import { inspectMessage } from "../../src/message-policy.js";

const fixtureOptions = z.object({
  endpoint: z.url().refine((value) => new URL(value).hostname === "127.0.0.1"),
  router: z.unknown(),
});

export default {
  id: "jev-auto-e2e",
  server: async (input, rawOptions) => {
    const fixture = fixtureOptions.parse(rawOptions);
    const options = parseOptions(fixture.router);
    const hooks = createHooks(createHost(input, options), options, createDecider(fixture.endpoint));
    return {
      ...hooks,
      "chat.message": async (request, output) => {
        const inspected = inspectMessage(output.parts);
        const before = output.message.model;
        await hooks["chat.message"]?.(request, output);
        await appendFile(
          join(input.directory, "hook-trace.jsonl"),
          `${JSON.stringify({
            agent: output.message.agent,
            sessionID: request.sessionID,
            before,
            after: output.message.model,
            synthetic: inspected.synthetic,
            retry: inspected.retry,
            promptLength: inspected.prompt.length,
            parts: output.parts.map((part) =>
              part.type === "text"
                ? {
                    type: part.type,
                    synthetic: part.synthetic,
                    internal: part.text.includes("OMO_INTERNAL_INITIATOR"),
                  }
                : { type: part.type },
            ),
          })}\n`,
        );
      },
    };
  },
} satisfies PluginModule;
