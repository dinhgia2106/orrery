/// <reference types="node" />
// Model providers for the benchmark, over plain fetch (no SDKs). Keys and credentials come from environment
// variables only; nothing is written to disk. A model is named "provider:model", e.g. "vertex:gemini-2.5-pro",
// "gemini:gemini-2.5-flash", "openai:gpt-5", "anthropic:claude-sonnet-4-5", or any OpenAI-compatible endpoint
// (Qwen through DashScope or OpenRouter, a local Ollama/vLLM) with OPENAI_BASE_URL.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Msg =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: ToolCall[]; raw?: unknown }
  | { role: 'tool'; results: { id: string; name: string; text: string }[] };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Turn {
  text: string;
  calls: ToolCall[];
  /** The provider's own message, replayed verbatim (Gemini thought signatures, Anthropic blocks). */
  raw?: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

export interface Provider {
  id: string;
  complete(system: string, history: Msg[], tools: ToolSpec[]): Promise<Turn>;
}

export interface ProviderOptions {
  maxTokens?: number;
  temperature?: number;
}

const env = (name: string) => process.env[name]?.trim() || undefined;
const need = (name: string, why: string) => {
  const v = env(name);
  if (!v) throw new Error(`${name} is not set (${why})`);
  return v;
};

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    // rate limits and overloads: back off and retry a few times
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    throw new Error(`${res.status} from ${new URL(url).host}: ${text.slice(0, 600)}`);
  }
}

let callSeq = 0;
/** Ids made up here, for providers that do not give their calls one. */
const GEN = 'gen_';
const newId = () => `${GEN}${++callSeq}`;

// ───────── Gemini (Vertex AI and Google AI Studio) ─────────

/** Gemini takes an OpenAPI subset of JSON Schema: one type per property, no exclusiveMinimum. */
export function geminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === 'type' && Array.isArray(v)) out.type = v.includes('string') ? 'string' : v[0];
    else if (k === 'exclusiveMinimum') out.minimum = v;
    else if (k === 'const' || k === '$schema' || k === 'additionalProperties') continue;
    else out[k] = geminiSchema(v);
  }
  if (out.enum && !out.type) out.type = 'string';
  return out;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id?: string;
}

let saToken: { token: string; exp: number } | null = null;

/** An OAuth access token from a service-account key file (GOOGLE_APPLICATION_CREDENTIALS), signed locally. */
async function serviceAccountToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (saToken && saToken.exp - 60 > now) return saToken.token;
  const b64 = (x: object | Buffer) => (Buffer.isBuffer(x) ? x : Buffer.from(JSON.stringify(x))).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: sa.token_uri, iat: now, exp: now + 3600 })}`;
  const jwt = `${unsigned}.${b64(createSign('RSA-SHA256').update(unsigned).sign(sa.private_key))}`;
  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!body.access_token) throw new Error(`service-account token: ${body.error_description ?? res.status}`);
  saToken = { token: body.access_token, exp: now + (body.expires_in ?? 3600) };
  return saToken.token;
}

/** URL and auth headers for a Gemini model on Vertex AI or AI Studio. */
async function geminiEndpoint(kind: 'vertex' | 'gemini', model: string): Promise<{ url: string; headers: Record<string, string> }> {
  if (kind === 'gemini') {
    return { url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, headers: { 'x-goog-api-key': need('GEMINI_API_KEY', 'Google AI Studio key') } };
  }
  const credFile = env('GOOGLE_APPLICATION_CREDENTIALS');
  const sa = credFile ? (JSON.parse(readFileSync(credFile, 'utf8')) as ServiceAccount) : null;
  const project = env('VERTEX_PROJECT') ?? env('GOOGLE_CLOUD_PROJECT') ?? sa?.project_id;
  const location = env('VERTEX_LOCATION') ?? env('GOOGLE_CLOUD_LOCATION') ?? 'global';
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  const apiKey = env('VERTEX_API_KEY');
  const token = env('VERTEX_ACCESS_TOKEN') ?? (sa ? await serviceAccountToken(sa) : undefined);
  if (!token && !apiKey) throw new Error('Vertex needs VERTEX_API_KEY, VERTEX_ACCESS_TOKEN or GOOGLE_APPLICATION_CREDENTIALS (service-account key file)');
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : { 'x-goog-api-key': apiKey! };
  const path = project ? `v1/projects/${project}/locations/${location}/publishers/google/models/${model}` : `v1/publishers/google/models/${model}`;
  return { url: `https://${host}/${path}:generateContent`, headers };
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: unknown;
}

