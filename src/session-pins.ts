import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AUTO_PROVIDER } from "./config.js";
import type { SessionPin, SessionPins } from "./contracts.js";

const sessionIDSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/)
  .brand("SessionID");
const pinSchema = z.object({
  model: z
    .string()
    .min(3)
    .max(240)
    .regex(/^[^/\s\p{Cc}]+\/[^\s\p{Cc}]+$/u)
    .refine((model) => !model.startsWith(`${AUTO_PROVIDER}/`)),
  variant: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[^\p{Cc}]+$/u)
    .optional(),
  reason: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,80}$/)
    .default("sticky"),
  recovery: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
const recordSchema = pinSchema
  .extend({ version: z.literal(1), sessionID: sessionIDSchema })
  .strict();
type SessionID = z.infer<typeof sessionIDSchema>;

export class SessionPinError extends Error {
  override readonly name = "SessionPinError";

  constructor(readonly code: "invalid-session" | "invalid-pin" | "corrupt-pin" | "claim-lost") {
    super(`Session pin storage: ${code}`);
  }
}

function parseSessionID(value: string): SessionID {
  const result = sessionIDSchema.safeParse(value);
  if (!result.success) throw new SessionPinError("invalid-session");
  return result.data;
}

function snapshot(pin: z.infer<typeof pinSchema>): SessionPin {
  return Object.freeze({
    model: pin.model,
    reason: pin.reason,
    ...(pin.variant === undefined ? {} : { variant: pin.variant }),
    ...(pin.recovery === undefined ? {} : { recovery: pin.recovery }),
    ...(pin.confidence === undefined ? {} : { confidence: pin.confidence }),
  });
}

function parsePin(value: SessionPin): SessionPin {
  const result = pinSchema.safeParse(value);
  if (!result.success) throw new SessionPinError("invalid-pin");
  return snapshot(result.data);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function remove(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

export function createSessionPins(directory: string): SessionPins {
  const pathFor = (sessionID: SessionID) => join(directory, `${sessionID}.json`);

  const load = async (id: string): Promise<SessionPin | undefined> => {
    const sessionID = parseSessionID(id);
    let content: string;
    try {
      content = await readFile(pathFor(sessionID), "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      if (error instanceof SyntaxError) throw new SessionPinError("corrupt-pin");
      throw error;
    }
    const result = recordSchema.safeParse(value);
    if (!result.success || result.data.sessionID !== sessionID) {
      throw new SessionPinError("corrupt-pin");
    }
    return snapshot(result.data);
  };

  const publish = async (id: string, value: SessionPin, replace: boolean): Promise<SessionPin> => {
    const sessionID = parseSessionID(id);
    const pin = parsePin(value);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${sessionID}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify({ version: 1, sessionID, ...pin }), "utf8");
      } finally {
        await handle.close();
      }
      if (replace) {
        await rename(temporary, pathFor(sessionID));
        return pin;
      }
      try {
        await link(temporary, pathFor(sessionID));
        return pin;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        const winner = await load(sessionID);
        if (winner === undefined) throw new SessionPinError("claim-lost");
        return winner;
      }
    } finally {
      await remove(temporary);
    }
  };

  return {
    load,
    claim: (sessionID, pin) => publish(sessionID, pin, false),
    replace: async (sessionID, pin) => {
      await publish(sessionID, pin, true);
    },
    forget: async (sessionID) => {
      await remove(pathFor(parseSessionID(sessionID)));
    },
  };
}

export function createMemorySessionPins(): SessionPins {
  const pins = new Map<SessionID, SessionPin>();
  return {
    load: async (sessionID) => pins.get(parseSessionID(sessionID)),
    claim: async (id, value) => {
      const sessionID = parseSessionID(id);
      const pin = parsePin(value);
      const winner = pins.get(sessionID) ?? pin;
      pins.set(sessionID, winner);
      return winner;
    },
    replace: async (sessionID, pin) => {
      pins.set(parseSessionID(sessionID), parsePin(pin));
    },
    forget: async (sessionID) => {
      pins.delete(parseSessionID(sessionID));
    },
  };
}
