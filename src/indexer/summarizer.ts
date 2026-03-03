/** Summarizer -- optional LLM-based file/symbol summaries.
 *  When GENERATE_SUMMARIES=true and a SUMMARIZER_API_KEY is set,
 *  calls an OpenAI-compatible /v1/chat/completions endpoint to produce
 *  1-2 sentence developer-oriented summaries. */

export interface SummarizerOptions {
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxConcurrency?: number;
}

// ─── Simple semaphore for concurrency limiting ────────────────────────────────

class Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ─── Summarizer Class ─────────────────────────────────────────────────────────

const FILE_SYSTEM_PROMPT =
  'You are a code documentation assistant. Summarize the given source file in 1-2 concise sentences for a developer. Focus on what the file does and its main exports. Do not include the file path in your response.';

const SYMBOL_SYSTEM_PROMPT =
  'You are a code documentation assistant. Summarize the given code symbol (function, class, method, etc.) in 1-2 concise sentences for a developer. Focus on what it does, its parameters, and return value. Do not repeat the signature verbatim.';

export class Summarizer {
  private readonly enabled: boolean;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly semaphore: Semaphore;

  constructor(options: SummarizerOptions = { enabled: false }) {
    this.enabled = options.enabled;
    this.apiKey = options.apiKey ?? '';
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = options.model ?? 'gpt-4o-mini';
    this.semaphore = new Semaphore(options.maxConcurrency ?? 3);
  }

  /** Generates a summary for a symbol. Returns null if disabled or on error. */
  async summarizeSymbol(signature: string, codeSnippet: string): Promise<string | null> {
    if (!this.enabled || !this.apiKey) return null;

    const userContent = `Signature: ${signature}\n\nCode:\n${codeSnippet}`;
    return this.callApi(SYMBOL_SYSTEM_PROMPT, userContent);
  }

  /** Generates a summary for a file. Returns null if disabled or on error. */
  async summarizeFile(filePath: string, content: string): Promise<string | null> {
    if (!this.enabled || !this.apiKey) return null;

    // Truncate very large files to first ~4000 chars to stay within token limits
    const truncated = content.length > 4000 ? content.slice(0, 4000) + '\n... (truncated)' : content;
    const userContent = `File: ${filePath}\n\n${truncated}`;
    return this.callApi(FILE_SYSTEM_PROMPT, userContent);
  }

  /** Calls the OpenAI-compatible chat completions endpoint. */
  private async callApi(systemPrompt: string, userContent: string): Promise<string | null> {
    await this.semaphore.acquire();
    try {
      const url = `${this.baseUrl}/chat/completions`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          max_tokens: 150,
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        process.stderr.write(
          `[pindex] Summarizer API error: ${response.status} ${response.statusText}\n`,
        );
        return null;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content?.trim();
      return text ?? null;
    } catch (err) {
      process.stderr.write(`[pindex] Summarizer request failed: ${String(err)}\n`);
      return null;
    } finally {
      this.semaphore.release();
    }
  }
}
