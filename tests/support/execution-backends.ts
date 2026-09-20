import { z } from "zod";
import { ExecutionSignals } from "./execution-signals.js";

const completion = z.object({
  model: z.enum(["deepseek", "other"]),
  stream: z.literal(true),
  reasoning_effort: z.string().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
  tools: z
    .array(z.object({ type: z.string(), function: z.object({ name: z.string() }) }))
    .optional(),
});
export const executionNotice = z.object({
  sessionID: z.string(),
  action: z.enum(["retry", "recovered", "exhausted", "stopped"]),
  reason: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.number().optional(),
  retryAfter: z.string().optional(),
});
type Completion = z.infer<typeof completion> & { readonly provider: string };

export function executionBackends() {
  const requests = new ExecutionSignals<Completion>();
  const notices = new ExecutionSignals<z.infer<typeof executionNotice>>();
  const timeline: string[] = [];
  const rejected: string[] = [];
  const unattributed: string[] = [];
  const behavior = { exhaust: false, hold: false, holdSuccess: false };
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 120,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (
        path === "/" &&
        (request.method === "GET" || request.method === "HEAD") &&
        !request.headers.has("authorization")
      ) {
        unattributed.push(`${request.method} ${path}`);
        return new Response(null, { status: 403 });
      }
      if (
        request.method !== "POST" ||
        request.headers.get("authorization") !== "Bearer e2e-dummy"
      ) {
        rejected.push(`${request.method} ${path}`);
        return new Response(null, { status: 403 });
      }
      if (path === "/notice") {
        const notice = executionNotice.parse(await request.json());
        timeline.push(`notice:${notice.action}`);
        notices.push(notice);
        return new Response(null, { status: 204 });
      }
      const provider = /^\/(a|b|c)\/v1\/chat\/completions$/.exec(path)?.[1];
      if (!provider) {
        rejected.push(path);
        return new Response(null, { status: 404 });
      }
      const body = completion.parse(await request.json());
      timeline.push(`request:${provider}/${body.model}`);
      requests.push({ ...body, provider });
      if (behavior.hold || (behavior.holdSuccess && provider === "c")) await release.promise;
      if (provider !== "c" || behavior.exhaust) {
        return Response.json(
          { error: { message: "fixture unavailable", type: "server_error" } },
          {
            status: provider === "a" ? 429 : 503,
            headers: { "Retry-After": "0.01" },
          },
        );
      }
      const envelope = {
        id: `fixture-${requests.values.length}`,
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
      };
      const chunks = [
        {
          ...envelope,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "fixture:recovered" },
              finish_reason: null,
            },
          ],
        },
        {
          ...envelope,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ];
      timeline.push(`success:${provider}/${body.model}`);
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        },
      );
    },
    error(error) {
      rejected.push(error.message);
      return new Response(null, { status: 400 });
    },
  });
  return {
    url: server.url,
    requests,
    notices,
    timeline,
    rejected,
    unattributed,
    behavior,
    releaseResponse: () => release.resolve(),
    async [Symbol.asyncDispose]() {
      release.resolve();
      await server.stop(true);
    },
  };
}
