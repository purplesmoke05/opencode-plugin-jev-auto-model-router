import { expect, test } from "bun:test";
import { buildTaskContext } from "../src/context.js";

const options = { enabled: true, maxCharacters: 1024 } as const;
const assistant = (text: string) => ({
  info: { role: "assistant" },
  parts: [{ type: "text", text }],
});

test.each(["x", '"\\\n\u0000', "\ud800", "\u{1f680}"])(
  "bounds the complete serialized object when reply text contains %j",
  (unit) => {
    const reply = unit.repeat(3000);

    const context = buildTaskContext([assistant(reply)], options);

    expect(JSON.stringify(context).length).toBeLessThanOrEqual(options.maxCharacters);
    expect(context.previous_assistant?.length).toBeGreaterThan(0);
    expect(reply.startsWith(context.previous_assistant ?? "")).toBe(true);
    expect(context.truncated).toBe(true);
  },
);

test.each([0, 1, 2])("fits exact JSON boundary with %i extra characters", (extra) => {
  const reply = '"\\\n\u{1f680}';
  const complete = { previous_assistant: reply, truncated: false };
  const maxCharacters = JSON.stringify(complete).length + extra;

  const context = buildTaskContext([assistant(reply)], { ...options, maxCharacters });

  expect(context).toEqual(complete);
});

test("marks truncation when the complete reply exceeds the budget by one character", () => {
  const reply = "a".repeat(2000);
  const maxCharacters = JSON.stringify({ previous_assistant: reply, truncated: false }).length - 1;

  const context = buildTaskContext([assistant(reply)], { ...options, maxCharacters });

  expect(JSON.stringify(context).length).toBeLessThanOrEqual(maxCharacters);
  expect(context.previous_assistant).toBe(reply.slice(0, -1));
  expect(context.truncated).toBe(true);
});

test.each([0, 1, 2, 3])("keeps surrogate pairs intact at clipping boundary %i", (extra) => {
  const maxCharacters = JSON.stringify({ previous_assistant: "", truncated: true }).length + extra;

  const context = buildTaskContext([assistant("\u{1f680}".repeat(100))], {
    ...options,
    maxCharacters,
  });

  expect(context.previous_assistant).toBe("\u{1f680}".repeat(Math.floor(extra / 2)));
  expect(context.previous_assistant?.isWellFormed()).toBe(true);
  expect(JSON.stringify(context).length).toBeLessThanOrEqual(maxCharacters);
  expect(context.truncated).toBe(true);
});

test("does not substitute an older short reply when the latest reply needs clipping", () => {
  const history = [assistant("OLD"), assistant("NEW".repeat(3000))];

  const context = buildTaskContext(history, options);

  expect(context.previous_assistant).toStartWith("NEW");
  expect(context.truncated).toBe(true);
});

test("does not count excluded history or model metadata as truncation", () => {
  const history = [
    assistant("OLD".repeat(3000)),
    {
      ...assistant("LATEST"),
      info: { role: "assistant", providerID: "p".repeat(5000), modelID: "m".repeat(5000) },
    },
  ];

  const context = buildTaskContext(history, options);

  expect(context).toEqual({ previous_assistant: "LATEST", truncated: false });
});
