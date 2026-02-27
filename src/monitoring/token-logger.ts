import type { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { TokenEvent } from '../types.js';
import { insertTokenLog } from '../db/queries.js';

export interface TokenLoggerOptions {
  db: Database.Database;
  sessionId: string;
  emitter: EventEmitter;
}

export interface LogInput {
  toolName: string;
  tokensUsed: number;
  tokensWithoutIndex: number;
  filesTouched?: string[];
  query?: string;
}

export class TokenLogger {
  private readonly db: Database.Database;
  private readonly sessionId: string;
  private readonly emitter: EventEmitter;
  private cumulativeActual = 0;
  private cumulativeSavings = 0;

  constructor(options: TokenLoggerOptions) {
    this.db = options.db;
    this.sessionId = options.sessionId;
    this.emitter = options.emitter;
  }

  /** Logs a tool call and emits a token_event. */
  log(input: LogInput): void {
    insertTokenLog(this.db, {
      sessionId: this.sessionId,
      toolName: input.toolName,
      tokensUsed: input.tokensUsed,
      tokensWithoutIndex: input.tokensWithoutIndex,
      filesTouched: input.filesTouched,
      query: input.query,
    });

    const savings = input.tokensWithoutIndex - input.tokensUsed;
    this.cumulativeActual += input.tokensUsed;
    this.cumulativeSavings += savings;

    const total = this.cumulativeActual + this.cumulativeSavings;
    const savingsPercent = total > 0 ? Math.round((this.cumulativeSavings / total) * 1000) / 10 : 0;

    const event: TokenEvent = {
      type: 'tool_call',
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
      tool: input.toolName,
      query: input.query,
      tokens_actual: input.tokensUsed,
      tokens_estimated: input.tokensWithoutIndex,
      savings,
      savings_percent: savingsPercent,
      cumulative_actual: this.cumulativeActual,
      cumulative_savings: this.cumulativeSavings,
    };

    this.emitter.emit('token_event', event);
  }

  getCurrentSessionId(): string {
    return this.sessionId;
  }
}
