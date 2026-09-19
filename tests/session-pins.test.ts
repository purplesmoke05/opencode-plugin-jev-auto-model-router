import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionPin, SessionPins } from "../src/contracts.js";
import {
  createMemorySessionPins,
  createSessionPins,
  SessionPinError,
} from "../src/session-pins.js";

const roots: string[] = [];
const first: SessionPin = { model: "provider/first", variant: "high", reason: "jev" };
const recovery: SessionPin = { model: "other/recovery", reason: "omo-recovery", recovery: true };

async function directory() {
  const root = await mkdtemp("/tmp/opencode/session-pins-");
  roots.push(root);
  return join(root, "pins");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

for (const [name, factory] of [
  ["memory", async () => createMemorySessionPins()],
  ["persistent", async () => createSessionPins(await directory())],
] satisfies readonly (readonly [string, () => Promise<SessionPins>])[]) {
  describe(name, () => {
    test("returns undefined when the session is missing", async () => {
      const store = await factory();
      expect(await store.load("session")).toBeUndefined();
    });

    test("returns the first pin when competing claims arrive", async () => {
      const store = await factory();
      await store.claim("session", first);
      const winner = await store.claim("session", recovery);
      expect(winner).toEqual(first);
    });

    test("elects one winner when claims run concurrently", async () => {
      const store = await factory();
      const results = await Promise.all([
        store.claim("session", first),
        store.claim("session", recovery),
      ]);
      expect(results[0]).toEqual(results[1]);
    });

    test("creates a recovery pin when replacing a missing session", async () => {
      const store = await factory();
      await store.replace("session", recovery);
      expect(await store.load("session")).toEqual(recovery);
    });

    test("isolates pins when sessions differ", async () => {
      const store = await factory();
      await store.claim("session", first);
      await store.claim("ses_child-1", recovery);
      expect(await store.load("session")).toEqual(first);
      expect(await store.load("ses_child-1")).toEqual(recovery);
    });

    test("updates the pin when runtime recovery replaces it", async () => {
      const store = await factory();
      await store.claim("session", first);
      await store.replace("session", recovery);
      expect(await store.claim("session", first)).toEqual(recovery);
    });

    test("removes only its session when forgotten twice", async () => {
      const store = await factory();
      await store.claim("session", first);
      await store.claim("ses_child", recovery);
      await store.forget("session");
      await store.forget("session");
      expect(await store.load("session")).toBeUndefined();
      expect(await store.load("ses_child")).toEqual(recovery);
    });

    test.each([
      "",
      "../escape",
      "/absolute",
      "a/b",
      "a\\b",
      ".",
      "..",
      "a\0b",
      "a\nb",
      "session\n",
    ])("rejects unsafe session ID %j on every operation", async (sessionID) => {
      const store = await factory();
      await expect(store.load(sessionID)).rejects.toBeInstanceOf(SessionPinError);
      await expect(store.claim(sessionID, first)).rejects.toBeInstanceOf(SessionPinError);
      await expect(store.replace(sessionID, first)).rejects.toBeInstanceOf(SessionPinError);
      await expect(store.forget(sessionID)).rejects.toBeInstanceOf(SessionPinError);
    });

    test.each([
      "auto",
      "provider/",
      "/model",
      "provider/bad model",
      "provider/model\n",
      "jev-router/auto",
      "jev-router/other",
    ])("rejects invalid or recursive model %j", async (model) => {
      const store = await factory();
      await expect(store.claim("session", { ...first, model })).rejects.toBeInstanceOf(
        SessionPinError,
      );
    });

    test("stores a snapshot when the caller mutates its input", async () => {
      const store = await factory();
      const input = { ...first };
      await store.claim("session", input);
      input.model = recovery.model;
      expect(await store.load("session")).toEqual(first);
    });
  });
}

describe("persistent publication", () => {
  test("reopens complete pins with restrictive permissions and no temporary files", async () => {
    const path = await directory();
    await createSessionPins(path).claim("session", first);
    expect(await createSessionPins(path).load("session")).toEqual(first);
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect((await stat(join(path, "session.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(path)).toEqual(["session.json"]);
  });

  test("elects one complete winner across concurrent independent instances", async () => {
    const path = await directory();
    const results = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        createSessionPins(path).claim("session", {
          model: `provider/model-${index}`,
          reason: "jev",
        }),
      ),
    );
    expect(new Set(results.map((pin) => pin.model)).size).toBe(1);
    expect(await createSessionPins(path).load("session")).toEqual(results[0]);
    expect(await readdir(path)).toEqual(["session.json"]);
  });

  test("exposes only complete pins while independent replacements and reads race", async () => {
    const path = await directory();
    const store = createSessionPins(path);
    await store.claim("session", first);
    const snapshots = await Promise.all(
      Array.from({ length: 32 }, async () => {
        await createSessionPins(path).replace("session", recovery);
        return store.load("session");
      }),
    );
    expect(snapshots).toEqual(Array.from({ length: 32 }, () => recovery));
    expect(await readdir(path)).toEqual(["session.json"]);
  });

  test("persists only structural pin fields when input has extra properties", async () => {
    const path = await directory();
    const input = { ...first, prompt: "private-prompt", apiKey: "private-key" };
    await createSessionPins(path).claim("session", input);
    expect(JSON.parse(await readFile(join(path, "session.json"), "utf8"))).toEqual({
      version: 1,
      sessionID: "session",
      ...first,
    });
  });

  test("accepts optional metadata when reopening a minimal record", async () => {
    const path = await directory();
    await mkdir(path);
    await writeFile(
      join(path, "session.json"),
      JSON.stringify({ version: 1, sessionID: "session", model: first.model }),
    );
    expect(await createSessionPins(path).load("session")).toEqual({
      model: first.model,
      reason: "sticky",
    });
  });

  test.each([
    "{broken-secret",
    JSON.stringify({ version: 2, sessionID: "session", ...first }),
    JSON.stringify({ version: 1, sessionID: "ses_other", ...first }),
    JSON.stringify({ version: 1, sessionID: "session", ...first, model: "jev-router/auto" }),
    JSON.stringify({ version: 1, sessionID: "session", ...first, recovery: "yes" }),
  ])(
    "blocks corrupt records without overwriting or leaking their content (%#)",
    async (content) => {
      const path = await directory();
      await mkdir(path);
      await writeFile(join(path, "session.json"), content);
      const store = createSessionPins(path);
      await expect(store.load("session")).rejects.toBeInstanceOf(SessionPinError);
      await expect(store.claim("session", recovery)).rejects.toMatchObject({
        code: "corrupt-pin",
        message: "Session pin storage: corrupt-pin",
      });
      expect(await readFile(join(path, "session.json"), "utf8")).toBe(content);
      expect(await readdir(path)).toEqual(["session.json"]);
    },
  );

  test("surfaces a non-directory store instead of treating it as missing", async () => {
    const path = await directory();
    await writeFile(path, "not-a-directory");
    const store = createSessionPins(path);
    await expect(store.load("session")).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(store.claim("session", first)).rejects.toBeInstanceOf(Error);
    await expect(store.replace("session", first)).rejects.toBeInstanceOf(Error);
    await expect(store.forget("session")).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  test("surfaces filesystem failures and cleans only owned temporary files", async () => {
    const path = await directory();
    await mkdir(join(path, "session.json"), { recursive: true });
    await writeFile(join(path, "unrelated.tmp"), "owned-by-another-writer");
    const store = createSessionPins(path);
    await expect(store.load("session")).rejects.toMatchObject({ code: "EISDIR" });
    await expect(store.claim("session", first)).rejects.toMatchObject({ code: "EISDIR" });
    await expect(store.replace("session", first)).rejects.toMatchObject({ code: "EISDIR" });
    await expect(store.forget("session")).rejects.toBeInstanceOf(Error);
    expect((await readdir(path)).sort()).toEqual(["session.json", "unrelated.tmp"]);
  });
});
