import { AppError } from '../../core/errors/app-error.js';
import {
  UsageEventSchema,
  UsageReportSchema,
  type UsageEvent,
  type UsageReport,
} from '../../domain/schemas/usage.schema.js';

export type CostGuardOptions = {
  jobId?: string;
  maxCostUsd?: number;
  action?: 'warn' | 'stop';
};

export class CostGuard {
  private readonly jobId: string;
  private readonly maxCostUsd: number;
  private readonly action: 'warn' | 'stop';
  private readonly events: UsageEvent[] = [];
  private readonly warnings: string[] = [];

  constructor(options: CostGuardOptions = {}) {
    this.jobId = options.jobId ?? 'job_default';
    this.maxCostUsd = options.maxCostUsd ?? 5.0;
    this.action = options.action ?? 'stop';
  }

  get observedCostUsd(): number {
    return Number(this.events.reduce((acc, e) => acc + (e.measuredCostUsd ?? 0), 0).toFixed(6));
  }

  get estimatedCostUsd(): number {
    return Number(
      this.events
        .reduce(
          (acc, e) => acc + (e.measuredCostUsd === undefined ? (e.estimatedCostUsd ?? 0) : 0),
          0,
        )
        .toFixed(6),
    );
  }

  get totalKnownCostUsd(): number {
    return Number((this.observedCostUsd + this.estimatedCostUsd).toFixed(6));
  }

  get unknownCostCount(): number {
    return this.events.filter((e) => e.costStatus === 'unknown').length;
  }

  recordUsage(input: import('zod').input<typeof UsageEventSchema>): UsageEvent {
    const parsed = UsageEventSchema.parse(input);
    this.events.push(parsed);

    if (this.maxCostUsd > 0 && this.totalKnownCostUsd > this.maxCostUsd && this.action === 'warn') {
      this.warnings.push(
        `Orçamento de US$ ${this.maxCostUsd.toFixed(2)} ultrapassado (atual: US$ ${this.totalKnownCostUsd.toFixed(4)}).`,
      );
    }
    return parsed;
  }

  assertWithinBudget(): void {
    if (this.maxCostUsd > 0 && this.totalKnownCostUsd > this.maxCostUsd) {
      if (this.action === 'stop') {
        throw new AppError(
          `Limite de orçamento do job excedido: US$ ${this.totalKnownCostUsd.toFixed(4)} > US$ ${this.maxCostUsd.toFixed(2)}.`,
          {
            code: 'BUDGET_EXCEEDED',
            stage: 'budget',
            retryable: false,
          },
        );
      }
    }
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  buildReport(): UsageReport {
    return UsageReportSchema.parse({
      schemaVersion: 2,
      jobId: this.jobId,
      currency: 'USD',
      observedCostUsd: this.observedCostUsd,
      estimatedCostUsd: this.estimatedCostUsd,
      totalKnownCostUsd: this.totalKnownCostUsd,
      unknownCostCount: this.unknownCostCount,
      events: this.events,
    });
  }
}
