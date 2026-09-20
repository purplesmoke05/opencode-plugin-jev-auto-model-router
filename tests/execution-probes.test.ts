import { expect, test } from "bun:test";
import { executionBackends } from "./support/execution-backends.js";

test("separates unauthenticated root probes without hiding authenticated misroutes", async () => {
  await using backend = executionBackends();
  const probe = await fetch(backend.url, { signal: AbortSignal.timeout(1000) });
  const mistaken = await fetch(backend.url, {
    headers: { Authorization: "Bearer e2e-dummy" },
    signal: AbortSignal.timeout(1000),
  });
  expect([probe.status, mistaken.status]).toEqual([403, 403]);
  expect(backend.unattributed).toEqual(["GET /"]);
  expect(backend.rejected).toEqual(["GET /"]);
});
