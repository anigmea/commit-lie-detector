import process from "node:process";

export interface LLMError {
  code: "timeout" | "api_error" | "rate_limit" | "invalid_key" | "network" | "parse_error";
  message: string;
  retryable: boolean;
}

export interface EvaluateResult {
  honest: boolean;
  accusation: string | null;
  suggested_message: string;
  confidence: number;
}

export interface LLMOptions {
  conventional?: boolean;
  quality?: boolean;
}

// Models
const ANTHROPIC_HAIKU = "claude-haiku-4-5-20251001";
const ANTHROPIC_SONNET = "claude-sonnet-4-6";
const OPENAI_FAST = "gpt-4o-mini";
const OPENAI_QUALITY = "gpt-4o";

// Connection-only timeout: abort if no bytes arrive within 8s
const CONNECTION_TIMEOUT_MS = 8000;

function makeLLMError(
  code: LLMError["code"],
  message: string,
  retryable: boolean
): LLMError {
  return { code, message, retryable };
}

function getProvider(): "anthropic" | "openai" {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  const err = new Error(
    "No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY."
  ) as any;
  err.isLLMError = true;
  err.llmError = makeLLMError("invalid_key", err.message, false);
  throw err;
}

function buildEvaluatePrompt(
  commitMessage: string,
  diff: DiffInput,
  conventional: boolean
): string {
  const formatNote = conventional
    ? " When writing suggested_message, use Conventional Commits format (feat/fix/chore/etc)."
    : "";
  const statSection = diff.stat ? `\nStat summary:\n${diff.stat}\n` : "";
  const truncNote = diff.truncated
    ? `\n[Note: diff was truncated to 4000 lines. Stat summary shows full scope.]\n`
    : "";
  return `Commit message: "${commitMessage}"
${statSection}${truncNote}
Staged diff:
${diff.diff || "(empty diff — no changes)"}`;
}

function buildSuggestPrompt(diff: DiffInput): string {
  const statSection = diff.stat ? `\nStat summary:\n${diff.stat}\n` : "";
  const truncNote = diff.truncated
    ? `\n[Note: diff was truncated to 4000 lines. Stat summary shows full scope.]\n`
    : "";
  return `Generate a commit message for these staged changes:
${statSection}${truncNote}
Staged diff:
${diff.diff || "(empty diff — no changes)"}`;
}

function buildEvaluateSystem(conventional: boolean): string {
  const formatNote = conventional
    ? " Use Conventional Commits format (feat/fix/chore/docs/refactor/test/perf/ci/build) in suggested_message."
    : "";
  return `You evaluate whether a commit message accurately describes the staged diff.

Return ONLY valid JSON on a single line (no markdown, no code fences):
{"honest":boolean,"accusation":string|null,"suggested_message":string,"confidence":number}

Rules:
- honest: true if the message reasonably describes the primary changes
- accusation: null when honest; otherwise a SPECIFIC sentence naming actual changed entities (files, classes, functions)
- suggested_message: ALWAYS populate with the best possible commit message, even when honest${formatNote}
- confidence: float 0.0–1.0; set honest=false when confidence < 0.5

Calibration anchors:
CLEAR PASS: 1-line null-check fix, message "fix: null check in getUserById" → {"honest":true,"accusation":null,"suggested_message":"fix: null check in getUserById","confidence":0.92}
CLEAR FAIL: diff adds UserAuthService class, 2 new endpoints in api/routes.ts, deletes legacy/auth.js, message "fix typo" → {"honest":false,"accusation":"Message says 'fix typo' but diff adds UserAuthService, two new auth endpoints in routes.ts, and deletes auth.js — this is a new feature, not a typo fix","suggested_message":"feat: add UserAuthService, new auth routes, remove legacy auth.js","confidence":0.04}
BORDERLINE: rename of 50 files touching many lines + one typo fix, message "fix typo in error messages" — if the primary intent is the rename (auto-generated), mark honest=false; if it genuinely IS a typo fix with collateral rename noise, mark honest=true

Ignore lock files and generated files — they were pre-filtered from the diff you receive.`;
}

function buildSuggestSystem(conventional: boolean): string {
  const formatNote = conventional
    ? " Use Conventional Commits format: type(scope): description. Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build."
    : "";
  return `You generate precise, accurate commit messages from staged diffs.

Rules:
- Describe WHAT changed AND WHY it matters — not just "updated X" or "changed Y"
- Reference changed files, classes, functions, and endpoints by NAME
- Be specific: "add UserAuthService for JWT token validation" not "add auth service"${formatNote}
- Keep the subject line under 72 characters
- Return ONLY the commit message text — no JSON, no markdown, no explanation
- If the diff is large, focus on the most significant change; summarize the rest`;
}

interface DiffInput {
  stat: string;
  diff: string;
  truncated: boolean;
}

