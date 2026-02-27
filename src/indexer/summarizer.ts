/** Summarizer – optional LLM-based file/symbol summaries.
 *  Currently a stub. When GENERATE_SUMMARIES=true and an API key is available,
 *  this module would call an LLM to generate 1-2 sentence summaries. */

export interface SummarizerOptions {
  enabled: boolean;
}

export class Summarizer {
  private readonly enabled: boolean;

  constructor(options: SummarizerOptions = { enabled: false }) {
    this.enabled = options.enabled;
  }

  /** Generates a summary for a symbol. Returns null if disabled. */
  async summarizeSymbol(_signature: string, _codeSnippet: string): Promise<string | null> {
    if (!this.enabled) return null;
    // TODO: Implement LLM-based summary generation
    return null;
  }

  /** Generates a summary for a file. Returns null if disabled. */
  async summarizeFile(_filePath: string, _content: string): Promise<string | null> {
    if (!this.enabled) return null;
    // TODO: Implement LLM-based summary generation
    return null;
  }
}