function geminiProvider(kind: 'vertex' | 'gemini', model: string, o: ProviderOptions): Provider {
  return {
    id: `${kind}:${model}`,
    async complete(system, history, tools) {
      const contents = history.map((m) => {
        if (m.role === 'user') return { role: 'user', parts: [{ text: m.text }] };
        if (m.role === 'assistant')
          return (m.raw as object) ?? { role: 'model', parts: [...(m.text ? [{ text: m.text }] : []), ...m.calls.map((c) => ({ functionCall: { name: c.name, args: c.args } }))] };
        return { role: 'user', parts: m.results.map((r) => ({ functionResponse: { ...(r.id.startsWith(GEN) ? {} : { id: r.id }), name: r.name, response: { result: r.text } } })) };
      });
      const { url, headers } = await geminiEndpoint(kind, model);
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }],
        generationConfig: { maxOutputTokens: o.maxTokens ?? 32768, ...(o.temperature !== undefined ? { temperature: o.temperature } : {}) },
      };
      const res = (await post(url, headers, body)) as {
        candidates?: { content?: { role: string; parts?: GeminiPart[] }; finishReason?: string }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
      };
      const cand = res.candidates?.[0];
      const parts = cand?.content?.parts ?? [];
      const u = res.usageMetadata ?? {};
      return {
        text: parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('') || (parts.length ? '' : `(no content: ${cand?.finishReason ?? 'empty response'})`),
        calls: parts.filter((p) => p.functionCall).map((p) => ({ id: p.functionCall!.id ?? newId(), name: p.functionCall!.name, args: p.functionCall!.args ?? {} })),
        raw: cand?.content?.parts?.length ? cand.content : undefined,
        usage: { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) },
      };
    },
  };
}

// ───────── OpenAI-compatible chat completions ─────────

function openaiProvider(model: string, o: ProviderOptions): Provider {
  const base = (env('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  return {
    id: `openai:${model}`,
    async complete(system, history, tools) {
      const messages: unknown[] = [{ role: 'system', content: system }];
      for (const m of history) {
        if (m.role === 'user') messages.push({ role: 'user', content: m.text });
        else if (m.role === 'assistant')
          messages.push({
            role: 'assistant',
            content: m.text || null,
            ...(m.calls.length ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
          });
        else for (const r of m.results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.text });
      }
      const res = (await post(`${base}/chat/completions`, { authorization: `Bearer ${need('OPENAI_API_KEY', 'key for the OpenAI-compatible endpoint')}` }, {
        model,
        messages,
        tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        ...(o.maxTokens ? { max_completion_tokens: o.maxTokens } : {}),
        ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
      })) as {
        choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const msg = res.choices?.[0]?.message ?? {};
      return {
        text: msg.content ?? '',
        calls: (msg.tool_calls ?? []).map((c) => {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(c.function.arguments || '{}');
          } catch {
            args = { __invalidJson: c.function.arguments };
          }
          return { id: c.id, name: c.function.name, args };
        }),
        usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
      };
    },
  };
}

// ───────── Anthropic Messages API ─────────

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function anthropicProvider(model: string, o: ProviderOptions): Provider {
  return {
    id: `anthropic:${model}`,
    async complete(system, history, tools) {
      const messages = history.map((m) => {
        if (m.role === 'user') return { role: 'user', content: m.text };
        if (m.role === 'assistant')
          return {
            role: 'assistant',
            content: (m.raw as AnthropicBlock[]) ?? [...(m.text ? [{ type: 'text', text: m.text }] : []), ...m.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }))],
          };
        return { role: 'user', content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.text })) };
      });
      const res = (await post('https://api.anthropic.com/v1/messages', { 'x-api-key': need('ANTHROPIC_API_KEY', 'Anthropic key'), 'anthropic-version': '2023-06-01' }, {
        model,
        max_tokens: o.maxTokens ?? 16000,
        system,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        messages,
        ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
      })) as { content?: AnthropicBlock[]; usage?: { input_tokens?: number; output_tokens?: number } };
      const blocks = res.content ?? [];
      return {
        text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
        calls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id!, name: b.name!, args: b.input ?? {} })),
        raw: blocks,
        usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
      };
    },
  };
}

/** "provider:model" → a Provider. */
export function providerFor(spec: string, o: ProviderOptions = {}): Provider {
  const i = spec.indexOf(':');
  const [kind, model] = i < 0 ? ['', spec] : [spec.slice(0, i), spec.slice(i + 1)];
  if (!model) throw new Error(`no model in "${spec}"`);
  if (kind === 'vertex' || kind === 'gemini') return geminiProvider(kind, model, o);
  if (kind === 'openai') return openaiProvider(model, o);
  if (kind === 'anthropic') return anthropicProvider(model, o);
  throw new Error(`unknown provider "${kind}" in "${spec}": use vertex:, gemini:, openai: or anthropic:`);
}
