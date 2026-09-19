import { z } from "zod";

const classification = z.object({
  model: z.literal("jev-latest"),
  state: z.string(),
  questions: z.object({
    route: z.object({ type: z.literal("choice"), criteria: z.record(z.string(), z.string()) }),
  }),
});
const completion = z.object({
  model: z.enum(["fast", "strong"]),
  stream: z.literal(true),
  messages: z.array(z.object({ role: z.string() })),
});

export function startBackends() {
  const classifications: z.infer<typeof classification>[] = [];
  const completions: z.infer<typeof completion>[] = [];
  const rejected: string[] = [];
  const unattributed: string[] = [];
  const behavior = { rateLimited: false, rateLimitAfterFirst: false };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (
        !request.headers.has("authorization") &&
        (request.method === "GET" || request.method === "HEAD") &&
        pathname !== "/jev" &&
        pathname !== "/v1/chat/completions"
      ) {
        unattributed.push(`${request.method} ${pathname}`);
        return new Response(null, { status: 403 });
      }
      if (
        request.method !== "POST" ||
        request.headers.get("authorization") !== "Bearer e2e-dummy"
      ) {
        rejected.push(`${request.method} ${pathname}`);
        return new Response(null, { status: 403 });
      }
      switch (pathname) {
        case "/jev": {
          const payload: unknown = await request.json();
          classifications.push(classification.parse(payload));
          if (
            behavior.rateLimited ||
            (behavior.rateLimitAfterFirst && classifications.length > 1)
          ) {
            return Response.json(
              { error: "fixture rate limit" },
              {
                status: 429,
                headers: { "Retry-After": "120" },
              },
            );
          }
          return Response.json({
            answers: {
              route: {
                type: "choice",
                choice: "c0",
                confidence: 0.99,
                probabilities: { c0: 0.99, c1: 0.01 },
              },
            },
          });
        }
        case "/v1/chat/completions": {
          const payload: unknown = await request.json();
          const body = completion.parse(payload);
          completions.push(body);
          const envelope = {
            id: `chatcmpl-${completions.length}`,
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
                  delta: { role: "assistant", content: `fixture:${body.model}` },
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
          return new Response(
            `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
            {
              headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
            },
          );
        }
        default:
          rejected.push(`${request.method} ${pathname}`);
          return new Response(null, { status: 404 });
      }
    },
    error(error) {
      rejected.push(error.message);
      return new Response(null, { status: 400 });
    },
  });
  return {
    url: server.url,
    classifications,
    completions,
    rejected,
    unattributed,
    behavior,
    async [Symbol.asyncDispose]() {
      await server.stop(true);
    },
  };
}
