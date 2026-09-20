import { describe, expect, test } from "bun:test";
import type { ExecutionHost, ExecutionSnapshot } from "../src/contracts.js";
import { fixture, snapshot } from "./support/execution-fixture.js";

describe("execution safety", () => {
  test.each([
    { model: "openai/gpt-unconfigured" },
    { retryable: false },
    { blocked: true },
    { idle: false },
    { complete: false },
    { failed: false },
    { userID: "stale" },
    { sessionID: "other" },
  ])("does not dispatch for an ineligible snapshot %j", async (patch) => {
    const given = fixture();
    given.state.snapshot = snapshot(patch);
    const controller = given.create();

    controller.failure("session");
    await controller.idle("session");

    expect(given.dispatched).toEqual([]);
    expect(given.recovered).toEqual([]);
    if (patch.model) expect(given.notices).toEqual([]);
  });

  test("reports nonretryable status without inventing a wait", async () => {
    const given = fixture();
    given.state.snapshot = snapshot({
      retryable: false,
      status: 401,
      retryAfter: "Wed, 01 Jan 2030 00:00:00 GMT",
    });
    const controller = given.create();

    controller.failure("session");
    await controller.idle("session");

    expect(given.dispatched).toEqual([]);
    expect(given.notices).toMatchObject([
      { action: "stopped", status: 401, retryAfter: given.state.snapshot.retryAfter },
    ]);
  });

  test.each(["begin", "stop", "forget", "dispose"] as const)(
    "invalidates an in-flight inspection on %s",
    async (operation) => {
      const given = fixture();
      const entered = Promise.withResolvers<void>();
      const inspection = Promise.withResolvers<ExecutionSnapshot>();
      const controller = given.create({
        inspect: () => {
          entered.resolve();
          return inspection.promise;
        },
      });
      controller.failure("session");
      const idle = controller.idle("session");
      await entered.promise;

      switch (operation) {
        case "begin":
          controller.begin("session", "new-user");
          break;
        case "stop":
          controller.stop("session");
          break;
        case "forget":
          controller.forget("session");
          break;
        case "dispose":
          controller.dispose();
          break;
        default: {
          const exhaustive: never = operation;
          return exhaustive;
        }
      }
      inspection.resolve(snapshot());
      await idle;

      expect(given.dispatched).toEqual([]);
      expect(given.notices).toEqual([]);
    },
  );

  test.each([
    { userID: "new-user" },
    { assistantID: "new-assistant" },
    { model: "p/C" },
    { idle: false },
    { blocked: true },
    { failed: false },
    { retryable: false },
    { complete: false },
  ])("re-inspects before dispatch and rejects changed snapshot %j", async (patch) => {
    const given = fixture();
    let inspections = 0;
    const controller = given.create({
      inspect: async () => (++inspections === 1 ? snapshot() : snapshot(patch)),
    });

    controller.failure("session");
    await controller.idle("session");

    expect(inspections).toBe(2);
    expect(given.dispatched).toEqual([]);
  });

  test("rejects wrong token or variant without consuming the valid retry", async () => {
    const given = fixture();
    const controller = given.create();
    controller.failure("session");
    await controller.idle("session");
    const request = given.dispatched[0];
    if (!request) throw new Error("Missing dispatch");

    expect(controller.acceptRetry("session", "wrong", "retry", request.target)).toBe(false);
    expect(controller.acceptRetry("session", request.token, "retry", { model: "p/B" })).toBe(false);
    expect(controller.acceptRetry("session", request.token, "retry", { model: "p/C" })).toBe(false);

    given.accept(controller);
    expect(controller.acceptRetry("session", request.token, "retry", request.target)).toBe(false);
  });

  test.each(["begin", "stop"] as const)(
    "rejects a previously issued token after %s",
    async (operation) => {
      const given = fixture();
      const controller = given.create();
      controller.failure("session");
      await controller.idle("session");
      const request = given.dispatched[0];
      if (!request) throw new Error("Missing dispatch");

      if (operation === "begin") controller.begin("session", "new-user");
      else controller.stop("session");

      expect(controller.acceptRetry("session", request.token, "retry", request.target)).toBe(false);
    },
  );

  test.each([{ userID: "other" }, { model: "p/C" }, { blocked: true }])(
    "does not pin a success for a mismatching recovery %j",
    async (patch) => {
      const given = fixture();
      const controller = given.create();
      controller.failure("session");
      await controller.idle("session");
      given.accept(controller);
      given.state.snapshot = { ...given.state.snapshot, failed: false, ...patch };

      await controller.idle("session");

      expect(given.recovered).toEqual([]);
    },
  );

  test.each(["inspect", "models", "dispatch", "report", "recovered"] as const)(
    "stops and sanitizes a host %s error",
    async (operation) => {
      const given = fixture();
      const overrides: Partial<ExecutionHost> =
        operation === "report"
          ? {
              report: async (_id, notice) => {
                if (notice.action !== "stopped") throw new Error("secret-token");
                given.notices.push(notice);
              },
            }
          : {
              [operation]: async () => {
                throw new Error("secret-token\nprivate prompt");
              },
            };
      const controller = given.create(overrides);
      controller.failure("session");
      await controller.idle("session");
      if (operation === "recovered") {
        given.accept(controller);
        given.state.snapshot = { ...given.state.snapshot, failed: false };
      }

      await controller.idle("session");
      controller.failure("session");
      await controller.idle("session");

      expect(given.notices.at(-1)).toMatchObject({ action: "stopped" });
      expect(JSON.stringify(given.notices)).not.toContain("secret-token");
      expect(JSON.stringify(given.notices)).not.toContain("private prompt");
      expect(given.dispatched.length).toBeLessThanOrEqual(1);
    },
  );

  test("stops during a pending catalog lookup without dispatching", async () => {
    const given = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = given.create({
      models: async () => {
        entered.resolve();
        await release.promise;
        return given.state.models;
      },
    });
    controller.failure("session");
    const idle = controller.idle("session");
    await entered.promise;

    controller.stop("session");
    release.resolve();
    await idle;

    expect(given.dispatched).toEqual([]);
  });
});
