import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { buildTaskContext } from "../src/context.js";
import type { ContextOptions } from "../src/contracts.js";

const options = { enabled: true, maxCharacters: 4096 } satisfies ContextOptions;
const text = (value: string) => ({ type: "text", text: value });
const assistant = (value: string, created?: number) => ({
  info: { role: "assistant", ...(created === undefined ? {} : { time: { created } }) },
  parts: [text(value)],
});
const current = { info: { role: "user", id: "current" }, parts: [text("USER_CURRENT")] };

describe("buildTaskContext", () => {
  test("returns only the latest visible reply when history includes users and older replies", () => {
    const history = [
      { info: { role: "user" }, parts: [text("USER_ORIGIN")] },
      assistant("OLDER"),
      assistant("LATEST"),
      current,
    ];

    const context = buildTaskContext(history, { ...options, currentMessageID: "current" });

    expect(context).toEqual({ previous_assistant: "LATEST", truncated: false });
  });

  test.each([false, true])("excludes private and injected parts when childTask=%s", (childTask) => {
    const history = [
      {
        info: { role: "assistant", providerID: "PRIVATE", modelID: "PRIVATE" },
        parts: [
          text("FIRST"),
          { type: "reasoning", text: "PRIVATE" },
          { type: "file", url: "PRIVATE" },
          { type: "tool", tool: "read", state: { status: "completed", output: "PRIVATE" } },
          { ...text("PRIVATE"), synthetic: true },
          { ...text("PRIVATE"), ignored: true },
          { ...text("PRIVATE"), injected: true },
          text("PRIVATE <!-- OMO_INTERNAL_INITIATOR -->"),
          text("PRIVATE <!-- OMO_INTERNAL_NOREPLY -->"),
          text("SECOND"),
        ],
      },
    ];

    const context = buildTaskContext(history, { ...options, childTask });

    expect(context).toEqual({ previous_assistant: "FIRST\nSECOND", truncated: false });
  });

  test.each([true, { body: "PRIVATE" }])("skips summary-marked assistants (%j)", (summary) => {
    const history = [
      assistant("VISIBLE"),
      {
        info: { role: "assistant", summary },
        parts: [text("SUMMARY")],
      },
    ];

    const context = buildTaskContext(history, options);

    expect(context).toEqual({ previous_assistant: "VISIBLE", truncated: false });
  });

  test("skips textless steps when later assistants contain only hidden or blank parts", () => {
    const history = [
      assistant("VISIBLE"),
      {
        info: { role: "assistant" },
        parts: [{ type: "tool" }, { type: "reasoning", text: "PRIVATE" }],
      },
      assistant(" \n "),
      {
        info: { role: "assistant" },
        parts: [{ ...text("PRIVATE"), synthetic: true }],
      },
    ];

    const context = buildTaskContext(history, options);

    expect(context).toEqual({ previous_assistant: "VISIBLE", truncated: false });
  });

  test.each(["user", "assistant"])(
    "cuts off current and future messages when current is %s",
    (role) => {
      const history = [
        assistant("BEFORE"),
        { ...current, info: { ...current.info, role } },
        assistant("AFTER"),
      ];

      const context = buildTaskContext(history, { ...options, currentMessageID: "current" });

      expect(context).toEqual({ previous_assistant: "BEFORE", truncated: false });
    },
  );

  test("applies cutoff after chronological sorting when timestamps arrive out of order", () => {
    const history = [
      assistant("FUTURE", 30),
      {
        ...current,
        info: { ...current.info, time: { created: 20 } },
      },
      assistant("BEFORE", 10),
    ];
    const before = JSON.stringify(history);

    const context = buildTaskContext(history, { ...options, currentMessageID: "current" });

    expect(context).toEqual({ previous_assistant: "BEFORE", truncated: false });
    expect(JSON.stringify(history)).toBe(before);
  });

  test.each([
    [assistant("LATEST", 30), assistant("EARLIER", 10)],
    [assistant("EARLIER", 10), assistant("LATEST", 10)],
    [assistant("EARLIER"), assistant("LATEST")],
    [assistant("LATEST", 30), assistant("UNDATED"), assistant("EARLIER", 10)],
  ])("selects latest by stable timestamp ordering or array order (%j)", (...history) => {
    const context = buildTaskContext(history, options);

    expect(context).toEqual({ previous_assistant: "LATEST", truncated: false });
  });

  test("uses available history when the current ID is not present", () => {
    const history = [assistant("VISIBLE")];

    const context = buildTaskContext(history, { ...options, currentMessageID: "absent" });

    expect(context).toEqual({ previous_assistant: "VISIBLE", truncated: false });
  });

  test.each([
    [],
    [current],
    [{ info: { role: "assistant", summary: true }, parts: [text("SUMMARY")] }],
  ])("returns empty context when no eligible reply exists (%j)", (...history) => {
    const context = buildTaskContext(history, options);

    expect(context).toEqual({ truncated: false });
  });

  test("does not parse history when disabled", () => {
    const context = buildTaskContext(null, { ...options, enabled: false });

    expect(context).toEqual({ truncated: false });
  });

  test("rejects invalid history at the Zod boundary when enabled", () => {
    const history = [{ info: { role: "assistant" }, parts: [{ type: "text", text: 7 }] }];

    const run = () => buildTaskContext(history, options);

    expect(run).toThrow(ZodError);
  });
});
