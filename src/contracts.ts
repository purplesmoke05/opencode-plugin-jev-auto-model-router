export type Candidate = {
  readonly model: string;
  readonly description: string;
  readonly variant?: string | undefined;
};

export type DecisionRequest = {
  readonly prompt: string;
  readonly candidates: readonly Candidate[];
  readonly apiKey: string;
  readonly timeoutMs: number;
};

export type DecisionResult =
  | { readonly kind: "selected"; readonly model: string; readonly confidence: number }
  | {
      readonly kind: "unavailable";
      readonly reason: "http-error" | "invalid-response" | "timeout" | "network-error";
      readonly status?: number;
      readonly retryAfter?: string;
    };

export type Decide = (request: DecisionRequest) => Promise<DecisionResult>;
