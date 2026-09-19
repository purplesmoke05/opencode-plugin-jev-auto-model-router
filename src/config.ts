import { z } from "zod";

export const AUTO_PROVIDER = "jev-router";
export const AUTO_MODEL = "auto";
export const AUTO_REF = `${AUTO_PROVIDER}/${AUTO_MODEL}`;

const modelRef = z
  .string()
  .min(3)
  .max(240)
  .regex(/^[^/\s\p{Cc}]+\/[^\s\p{Cc}]+$/u)
  .refine(
    (value) => !value.startsWith(`${AUTO_PROVIDER}/`),
    "A candidate cannot route back to Auto",
  );

const optionsSchema = z
  .strictObject({
    candidates: z
      .array(
        z.strictObject({
          model: modelRef,
          description: z.string().trim().min(1).max(1000),
          variant: z.string().min(1).max(80).optional(),
        }),
      )
      .min(1)
      .max(16),
    fallback: modelRef,
    agents: z.array(z.string().min(1)).min(1).default(["build", "quick"]),
    confidenceThreshold: z.number().min(0).max(1).default(0.7),
    timeoutMs: z.number().int().min(100).max(30000).default(5000),
    maxPromptChars: z.number().int().min(100).max(32000).default(12000),
    notify: z.boolean().default(true),
  })
  .superRefine((options, context) => {
    const models = new Set(options.candidates.map((candidate) => candidate.model));
    if (models.size !== options.candidates.length) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Candidate models must be unique",
      });
    }
    if (!models.has(options.fallback)) {
      context.addIssue({
        code: "custom",
        path: ["fallback"],
        message: "Fallback must be a candidate",
      });
    }
  });

export type RouterOptions = Readonly<z.infer<typeof optionsSchema>>;

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

export function parseOptions(value: unknown): RouterOptions {
  const result = optionsSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigurationError(
      `Jev Auto configuration: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "options"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

export function splitModel(model: string) {
  const slash = model.indexOf("/");
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}
