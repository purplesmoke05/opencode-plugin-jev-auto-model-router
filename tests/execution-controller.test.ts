import { describe, expect, test } from "bun:test";
import { fixture, snapshot, targets } from "./support/execution-fixture.js";

describe("ordered execution recovery", () => {
  test("exhausts A to B to C once when every model fails", async () => {
    const given = fixture();
    const controller = given.create();
    controller.failure("session");
    await controller.idle("session");
    given.accept(controller, "retry-B");
    controller.failure("session");
    await controller.idle("session");
    given.accept(controller, "retry-C");

    controller.failure("session");
    await controller.idle("session");
    controller.failure("session");
    await controller.idle("session");

    expect(given.dispatched.map((request) => request.target)).toEqual(targets.slice(1));
    expect(given.notices.map((notice) => notice.action)).toEqual(["retry", "retry", "exhausted"]);
    expect(given.recovered).toEqual([]);
  });

  test("pins max only after an accepted retry succeeds at final idle", async () => {
    const given = fixture();
    const controller = given.create();
    controller.failure("session");
    await controller.idle("session");
    const request = given.accept(controller);
    expect(given.recovered).toEqual([]);
    given.state.snapshot = { ...given.state.snapshot, failed: false, complete: false };
    await controller.idle("session");
    expect(given.recovered).toEqual([]);
    given.state.snapshot = { ...given.state.snapshot, complete: true, idle: false };
    await controller.idle("session");
    expect(given.recovered).toEqual([]);

    given.state.snapshot = { ...given.state.snapshot, idle: true };
    await Promise.all([controller.idle("session"), controller.idle("session")]);

    expect(given.recovered).toEqual([{ model: "p/B", variant: "max" }]);
    expect(controller.acceptRetry("session", request.token, "other", request.target)).toBe(false);
    expect(given.notices.filter((notice) => notice.action === "recovered")).toHaveLength(1);
  });

  test("deduplicates concurrent errors and idles for the same assistant", async () => {
    const given = fixture();
    const controller = given.create();

    await Promise.all(
      Array.from({ length: 8 }, async () => {
        controller.failure("session");
        await controller.idle("session");
      }),
    );

    expect(given.dispatched).toHaveLength(1);
    expect(given.recovered).toEqual([]);
  });

  test("starts strictly after the actual failed model rather than the chain head", async () => {
    const given = fixture();
    given.state.snapshot = snapshot({ model: "p/B" });
    const controller = given.create();

    controller.failure("session");
    await controller.idle("session");

    expect(given.dispatched.map((request) => request.target.model)).toEqual(["p/C"]);
  });

  test.each(["missing", "tool-less", "incompatible", "variant-missing"])(
    "skips %s targets without downgrading their variant",
    async (condition) => {
      const given = fixture();
      given.state.models = given.state.models.flatMap((model) => {
        if (model.model !== "p/B") return [model];
        switch (condition) {
          case "missing":
            return [];
          case "tool-less":
            return [{ ...model, toolcall: false }];
          case "incompatible":
            return [{ ...model, modalities: ["image"] }];
          case "variant-missing":
            return [{ ...model, variants: [] }];
          default:
            throw new Error("Unknown fixture condition");
        }
      });
      const controller = given.create();

      controller.failure("session");
      await controller.idle("session");

      expect(given.dispatched.map((request) => request.target.model)).toEqual(["p/C"]);
    },
  );

  test("reports exhaustion without dispatch when no remaining target is eligible", async () => {
    const given = fixture();
    given.state.models = [];
    const controller = given.create();

    controller.failure("session");
    await controller.idle("session");

    expect(given.dispatched).toEqual([]);
    expect(given.notices).toMatchObject([{ action: "exhausted" }]);
  });

  test("preserves an early failure flag until complete idle", async () => {
    const given = fixture();
    given.state.snapshot = snapshot({
      idle: false,
      complete: false,
      status: 429,
      retryAfter: "120",
    });
    const controller = given.create();
    controller.failure("session");
    await controller.idle("session");
    expect(given.dispatched).toEqual([]);

    given.state.snapshot = { ...given.state.snapshot, idle: true, complete: true };
    await controller.idle("session");

    expect(given.notices).toMatchObject([{ action: "retry", status: 429, retryAfter: "120" }]);
    expect(given.dispatched[0]?.snapshot.requestOptions).toEqual({ tools: { edit: true } });
  });

  test("resets attempts only when a new ordinary prompt begins", async () => {
    const given = fixture();
    const controller = given.create();
    controller.failure("session");
    await controller.idle("session");
    controller.begin("session", "user");
    controller.failure("session");
    await controller.idle("session");
    expect(given.dispatched).toHaveLength(1);

    controller.begin("session", "new-user");
    given.state.snapshot = snapshot({ userID: "new-user", assistantID: "new-A" });
    controller.failure("session");
    await controller.idle("session");

    expect(given.dispatched.map((request) => request.target.model)).toEqual(["p/B", "p/B"]);
    expect(new Set(given.dispatched.map((request) => request.token)).size).toBe(2);
  });

  test("reserves the target before dispatch can synchronously accept the retry", async () => {
    const given = fixture();
    const controller = given.create({
      dispatch: async (failed, target, token) => {
        expect(controller.acceptRetry("session", token, "retry", target)).toBe(true);
        await given.host.dispatch(failed, target, token);
        given.state.snapshot = snapshot({ userID: "retry", model: target.model, assistantID: "B" });
        controller.failure("session");
      },
    });

    controller.failure("session");
    await controller.idle("session");
    await controller.idle("session");

    expect(given.dispatched.map((request) => request.target.model)).toEqual(["p/B", "p/C"]);
  });

  test("requires an observed failure and ignores unconfigured chains", async () => {
    const given = fixture([]);
    const controller = given.create();

    await controller.idle("session");
    controller.failure("session");
    await controller.idle("session");

    expect(given.dispatched).toEqual([]);
    expect(given.notices).toEqual([]);
  });

  test("serializes one session without blocking a different session", async () => {
    const given = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = given.create({
      inspect: async (sessionID) => {
        if (sessionID === "session") {
          entered.resolve();
          await release.promise;
        }
        return snapshot({ sessionID });
      },
    });
    controller.failure("session");
    const first = controller.idle("session");
    await entered.promise;
    const duplicate = controller.idle("session");

    controller.begin("independent", "user");
    controller.failure("independent");
    await controller.idle("independent");
    expect(given.dispatched.map((request) => request.snapshot.sessionID)).toEqual(["independent"]);
    release.resolve();
    await Promise.all([first, duplicate]);

    expect(given.dispatched.map((request) => request.snapshot.sessionID)).toEqual([
      "independent",
      "session",
    ]);
  });
});
