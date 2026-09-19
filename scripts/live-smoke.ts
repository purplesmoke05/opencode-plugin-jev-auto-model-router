import { createDecider } from "../src/jev.js";

const apiKey = process.env["TYPESAFE_API_KEY"];
if (!apiKey) {
  console.error("TYPESAFE_API_KEY is missing. No request sent.");
  process.exitCode = 1;
} else {
  const result = await createDecider()({
    apiKey,
    timeoutMs: 5000,
    prompt:
      "Fix a spelling mistake in a code comment. These are hypothetical candidates for a connection test.",
    candidates: [
      { model: "example/fast", description: "Fast, inexpensive model for simple localized edits." },
      {
        model: "example/strong",
        description: "More capable model for complex architecture and risky changes.",
      },
    ],
  });
  console.log(JSON.stringify(result));
  switch (result.kind) {
    case "selected":
      break;
    case "unavailable":
      process.exitCode = 1;
      break;
    default: {
      const unreachable: never = result;
      throw unreachable;
    }
  }
}
