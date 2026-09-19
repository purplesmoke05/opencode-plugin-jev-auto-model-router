import ky from "ky";
import { z } from "zod";
import type { Decide } from "./contracts.js";

const probability = z.number().min(0).max(1);
const responseSchema = z.object({
  answers: z.object({
    route: z.object({
      type: z.literal("choice"),
      choice: z.string(),
      confidence: probability,
      probabilities: z.record(z.string(), probability),
    }),
  }),
});

export function createDecider(endpoint = "https://api.typesafe.ai/v1/systemone"): Decide {
  return async (request) => {
    const candidates = new Map(
      request.candidates.map((candidate, index) => [`c${index}`, candidate.model]),
    );
    const criteria = Object.fromEntries(
      request.candidates.map((candidate, index) => [
        `c${index}`,
        `${candidate.model}: ${candidate.description}`,
      ]),
    );
    const timeoutMs = Number.isFinite(request.timeoutMs)
      ? Math.max(1, Math.min(60_000, Math.trunc(request.timeoutMs)))
      : 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await ky.post(endpoint, {
        headers: { Authorization: `Bearer ${request.apiKey}` },
        json: {
          model: "jev-latest",
          state: request.prompt,
          questions: {
            route: {
              type: "choice",
              instructions: "Choose the model best suited to the user's task using the criteria.",
              criteria,
            },
          },
        },
        retry: 0,
        redirect: "error",
        timeout: false,
        signal: controller.signal,
        throwHttpErrors: false,
      });
      if (!response.ok) {
        const retryAfter = response.headers
          .get("Retry-After")
          ?.replace(/\p{Cc}/gu, "")
          .trim()
          .slice(0, 128);
        return {
          kind: "unavailable",
          reason: "http-error",
          status: response.status,
          ...(retryAfter === undefined ? {} : { retryAfter }),
        };
      }

      const payload: unknown = await response.json();
      const answer = responseSchema.parse(payload).answers.route;
      const model = candidates.get(answer.choice);
      if (model === undefined) {
        return { kind: "unavailable", reason: "invalid-response" };
      }
      return { kind: "selected", model, confidence: answer.confidence };
    } catch (error) {
      if (controller.signal.aborted) {
        return { kind: "unavailable", reason: "timeout" };
      }
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        return { kind: "unavailable", reason: "invalid-response" };
      }
      if (error instanceof Error) {
        return { kind: "unavailable", reason: "network-error" };
      }
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
