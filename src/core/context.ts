import { randomUUID } from "node:crypto";

export interface InvestigationContext {
  requestId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  userId: string;
}

export function investigationContext(
  value: Omit<InvestigationContext, "requestId"> & { requestId?: string }
): InvestigationContext {
  return { ...value, requestId: value.requestId ?? randomUUID() };
}

export interface ConnectionDescriptor {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  serviceId: string;
  serviceLabel: string;
  domain: string;
  scopes: string[];
  health: "ready" | "reauthorization_required" | "revoked";
  connectedAt: string;
}

export type ConnectionAccessErrorCode =
  | "authorization_required"
  | "scope_missing"
  | "revoked"
  | "rate_limited"
  | "transient_failure";

export class ConnectionAccessError extends Error {
  constructor(
    readonly code: ConnectionAccessErrorCode,
    message: string,
    readonly connectionId?: string,
    readonly ownerUserId?: string
  ) {
    super(message);
    this.name = "ConnectionAccessError";
  }
}

export type InvestigationJobStatus =
  | "queued"
  | "running"
  | "waiting_for_authorization"
  | "waiting_for_capacity"
  | "completed"
  | "failed";

export interface InvestigationJob {
  id: string;
  context: InvestigationContext;
  question: string;
  relevantSources?: string[];
  relevantOwnerUserIds?: string[];
  status: InvestigationJobStatus;
  retryAt?: string;
  waitingConnectionId?: string;
  statusMessageTs?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
