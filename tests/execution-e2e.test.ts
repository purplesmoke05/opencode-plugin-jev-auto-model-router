import { describe, expect, test } from "bun:test";
import { executionBackends } from "./support/execution-backends.js";
import { executionOpenCode, executionRequest } from "./support/execution-opencode.js";

describe.skipIf(process.env["OPENCODE_E2E"] !== "1")(
  "execution fallback in OpenCode 1.18.31",
  () => {
    test("recovers a then b API failures on c with one synthetic turn per switch", async () => {
      // Given
      await using backend = executionBackends();
      backend.behavior.holdSuccess = true;
      await using server = await executionOpenCode(backend.url);
      const sessionID = await server.session();
      // When
      await server.prompt(sessionID);
      await backend.requests.waitFor((request) => request.provider === "c");
      expect(backend.notices.values.some((notice) => notice.action === "recovered")).toBe(false);
      backend.releaseResponse();
      await backend.notices.waitFor(
        (notice) => notice.sessionID === sessionID && notice.action === "recovered",
      );
      // Then
      const requests = backend.requests.values;
      const switches = requests
        .map((request) => request.provider)
        .filter((provider, index, providers) => provider !== providers[index - 1]);
      expect(switches).toEqual(["a", "b", "c"]);
      const history = await server.history(sessionID);
      const users = history.filter((message) => message.info.role === "user");
      expect(users.map((message) => message.info.model?.providerID)).toEqual(["a", "b", "c"]);
      expect(new Set(users.map((message) => message.info.id)).size).toBe(3);
      expect(
        users
          .slice(1)
          .map(
            (message) =>
              message.parts.filter((part) => part.type === "text" && part.synthetic).length,
          ),
      ).toEqual([1, 1]);
      for (const user of users) {
        expect(user.info.agent).toBe(executionRequest.agent);
        expect(user.info.model?.variant).toBe("max");
        expect(user.info.tools).toEqual(executionRequest.tools);
        expect(user.info.system).toBe(executionRequest.system);
      }
      const initialTools = requests[0]?.tools;
      expect(initialTools?.some((tool) => tool.function.name === "read")).toBe(true);
      expect(initialTools?.some((tool) => tool.function.name === "bash")).toBe(false);
      for (const request of requests) {
        expect(
          request.messages.some(
            (message) =>
              message.role === "system" &&
              typeof message.content === "string" &&
              message.content.endsWith(executionRequest.system),
          ),
        ).toBe(true);
        expect(request.tools).toEqual(initialTools);
      }
      expect(
        history
          .filter((message) => message.info.role === "assistant")
          .map((message) => message.info.providerID),
      ).toEqual(["a", "b", "c"]);
      expect(history.at(-1)?.info.finish).toBe("stop");
      expect(history.at(-1)?.parts.some((part) => part.text === "fixture:recovered")).toBe(true);
      expect(backend.notices.values.map((notice) => notice.action)).toEqual([
        "retry",
        "retry",
        "recovered",
      ]);
      expect(backend.timeline.indexOf("notice:recovered")).toBeGreaterThan(
        backend.timeline.indexOf("success:c/deepseek"),
      );
      expect(
        server.events.values.filter(
          (event) => event.type === "session.error" && event.properties.sessionID === sessionID,
        ),
      ).toHaveLength(2);
      expect(backend.rejected).toEqual([]);
      expect(
        requests.map((request) => ({
          provider: request.provider,
          model: request.model,
          effort: request.reasoning_effort,
        })),
      ).toEqual(
        requests.map((request) => ({
          provider: request.provider,
          model: "deepseek",
          effort: "max",
        })),
      );
    }, 90_000);

    test("exhausts a finite chain without wrapping to an earlier provider", async () => {
      // Given
      await using backend = executionBackends();
      backend.behavior.exhaust = true;
      await using server = await executionOpenCode(backend.url);
      const sessionID = await server.session();
      // When
      await server.prompt(sessionID);
      await backend.notices.waitFor(
        (notice) => notice.sessionID === sessionID && notice.action === "exhausted",
      );
      // Then
      const providers = backend.requests.values.map((request) => request.provider);
      expect(providers.filter((provider, index) => provider !== providers[index - 1])).toEqual([
        "a",
        "b",
        "c",
      ]);
      const history = await server.history(sessionID);
      expect(history.filter((message) => message.info.role === "user")).toHaveLength(3);
      expect(history.at(-1)?.info.error?.name).toBe("APIError");
      expect(backend.notices.values.map((notice) => notice.action)).toEqual([
        "retry",
        "retry",
        "exhausted",
      ]);
      expect(
        server.events.values.filter(
          (event) => event.type === "session.error" && event.properties.sessionID === sessionID,
        ),
      ).toHaveLength(3);
      expect(backend.rejected).toEqual([]);
    }, 90_000);

    test("leaves an unconfigured a/other API failure on its original model", async () => {
      // Given
      await using backend = executionBackends();
      await using server = await executionOpenCode(backend.url);
      const sessionID = await server.session();
      // When
      await server.prompt(sessionID, "other");
      await server.events.waitFor(
        (event) => event.type === "session.error" && event.properties.sessionID === sessionID,
      );
      await server.events.waitFor(
        (event) => event.type === "session.idle" && event.properties.sessionID === sessionID,
      );
      // Then
      expect(backend.requests.values.length).toBeGreaterThan(0);
      expect(
        backend.requests.values.every(
          (request) => request.provider === "a" && request.model === "other",
        ),
      ).toBe(true);
      const history = await server.history(sessionID);
      expect(history.filter((message) => message.info.role === "user")).toHaveLength(1);
      expect(history.at(-1)?.info.error?.name).toBe("APIError");
      expect(
        backend.notices.values.some(
          (notice) => notice.action === "retry" || notice.action === "recovered",
        ),
      ).toBe(false);
      expect(backend.rejected).toEqual([]);
    }, 90_000);

    test("does not turn a user abort into a provider switch", async () => {
      // Given
      await using backend = executionBackends();
      backend.behavior.hold = true;
      await using server = await executionOpenCode(backend.url);
      const sessionID = await server.session();
      await server.prompt(sessionID);
      await backend.requests.waitFor((request) => request.provider === "a");
      // When
      await server.api.post(`session/${sessionID}/abort`);
      await server.events.waitFor(
        (event) => event.type === "session.idle" && event.properties.sessionID === sessionID,
      );
      // Then
      const history = await server.history(sessionID);
      expect(history.filter((message) => message.info.role === "user")).toHaveLength(1);
      expect(history.at(-1)?.info.error?.name).toBe("MessageAbortedError");
      expect(backend.requests.values.map((request) => request.provider)).toEqual(["a"]);
      expect(
        backend.notices.values.some(
          (notice) => notice.action === "retry" || notice.action === "recovered",
        ),
      ).toBe(false);
      expect(backend.rejected).toEqual([]);
    }, 90_000);
  },
);
