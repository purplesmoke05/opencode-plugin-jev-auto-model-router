import type { Part } from "@opencode-ai/sdk";

// OMO 5.0.0-beta.65 uses these protocol markers for retries and internal notifications.
const retryMarker = /<!--\s*OMO_RUNTIME_FALLBACK_RETRY\s*-->/;
const internalMarker = /<!--\s*OMO_INTERNAL_INITIATOR\s*-->/;
const noReplyMarker = /<!--\s*OMO_INTERNAL_NOREPLY\s*-->/;

export function inspectMessage(parts: readonly Part[], childTask = false) {
  const texts = parts.filter((part) => part.type === "text");
  const taskTexts = texts.filter(
    (part) => !part.synthetic && !part.ignored && !noReplyMarker.test(part.text),
  );
  const userTexts = taskTexts.filter((part) => childTask || !internalMarker.test(part.text));
  const internalOnly =
    texts.length > 0 && texts.every((part) => part.synthetic || internalMarker.test(part.text));
  return {
    prompt: userTexts
      .map((part) => (childTask ? part.text.replace(internalMarker, "").trimEnd() : part.text))
      .join("\n"),
    hasTaskText: taskTexts.length > 0,
    retry: internalOnly && texts.some((part) => retryMarker.test(part.text)),
    synthetic: userTexts.length === 0 && !parts.some((part) => part.type === "file"),
  };
}
