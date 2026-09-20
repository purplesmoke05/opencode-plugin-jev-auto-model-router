import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import ky from "ky";
import { z } from "zod";
import { executionEvents } from "./execution-events.js";
import { executionSandbox } from "./execution-sandbox.js";
import { ExecutionHarnessError } from "./execution-signals.js";

const historySchema = z.array(
  z.object({
    info: z.object({
      id: z.string(),
      role: z.enum(["user", "assistant"]),
      parentID: z.string().optional(),
      agent: z.string(),
      model: z
        .object({ providerID: z.string(), modelID: z.string(), variant: z.string().optional() })
        .optional(),
      providerID: z.string().optional(),
      modelID: z.string().optional(),
      variant: z.string().optional(),
      finish: z.string().optional(),
      tools: z.record(z.string(), z.boolean()).optional(),
      system: z.string().optional(),
      error: z.object({ name: z.string() }).optional(),
    }),
    parts: z.array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
        synthetic: z.boolean().optional(),
      }),
    ),
  }),
);

export const executionRequest = {
  agent: "build",
  variant: "max",
  system: "execution-system-fixture-42",
  tools: { read: true, bash: false, edit: false },
  parts: [{ type: "text", text: "Reply briefly without invoking tools." }],
} as const;

export async function executionOpenCode(endpoint: URL) {
  const sandbox = await executionSandbox(endpoint);
  const binary = process.env["OPENCODE_E2E_BINARY"] ?? "opencode";
  try {
    const version = await promisify(execFile)(binary, ["--version"], {
      cwd: sandbox.cwd,
      env: sandbox.env,
      timeout: 15_000,
    });
    if (version.stdout.trim() !== "1.18.31")
      throw new ExecutionHarnessError(`Expected OpenCode 1.18.31, got ${version.stdout.trim()}`);
  } catch (error) {
    await sandbox[Symbol.asyncDispose]();
    throw error;
  }
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
    cwd: sandbox.cwd,
    env: sandbox.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const started = Promise.withResolvers<string>();
  const exited = Promise.withResolvers<void>();
  const capture = (chunk: Buffer) => {
    output += chunk.toString();
    const url = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
    if (url) started.resolve(url);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("error", (error) => {
    started.reject(error);
    exited.resolve();
  });
  child.once("close", (code) => {
    started.reject(new ExecutionHarnessError(`OpenCode exited ${code}\n${output}`));
    exited.resolve();
  });
  const stop = async () => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    await exited.promise;
    await sandbox[Symbol.asyncDispose]();
  };
  const deadline = setTimeout(
    () => started.reject(new ExecutionHarnessError(`Startup deadline exceeded\n${output}`)),
    20_000,
  );
  try {
    const url = await started.promise;
    const api = ky.create({ prefixUrl: url, timeout: 20_000, retry: 0, redirect: "error" });
    z.object({ healthy: z.literal(true), version: z.literal("1.18.31") }).parse(
      await api.get("global/health").json(),
    );
    const stream = await executionEvents(api);
    return {
      api,
      events: stream.events,
      logs: () => output,
      async session() {
        return z
          .object({ id: z.string() })
          .parse(await api.post("session", { json: { title: "Execution fallback E2E" } }).json())
          .id;
      },
      async prompt(sessionID: string, modelID = "auto") {
        await api.post(`session/${sessionID}/prompt_async`, {
          json: {
            ...executionRequest,
            model: { providerID: modelID === "auto" ? "jev-router" : "a", modelID },
          },
        });
      },
      async history(sessionID: string) {
        return historySchema.parse(await api.get(`session/${sessionID}/message`).json());
      },
      async [Symbol.asyncDispose]() {
        try {
          await stream[Symbol.asyncDispose]();
        } finally {
          await stop();
        }
      },
    };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}
