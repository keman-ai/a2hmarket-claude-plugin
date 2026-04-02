// src/approval-store.ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Approval {
  id: string;
  peerId: string;
  sessionKey: string;
  question: string;
  context?: string;
  options: string[];
  status: "pending" | "approved" | "rejected" | "custom";
  response?: string;
  createdAt: number;
  resolvedAt?: number;
  notified: boolean;
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let storePath: string | null = null;
let approvals: Map<string, Approval> = new Map();

export function initApprovalStore(filePath: string): void {
  storePath = filePath;
  mkdirSync(dirname(filePath), { recursive: true });
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (Array.isArray(data)) {
      for (const a of data) {
        if (a?.id) approvals.set(a.id, a);
      }
    }
  } catch {
    // No persisted data yet
  }
  evict();
}

function persist(): void {
  if (!storePath) return;
  try {
    writeFileSync(storePath, JSON.stringify([...approvals.values()], null, 2));
  } catch {
    // Best effort
  }
}

function evict(): void {
  const now = Date.now();
  for (const [id, a] of approvals) {
    if (now - a.createdAt > MAX_AGE_MS) approvals.delete(id);
  }
}

function generateId(): string {
  return `apr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createApproval(params: {
  peerId: string;
  sessionKey: string;
  question: string;
  context?: string;
  options?: string[];
}): Approval {
  evict();
  const approval: Approval = {
    id: generateId(),
    peerId: params.peerId,
    sessionKey: params.sessionKey,
    question: params.question,
    context: params.context,
    options: params.options ?? [],
    status: "pending",
    createdAt: Date.now(),
    notified: false,
  };
  approvals.set(approval.id, approval);
  persist();
  return approval;
}

export function getApproval(id: string): Approval | null {
  return approvals.get(id) ?? null;
}

export function resolveApproval(id: string, status: "approved" | "rejected" | "custom", response: string): Approval | null {
  const approval = approvals.get(id);
  if (!approval || approval.status !== "pending") return null;
  approval.status = status;
  approval.response = response;
  approval.resolvedAt = Date.now();
  persist();
  return approval;
}

export function markNotified(id: string): void {
  const approval = approvals.get(id);
  if (approval) {
    approval.notified = true;
    persist();
  }
}

export function listPending(): Approval[] {
  evict();
  return [...approvals.values()].filter(a => a.status === "pending");
}

const APPROVAL_VALID_MS = 30 * 60 * 1000; // 30 minutes

export function hasApprovedForPeer(peerId: string): boolean {
  const now = Date.now();
  return [...approvals.values()].some(
    a => a.peerId === peerId
      && (a.status === "approved" || a.status === "custom")
      && a.resolvedAt != null
      && (now - a.resolvedAt) < APPROVAL_VALID_MS
  );
}
