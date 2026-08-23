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
}

export interface ChatResult {
  content: string;
}

export class LlmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
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
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 400,
        stream: false,
      }),
    });
    if (!res.ok) {
      throw new LlmHttpError(`llm http ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content) throw new Error('llm returned empty content');
    return { content };
  } finally {
    clearTimeout(timer);
  }
}
