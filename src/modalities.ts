import type { Part } from "@opencode-ai/sdk";

export function attachmentModalities(parts: readonly Part[]): string[] {
  return parts.flatMap((part) => {
    if (part.type !== "file") return [];
    if (part.mime.startsWith("image/")) return ["image"];
    if (part.mime.startsWith("audio/")) return ["audio"];
    if (part.mime.startsWith("video/")) return ["video"];
    if (part.mime === "application/pdf") return ["pdf"];
    if (part.mime === "text/plain" || part.mime === "application/x-directory") return [];
    return ["unsupported-attachment"];
  });
}
