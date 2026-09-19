import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { parseOptions } from "./config.js";
import { createHooks } from "./hooks.js";
import { createHost } from "./host.js";
import { createDecider } from "./jev.js";

const server: Plugin = async (input, rawOptions) => {
  const options = parseOptions(rawOptions);
  return createHooks(createHost(input, options), options, createDecider());
};

export default { id: "jev-auto-model-router", server } satisfies PluginModule;
