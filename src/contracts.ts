export type Candidate = {
  readonly model: string;
  readonly description: string;
  readonly variant?: string | undefined;
};

export type ContextOptions = {
  readonly enabled: boolean;
  readonly maxCharacters: number;
};

export type TaskContext = {
  readonly previous_assistant?: string;
  readonly truncated: boolean;
};

export type SessionPin = {
  readonly model: string;
  readonly variant?: string | undefined;
  readonly reason: string;
  readonly recovery?: boolean;
  readonly confidence?: number;
};

export type SessionPins = {
  readonly load: (sessionID: string) => Promise<SessionPin | undefined>;
  readonly claim: (sessionID: string, pin: SessionPin) => Promise<SessionPin>;
  readonly replace: (sessionID: string, pin: SessionPin) => Promise<void>;
  readonly forget: (sessionID: string) => Promise<void>;
};

export type DecisionRequest = {
  readonly prompt: string;
  readonly context?: TaskContext;
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
