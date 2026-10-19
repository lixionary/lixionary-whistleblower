import type { CaseState } from "./suite.js";

export interface DashboardData {
  range: { from: string; to: string };
  total: number;
  states: { state: CaseState; count: number }[];
  waitingForSupport: { count: number; overdue: number };
  caseManager: { waitingOnReporter: number; waitingOnStaff: number };
  /** null when the private service cannot be reached. */
  ai: {
    total: number;
    notStarted: number;
    active: number;
    failed: number;
    idle: number;
  } | null;
  outcomes: { outcome: string; count: number }[];
  pendingClosure: number;
  trend: { day: string; created: number; closed: number }[];
}
