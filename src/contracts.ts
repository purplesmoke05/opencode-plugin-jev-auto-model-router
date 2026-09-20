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

export type ExecutionTarget = { readonly model: string; readonly variant?: string | undefined };
export type ExecutionSnapshot = {
  readonly sessionID: string;
  readonly userID: string;
  readonly assistantID: string;
  readonly model: string;
  readonly agent: string;
  readonly idle: boolean;
  readonly blocked: boolean;
  readonly complete: boolean;
  readonly failed: boolean;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfter?: string;
  readonly modalities: readonly string[];
  readonly requestOptions: {
    readonly tools?: Readonly<Record<string, boolean>>;
    readonly system?: string;
    readonly format?: unknown;
  };
};
export type ExecutionModel = {
  readonly model: string;
  readonly toolcall: boolean;
  readonly modalities: readonly string[];
  readonly variants?: readonly string[];
};
export type ExecutionNotice = {
  readonly action: "retry" | "recovered" | "exhausted" | "stopped";
  readonly reason: string;
  readonly from?: string;
  readonly to?: string;
  readonly status?: number;
  readonly retryAfter?: string;
};
export type ExecutionHost = {
  readonly inspect: (sessionID: string) => Promise<ExecutionSnapshot | undefined>;
  readonly models: () => Promise<readonly ExecutionModel[]>;
  readonly dispatch: (
    snapshot: ExecutionSnapshot,
    target: ExecutionTarget,
    token: string,
  ) => Promise<void>;
  readonly report: (sessionID: string, notice: ExecutionNotice) => Promise<void>;
  readonly recovered: (sessionID: string, target: ExecutionTarget) => Promise<void>;
};
