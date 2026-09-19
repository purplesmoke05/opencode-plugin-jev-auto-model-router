import type { PluginModule } from "@opencode-ai/plugin";
import { z } from "zod";
import { parseOptions } from "../../src/config.js";
import { createHooks } from "../../src/hooks.js";
import { createHost } from "../../src/host.js";
import { createDecider } from "../../src/jev.js";

const fixtureOptions = z.object({
  endpoint: z.url().refine((value) => new URL(value).hostname === "127.0.0.1"),
  router: z.unknown(),
});

export default {
  id: "jev-auto-e2e",
  server: async (input, rawOptions) => {
    const fixture = fixtureOptions.parse(rawOptions);
    const options = parseOptions(fixture.router);
    return createHooks(createHost(input, options), options, createDecider(fixture.endpoint));
  },
} satisfies PluginModule;
