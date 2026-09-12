/** Thin OpenAI-compatible client for Gemma on Lambda (via SSH tunnel). */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GemmaChatResult {
  content: string;
  latencyMs: number;
  model: string;
}

function baseUrl(): string {
  return (process.env.GEMMA_BASE_URL ?? "http://127.0.0.1:8000/v1").replace(/\/$/, "");
}

function modelName(): string {
  return process.env.GEMMA_MODEL ?? "google/gemma-2-9b-it";
}

export async function gemmaChat(
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<GemmaChatResult> {
  const started = Date.now();
  const model = modelName();
  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiKey = process.env.GEMMA_API_KEY;
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 256,
      temperature: opts.temperature ?? 0,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemma ${res.status}: ${body.slice(0, 400)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  return { content, latencyMs: Date.now() - started, model };
}
