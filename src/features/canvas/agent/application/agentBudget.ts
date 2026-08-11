import type { AgentApprovalRecord, AgentImpactSummary } from './agentApproval';

const BUDGET_STORAGE_KEY = 'storyboard-copilot:canvas-agent:budgets:v1';
const MAX_PROJECT_BUDGETS = 200;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AgentProjectBudget {
  projectId: string;
  currency: 'credits';
  limit: number | null;
  spent: number;
  reservations: Record<string, number>;
  updatedAt: number;
}

interface BudgetEnvelope {
  version: 1;
  projects: AgentProjectBudget[];
}

export interface AgentBudgetDecision {
  allowed: boolean;
  configured: boolean;
  unknownCost: boolean;
  estimatedCost: number | null;
  remaining: number | null;
  reason?: 'budget-exceeded';
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function emptyEnvelope(): BudgetEnvelope {
  return { version: 1, projects: [] };
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizeBudget(value: unknown): AgentProjectBudget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<AgentProjectBudget>;
  if (typeof record.projectId !== 'string' || !record.projectId.trim()) return null;
  const reservations = record.reservations && typeof record.reservations === 'object' && !Array.isArray(record.reservations)
    ? Object.fromEntries(Object.entries(record.reservations).filter(([, amount]) => isFiniteNonNegative(amount)))
    : {};
  return {
    projectId: record.projectId,
    currency: 'credits',
    limit: record.limit === null || isFiniteNonNegative(record.limit) ? record.limit : null,
    spent: isFiniteNonNegative(record.spent) ? record.spent : 0,
    reservations,
    updatedAt: isFiniteNonNegative(record.updatedAt) ? record.updatedAt : 0,
  };
}

function parseEnvelope(raw: string | null): BudgetEnvelope {
  if (!raw) return emptyEnvelope();
  try {
    const parsed = JSON.parse(raw) as Partial<BudgetEnvelope>;
    if (parsed.version !== 1 || !Array.isArray(parsed.projects)) return emptyEnvelope();
    return {
      version: 1,
      projects: parsed.projects.flatMap((project) => {
        const normalized = normalizeBudget(project);
        return normalized ? [normalized] : [];
      }).slice(-MAX_PROJECT_BUDGETS),
    };
  } catch {
    return emptyEnvelope();
  }
}

function estimatedCost(impact: AgentImpactSummary): number | null {
  if (!impact.estimatedCost || impact.estimatedCost.confidence === 'unknown') return null;
  const value = impact.estimatedCost.value;
  return isFiniteNonNegative(value) ? value : null;
}

export class AgentBudgetLedger {
  private memory = emptyEnvelope();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: StorageLike | null = defaultStorage(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(projectId: string): AgentProjectBudget {
    const current = this.read().projects.find((project) => project.projectId === projectId);
    return current ? structuredClone(current) : {
      projectId,
      currency: 'credits',
      limit: null,
      spent: 0,
      reservations: {},
      updatedAt: 0,
    };
  }

  setLimit(projectId: string, limit: number | null): AgentProjectBudget {
    if (limit !== null && !isFiniteNonNegative(limit)) throw new Error('Agent budget must be a finite non-negative number.');
    return this.update(projectId, (budget) => ({ ...budget, limit }));
  }

  reset(projectId: string): AgentProjectBudget {
    return this.update(projectId, (budget) => ({ ...budget, spent: 0, reservations: {} }));
  }

  evaluate(projectId: string, impact: AgentImpactSummary): AgentBudgetDecision {
    const budget = this.get(projectId);
    const cost = estimatedCost(impact);
    const reserved = Object.values(budget.reservations).reduce((total, value) => total + value, 0);
    const remaining = budget.limit === null ? null : Math.max(0, budget.limit - budget.spent - reserved);
    if (budget.limit === null) {
      return { allowed: true, configured: false, unknownCost: cost === null, estimatedCost: cost, remaining: null };
    }
    if (cost === null) {
      return { allowed: true, configured: true, unknownCost: true, estimatedCost: null, remaining };
    }
    return {
      allowed: cost <= remaining!,
      configured: true,
      unknownCost: false,
      estimatedCost: cost,
      remaining,
      ...(cost > remaining! ? { reason: 'budget-exceeded' as const } : {}),
    };
  }

  reserve(approval: AgentApprovalRecord): AgentBudgetDecision {
    const decision = this.evaluate(approval.projectId, approval.impact);
    if (!decision.allowed) return decision;
    if (decision.estimatedCost === null || decision.estimatedCost === 0) return decision;
    this.update(approval.projectId, (budget) => ({
      ...budget,
      reservations: { ...budget.reservations, [approval.id]: decision.estimatedCost! },
    }));
    return decision;
  }

  release(projectId: string, approvalId: string): void {
    this.update(projectId, (budget) => {
      if (!(approvalId in budget.reservations)) return budget;
      const reservations = { ...budget.reservations };
      delete reservations[approvalId];
      return { ...budget, reservations };
    });
  }

  commit(projectId: string, approvalId: string): void {
    this.update(projectId, (budget) => {
      const amount = budget.reservations[approvalId];
      if (!isFiniteNonNegative(amount)) return budget;
      const reservations = { ...budget.reservations };
      delete reservations[approvalId];
      return { ...budget, spent: budget.spent + amount, reservations };
    });
  }

  private update(projectId: string, update: (budget: AgentProjectBudget) => AgentProjectBudget): AgentProjectBudget {
    const envelope = this.read();
    const index = envelope.projects.findIndex((project) => project.projectId === projectId);
    const current = index >= 0 ? envelope.projects[index] : this.get(projectId);
    const next = { ...update(current), projectId, currency: 'credits' as const, updatedAt: this.now() };
    if (index >= 0) envelope.projects[index] = next;
    else envelope.projects.push(next);
    envelope.projects = envelope.projects.slice(-MAX_PROJECT_BUDGETS);
    this.write(envelope);
    return structuredClone(next);
  }

  private read(): BudgetEnvelope {
    return this.storage ? parseEnvelope(this.storage.getItem(BUDGET_STORAGE_KEY)) : structuredClone(this.memory);
  }

  private write(envelope: BudgetEnvelope): void {
    const safe = parseEnvelope(JSON.stringify(envelope));
    if (this.storage) this.storage.setItem(BUDGET_STORAGE_KEY, JSON.stringify(safe));
    else this.memory = structuredClone(safe);
    this.listeners.forEach((listener) => listener());
  }
}

export const canvasAgentBudgetLedger = new AgentBudgetLedger();
