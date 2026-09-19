import { afterEach, describe, expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Server } from "bun";
import { parseOptions } from "../src/config.js";
import { createHost } from "../src/host.js";

const servers: Server<undefined>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});
const options = parseOptions({
  candidates: [{ model: "connected/m", description: "General" }],
  fallback: "connected/m",
});

function hostFor(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return createHost(
    { client: createOpencodeClient({ baseUrl: server.url.href }), directory: "/isolated" },
    options,
  );
}

describe("OpenCode SDK boundary", () => {
  test("does not round a sub-threshold confidence up to 99 percent", async () => {
    const bodies: unknown[] = [];
    const host = hostFor(async (request) => {
      bodies.push(await request.json());
      return Response.json(true);
    });
    await host.report("session", {
      kind: "route",
      model: "connected/m",
      reason: "jev",
      confidence: 0.989,
      pinned: false,
    });
    expect(bodies).toContainEqual({
      title: "Auto (Jev)",
      message: "connected/m\nJev confidence 98.9% · not pinned yet",
      variant: "info",
      duration: 6000,
    });
  });

  test("offers only connected provider models", async () => {
    // Given
    const host = hostFor(() =>
      Response.json({
        connected: ["connected"],
        all: ["connected", "disconnected"].map((id) => ({
          id,
          models: {
            m: { capabilities: { toolcall: true, input: { text: true, image: true, pdf: false } } },
          },
        })),
      }),
    );
    // When
    const models = await host.models();
    // Then
    expect(models).toEqual([
      { model: "connected/m", toolcall: true, modalities: ["text", "image"] },
    ]);
  });

  test("collects attachment requirements alongside bounded conversation context", async () => {
    // Given
    const host = hostFor((request) =>
      Response.json(
        new URL(request.url).pathname.endsWith("/message")
          ? [
              {
                info: { role: "user" },
                parts: [
                  { type: "file", mime: "image/png" },
                  { type: "text", text: "private" },
                ],
              },
              { info: { role: "user" }, parts: [{ type: "file", mime: "application/pdf" }] },
            ]
          : { parentID: "parent" },
      ),
    );
    // When
    const session = await host.session("session");
    // Then
    expect(session).toMatchObject({ child: true, modalities: ["image", "pdf"] });
  });

  test("reports only routing metadata and distinguishes missing Retry-After", async () => {
    // Given
    const bodies: unknown[] = [];
    const host = hostFor(async (request) => {
      bodies.push(await request.json());
      return Response.json(true);
    });
    // When
    await host.report("session", {
      kind: "route",
      model: "connected/m",
      reason: "http-error",
      status: 429,
    });
    // Then
    expect(bodies).toHaveLength(2);
    expect(bodies).toContainEqual({
      service: "jev-auto-model-router",
      level: "warn",
      message: "model route selected",
      extra: {
        sessionID: "session",
        mode: "auto",
        model: "connected/m",
        reason: "http-error",
        status: 429,
      },
    });
    expect(bodies).toContainEqual({
      title: "Auto (Jev)",
      message:
        "connected/m\nFallback: http-error\nHTTP 429 · Retry-After: not present · no automatic retry",
      variant: "warning",
      duration: 6000,
    });
  });

  test("does not fail an already selected route if notification services fail", async () => {
    // Given
    const host = hostFor(() => Response.json({ error: "unavailable" }, { status: 503 }));
    // When / Then
    await expect(
      host.report("session", { kind: "route", model: "connected/m", reason: "jev", confidence: 1 }),
    ).resolves.toBeUndefined();
  });

  test("blocks when scope cannot be verified", async () => {
    // Given
    const host = hostFor(() => Response.json({ error: "unavailable" }, { status: 503 }));
    // When / Then
    await expect(host.session("session")).rejects.toThrow("scope");
  });

  test("blocks malformed or legacy catalogs rather than assuming capabilities", async () => {
    const host = hostFor(() =>
      Response.json({
        connected: ["connected"],
        all: [{ id: "connected", models: { m: { tool_call: true } } }],
      }),
    );
    await expect(host.models()).rejects.toThrow("catalog");
  });
});