// Normalize provider errors to LLMError
function normalizeError(err: any, provider: "anthropic" | "openai"): LLMError {
  if (err?.isLLMError) return err.llmError as LLMError;

  const status = err?.status ?? err?.statusCode ?? 0;
  const msg = err?.message ?? String(err);
  const code = err?.code ?? "";

  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ECONNRESET") {
    return makeLLMError("network", `Network error: ${msg}`, true);
  }
  if (status === 429) {
    return makeLLMError("rate_limit", "Rate limit exceeded — wait and retry.", true);
  }
  if (status === 401 || status === 403) {
    const keyName = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    return makeLLMError("invalid_key", `Invalid ${keyName} (HTTP ${status}).`, false);
  }
  return makeLLMError("api_error", msg, status >= 500);
}

// ── Anthropic provider ────────────────────────────────────────────────────────

async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
  quality: boolean
): Promise<string> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = quality ? ANTHROPIC_SONNET : ANTHROPIC_HAIKU;

  const controller = new AbortController();
  let connectionTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, CONNECTION_TIMEOUT_MS);

  let accumulated = "";
  let firstChunk = false;

  try {
    const stream = client.messages.stream(
      {
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      },
      { signal: controller.signal }
    );

    for await (const event of stream) {
      if (!firstChunk) {
        firstChunk = true;
        if (connectionTimer) {
          clearTimeout(connectionTimer);
          connectionTimer = null;
        }
      }
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        accumulated += event.delta.text;
      }
    }

    return accumulated;
  } catch (err: any) {
    if (controller.signal.aborted || err?.name === "AbortError") {
      throw makeLLMError(
        "timeout",
        "API connection timed out after 8 seconds (no response received).",
        false
      );
    }
    throw normalizeError(err, "anthropic");
  } finally {
    if (connectionTimer) clearTimeout(connectionTimer);
  }
}

// ── OpenAI provider ───────────────────────────────────────────────────────────

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
  quality: boolean
): Promise<string> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = quality ? OPENAI_QUALITY : OPENAI_FAST;

  const controller = new AbortController();
  let connectionTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, CONNECTION_TIMEOUT_MS);

  let accumulated = "";
  let firstChunk = false;

  try {
    const stream = await client.chat.completions.create(
      {
        model,
        max_tokens: 1024,
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      },
      { signal: controller.signal }
    );

    for await (const chunk of stream) {
      if (!firstChunk) {
        firstChunk = true;
        if (connectionTimer) {
          clearTimeout(connectionTimer);
          connectionTimer = null;
        }
      }
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) accumulated += delta;
    }

    return accumulated;
  } catch (err: any) {
    if (controller.signal.aborted || err?.name === "AbortError") {
      throw makeLLMError(
        "timeout",
        "API connection timed out after 8 seconds (no response received).",
        false
      );
    }
    throw normalizeError(err, "openai");
  } finally {
    if (connectionTimer) clearTimeout(connectionTimer);
  }
}

// ── Provider dispatch ─────────────────────────────────────────────────────────

async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  quality: boolean
): Promise<string> {
  const provider = getProvider();
  if (provider === "anthropic") {
    return callAnthropic(systemPrompt, userPrompt, quality);
  }
  return callOpenAI(systemPrompt, userPrompt, quality);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Evaluate mode: compare commit message against staged diff.
 * Returns structured JSON result.
 * Throws LLMError on failure.
 */
export async function evaluate(
  commitMessage: string,
  diff: DiffInput,
  opts: LLMOptions = {}
): Promise<EvaluateResult> {
  const { conventional = false, quality = false } = opts;
  const systemPrompt = buildEvaluateSystem(conventional);
  const userPrompt = buildEvaluatePrompt(commitMessage, diff, conventional);

  const raw = await callLLM(systemPrompt, userPrompt, quality);

  // Strip markdown code fences if the model wrapped in them
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw makeLLMError(
      "parse_error",
      `LLM returned non-JSON response: ${cleaned.slice(0, 200)}`,
      false
    );
  }

  // Validate required fields, coerce types
  const honest = Boolean(parsed.honest);
  const accusation =
    typeof parsed.accusation === "string" && parsed.accusation.length > 0
      ? parsed.accusation
      : null;
  const suggested_message =
    typeof parsed.suggested_message === "string"
      ? parsed.suggested_message.trim()
      : commitMessage;
  const confidence =
    typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : honest
      ? 0.8
      : 0.2;

  return { honest, accusation, suggested_message, confidence };
}

/**
 * Suggest mode: generate a commit message from staged diff.
 * Returns plain string. Throws LLMError on failure.
 */
export async function suggest(
  diff: DiffInput,
  opts: LLMOptions = {}
): Promise<string> {
  const { conventional = false, quality = false } = opts;
  const systemPrompt = buildSuggestSystem(conventional);
  const userPrompt = buildSuggestPrompt(diff);

  const raw = await callLLM(systemPrompt, userPrompt, quality);
  return raw.trim();
}
