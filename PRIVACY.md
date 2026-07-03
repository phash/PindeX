# Privacy Policy

_Last updated: 2026-07-03_

PindeX is a developer tool that runs **locally on your machine**. It structurally
indexes your codebase so AI coding assistants can navigate it with fewer tokens.

## What PindeX stores — all local

- A structural index of your code (symbols, imports, dependencies) in a local
  SQLite database (`<project>/.pindex/index.db`).
- A local registry of your indexed projects (`~/.pindex/`).
- Passive "session memory" — observations about what changed during a session.
- Token-usage statistics shown in the local monitoring dashboard.

None of this leaves your machine. PindeX has **no telemetry, no analytics, and
does not phone home** to the authors or any third party.

## Optional external transmission

- **LLM summaries — off by default.** If you set `GENERATE_SUMMARIES=true` and
  provide an API key, PindeX sends code snippets to the summarization endpoint
  **you configure** (`SUMMARIZER_BASE_URL`, default `api.openai.com`) using
  **your own** API key. That provider's privacy policy then applies. This is
  entirely opt-in and inactive unless you enable it.
- **Dashboard charting library.** When you open the monitoring / GUI dashboard in
  your browser, the page loads the Chart.js and dayjs libraries from the public
  jsDelivr CDN, so your browser contacts `cdn.jsdelivr.net`. No PindeX data or
  source code is sent — only a request for the library files.

## Data sharing

PindeX does not sell, share, or transmit your source code or usage data to the
authors or to any analytics provider.

## Contact

Questions: projekt@phash.de · <https://github.com/phash/PindeX>
