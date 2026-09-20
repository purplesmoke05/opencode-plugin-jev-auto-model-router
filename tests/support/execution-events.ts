import type { KyInstance } from "ky";
import { z } from "zod";
import { ExecutionHarnessError, ExecutionSignals } from "./execution-signals.js";

const eventSchema = z.object({
  type: z.string(),
  properties: z
    .object({
      sessionID: z.string().optional(),
      error: z.object({ name: z.string() }).optional(),
      info: z
        .object({
          sessionID: z.string().optional(),
          role: z.string().optional(),
          finish: z.string().optional(),
        })
        .optional(),
    })
    .passthrough(),
});

export async function executionEvents(api: KyInstance) {
  const events = new ExecutionSignals<z.infer<typeof eventSchema>>();
  const controller = new AbortController();
  const response = await api.get("event", { signal: controller.signal, timeout: false });
  if (!response.body) throw new ExecutionHarnessError("Missing OpenCode event stream");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let failure: Error | undefined;
  const pump = (async () => {
    let pending = "";
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      pending += result.value;
      let boundary = pending.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (data) events.push(eventSchema.parse(JSON.parse(data)));
        boundary = pending.indexOf("\n\n");
      }
    }
  })().catch((error: unknown) => {
    if (!(error instanceof Error)) throw error;
    if (!controller.signal.aborted) failure = error;
  });
  return {
    events,
    async [Symbol.asyncDispose]() {
      await reader.cancel();
      controller.abort();
      await pump;
      if (failure) throw failure;
    },
  };
}
