import { startBackends } from "../tests/support/backends.js";
import { isolatedOpenCode } from "../tests/support/opencode.js";

await using backend = startBackends();
backend.behavior.rateLimited = process.argv.includes("--fallback");
backend.behavior.rateLimitAfterFirst = process.argv.includes("--second-fallback");
await using cli = await isolatedOpenCode(backend.url);
const child = Bun.spawn(
  [process.env["OPENCODE_E2E_BINARY"] ?? "opencode", "-m", "jev-router/auto"],
  {
    cwd: cli.cwd,
    env: {
      ...cli.env,
      NO_COLOR: "",
      FORCE_COLOR: "1",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.on("SIGTERM", () => child.kill());
try {
  process.exitCode = await child.exited;
} finally {
  child.kill();
  await child.exited;
}
