/**
 * Minimal OpenAI-compatible chat client (works with vLLM, Ollama's OpenAI
 * endpoint, LM Studio, OpenAI itself…). No SDK dependency — one fetch call.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Provider-specific routing metadata (OpenCode Go uses this session id). */
  sessionId?: string;
  userAgent?: string;
}

export interface ChatResult {
  content: string;
  reasoningContent?: string;
  finishReason?: string;
  httpStatus: number;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export class LlmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: { finishReason?: string; usage?: ChatResult['usage'] },
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

export class LlmResponseError extends Error {
  constructor(
    message: string,
    readonly kind: 'empty_response' | 'provider_error',
    readonly details: { status: number; finishReason?: string; usage?: ChatResult['usage'] },
  ) {
    super(message);
    this.name = 'LlmResponseError';
  }
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : typeof part === 'object' && part && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('');
}

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const url = `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'user-agent': opts.userAgent ?? 'gamenight-agent/1.0',
        ...(opts.sessionId ? { 'x-opencode-session': opts.sessionId } : {}),
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.4,
        // Keep the default large enough for the complete JSON response after
        // a Cabo observation and candidate list. The server can override this
        // with AGENT_MAX_TOKENS for a measured provider budget.
        max_tokens: opts.maxTokens ?? 4_096,
        stream: false,
      }),
    });
    if (!res.ok) {
      throw new LlmHttpError(`llm http ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
    }
    const data = (await res.json()) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: unknown; reasoning_content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    const content = textContent(choice?.message?.content);
    const reasoningContent = textContent(choice?.message?.reasoning_content);
    const finishReason = choice?.finish_reason;
    const usage = data.usage
      ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
      : undefined;
    if (!content.trim()) {
      throw new LlmResponseError('llm returned empty content', 'empty_response', { status: res.status, finishReason, usage });
    }
    return { content, reasoningContent: reasoningContent || undefined, finishReason, httpStatus: res.status, usage };
  } finally {
    clearTimeout(timer);
  }
}
