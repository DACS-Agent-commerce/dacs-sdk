export type DacsNodeEventLevel = "debug" | "info" | "warn" | "error";

export type DacsNodeEventKind =
  | "service-lifecycle"
  | "order-progress"
  | "transport"
  | "effect"
  | "health"
  | "operator-action";

export interface DacsNodeEvent {
  version: 1;
  sequence: number;
  occurredAt: number;
  level: DacsNodeEventLevel;
  kind: DacsNodeEventKind;
  code: string;
  role: "demo-all" | "buyer" | "seller" | "verifier";
  jobId?: string;
  reference?: string;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DacsNodeEventSink {
  emit(event: Readonly<DacsNodeEvent>): Promise<void> | void;
}

export interface DacsNodeHealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  checkedAt: number;
  components: Readonly<Record<string, Readonly<{
    status: "healthy" | "degraded" | "unhealthy";
    reasonCode?: string;
  }>>>;
}

export interface DacsNodeReadinessStatus {
  ready: boolean;
  checkedAt: number;
  reasonCodes: readonly string[];
}
