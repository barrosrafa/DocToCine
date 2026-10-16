import { sanitizeMessage } from '../../core/logging/redact.js';

export type JobEventType =
  | 'job.started'
  | 'pdf.extracted'
  | 'chapter.detected'
  | 'summary.completed'
  | 'script.completed'
  | 'tts.completed'
  | 'alignment.completed'
  | 'image.generated'
  | 'scene.reused'
  | 'video.rendered'
  | 'quality.failed'
  | 'job.completed';

export type JobReportEvent = {
  timestamp: string;
  jobId: string;
  event: JobEventType;
  stage: string;
  chapter?: number;
  durationPreset?: number;
  requestedModel?: string;
  usedModel?: string;
  elapsedMs: number;
  attempt?: number;
  bytes?: number;
  degraded?: boolean;
  warning?: string;
};

export class JobReporter {
  private readonly events: JobReportEvent[] = [];

  constructor(
    readonly jobId = 'job_default',
    private readonly secrets: string[] = [],
    private readonly verbose = false,
  ) {}

  record(input: Omit<JobReportEvent, 'timestamp' | 'jobId'>): JobReportEvent {
    const safeWarning = input.warning
      ? sanitizeMessage(input.warning, this.secrets, 800)
      : undefined;

    const entry: JobReportEvent = {
      timestamp: new Date().toISOString(),
      jobId: this.jobId,
      event: input.event,
      stage: sanitizeMessage(input.stage, this.secrets, 120),
      elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
      ...(input.chapter !== undefined ? { chapter: input.chapter } : {}),
      ...(input.durationPreset !== undefined ? { durationPreset: input.durationPreset } : {}),
      ...(input.requestedModel !== undefined
        ? { requestedModel: sanitizeMessage(input.requestedModel, this.secrets, 120) }
        : {}),
      ...(input.usedModel !== undefined
        ? { usedModel: sanitizeMessage(input.usedModel, this.secrets, 120) }
        : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
      ...(input.degraded !== undefined ? { degraded: input.degraded } : {}),
      ...(safeWarning !== undefined ? { warning: safeWarning } : {}),
    };

    this.events.push(entry);
    if (this.verbose) {
      process.stderr.write(`${JSON.stringify(entry)}\n`);
    }
    return entry;
  }

  getEvents(): JobReportEvent[] {
    return [...this.events];
  }
}
