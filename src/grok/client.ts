import { xai, createXai } from '@ai-sdk/xai';
import { generateText, streamText, jsonSchema } from 'ai';
import { logger } from '../utils/logger.js';

export type GrokMessage = { role: string; content: any; tool_call_id?: string };

export interface GrokTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required: string[];
    };
  };
}

export interface GrokToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface SearchParameters {
  mode?: "auto" | "on" | "off";
}

export interface SearchOptions {
  search_parameters?: SearchParameters;
}

export interface GrokResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: GrokToolCall[];
    };
    finish_reason: string;
  }>;
}

/** Classifies an error into a user-friendly category. */
export interface ApiErrorInfo {
  status: number | null;
  code: string;       // 'rate_limit' | 'auth' | 'server' | 'timeout' | 'malformed' | 'network' | 'unknown'
  message: string;    // user-facing message
  retryable: boolean;
}

/**
 * Classifies API errors based on the xAI API error codes.
 * See: https://docs.x.ai/docs/key-information/debugging
 *
 * Status codes handled:
 *   400 — Bad request (invalid body/params, or incorrect API key)
 *   401 — Missing or invalid authorization header/token
 *   403 — Insufficient permissions, or API key/team is blocked
 *   404 — Model not found or invalid endpoint URL
 *   415 — Empty body or missing Content-Type header
 *   422 — Invalid field format in request body
 *   429 — Rate limit exceeded (retryable with backoff)
 *   5xx — Server errors (retryable)
 */
function classifyError(error: any): ApiErrorInfo {
  const msg = error?.message ?? String(error);
  const status: number | null = error?.status ?? error?.statusCode ?? error?.response?.status ?? null;

  // Timeout / abort
  if (error?.name === 'AbortError' || error?.code === 'ECONNABORTED' || msg.includes('timeout') || msg.includes('Timeout')) {
    return { status: null, code: 'timeout', message: 'Request timed out. Please try again.', retryable: true };
  }

  // Network errors (no response received)
  if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND' || error?.code === 'ECONNRESET' || msg.includes('fetch failed') || msg.includes('network') || msg.includes('bad port') || msg.includes('Cannot connect')) {
    return { status: null, code: 'network', message: 'Network error — could not reach the Grok API. Check your internet connection and base URL.', retryable: true };
  }

  // HTTP status based classification (aligned with xAI API docs)
  if (status === 400) {
    return { status, code: 'bad_request', message: 'Bad request (400). Check your request parameters. This can also indicate an incorrect API key — verify your key at https://console.x.ai.', retryable: false };
  }
  if (status === 401) {
    return { status, code: 'auth', message: 'Authentication failed (401). Your API key is invalid or expired. Update it in ~/.grok/user-settings.json or set the GROK_API_KEY environment variable. Get a new key at https://console.x.ai.', retryable: false };
  }
  if (status === 403) {
    return { status, code: 'auth', message: 'Access denied (403). Your API key does not have permission, or your account may be blocked. Contact your team admin or check https://console.x.ai.', retryable: false };
  }
  if (status === 404) {
    return { status, code: 'not_found', message: 'Not found (404). The specified model may not exist or the API endpoint URL is incorrect. Check the model name and API base URL.', retryable: false };
  }
  if (status === 429) {
    return { status, code: 'rate_limit', message: 'Rate limited (429). Retrying automatically with backoff... To request higher limits, email support@x.ai.', retryable: true };
  }
  if (status !== null && status >= 500) {
    return { status, code: 'server', message: `Grok API server error (${status}). The service may be temporarily unavailable. Check https://status.x.ai for updates.`, retryable: true };
  }

  // Malformed / JSON parse errors
  if (msg.includes('JSON') || msg.includes('Unexpected token') || msg.includes('parse')) {
    return { status, code: 'malformed', message: 'Received a malformed response from the Grok API.', retryable: true };
  }

  return { status, code: 'unknown', message: msg, retryable: false };
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class GrokClient {
  private currentModel: string = "grok-code-fast-1";
  private defaultMaxTokens: number;
  private baseURL: string | undefined;

  constructor(apiKey: string, model?: string, baseURL?: string) {
    process.env.XAI_API_KEY = apiKey;
    this.baseURL = baseURL || process.env.GROK_BASE_URL || undefined;
    const envMax = Number(process.env.GROK_MAX_TOKENS);
    this.defaultMaxTokens = Number.isFinite(envMax) && envMax > 0 ? envMax : 16384;
    if (model) this.currentModel = model;
  }

  /** Return the appropriate xai provider, using custom baseURL when configured. */
  private getProvider() {
    if (this.baseURL) {
      return createXai({ baseURL: this.baseURL });
    }
    return xai;
  }

  setModel(model: string): void {
    this.currentModel = model;
  }

  getCurrentModel(): string {
    return this.currentModel;
  }

  async chat(
    messages: any[],
    tools?: any,
    model?: string,
    searchOptions?: SearchOptions
  ): Promise<GrokResponse> {
    const modelId = model || this.currentModel;
    const endpoint = this.baseURL || 'https://api.x.ai/v1';

    logger.logApiRequest('POST', `${endpoint}/chat (model=${modelId})`, { messageCount: messages.length, hasTools: !!tools?.length });

    let lastError: any;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const convertedTools = this.convertTools(tools);
        const hasTools = convertedTools && Object.keys(convertedTools).length > 0;
        const provider = this.getProvider();

        const response = await generateText({
          model: provider(modelId),
          messages,
          tools: hasTools ? convertedTools : undefined,
          toolChoice: hasTools ? "auto" : undefined,
          temperature: 0.7,
          maxOutputTokens: this.defaultMaxTokens,
          providerOptions: searchOptions?.search_parameters
            ? { xai: { searchParameters: searchOptions.search_parameters } as any }
            : undefined,
        });

        logger.logApiResponse(200, { finishReason: response.finishReason, hasToolCalls: !!(response.toolCalls?.length) });

        return {
          choices: [{
            message: {
              role: 'assistant',
              content: response.text || null,
              tool_calls: this.convertToolCalls(response.toolCalls) || undefined
            },
            finish_reason: response.finishReason || 'stop'
          }]
        };
      } catch (error: any) {
        lastError = error;
        const info = classifyError(error);
        logger.logApiError('POST', `${endpoint}/chat (model=${modelId})`, info.status ?? info.code, error?.message);
        logger.error('GrokClient.chat failed', error);

        if (info.retryable && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
          logger.info(`Retrying chat() in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES}) — ${info.code}`);
          await sleep(delay);
          continue;
        }

        throw new GrokApiError(info);
      }
    }

    // Should not reach here, but just in case
    throw new GrokApiError(classifyError(lastError));
  }

  async *chatStream(
    messages: any[],
    tools?: any,
    model?: string,
    searchOptions?: SearchOptions
  ): AsyncGenerator<any, void, unknown> {
    const modelId = model || this.currentModel;
    const endpoint = this.baseURL || 'https://api.x.ai/v1';

    logger.logApiRequest('POST', `${endpoint}/chat/stream (model=${modelId})`, { messageCount: messages.length, hasTools: !!tools?.length });

    let lastError: any;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const convertedTools = this.convertTools(tools);
        const hasTools = convertedTools && Object.keys(convertedTools).length > 0;
        const provider = this.getProvider();

        const stream = streamText({
          model: provider(modelId),
          messages,
          tools: hasTools ? convertedTools : undefined,
          toolChoice: hasTools ? "auto" : undefined,
          temperature: 0.7,
          maxOutputTokens: this.defaultMaxTokens,
          providerOptions: searchOptions?.search_parameters
            ? { xai: { searchParameters: searchOptions.search_parameters } as any }
            : undefined,
        });

        for await (const chunk of stream.fullStream) {
          if (chunk.type === 'text-delta') {
            yield { choices: [{ delta: { content: (chunk as any).text } }] };
          } else if (chunk.type === 'tool-call') {
            yield {
              choices: [{
                delta: {
                  tool_calls: [{
                    id: chunk.toolCallId,
                    type: 'function',
                    function: {
                      name: chunk.toolName,
                      arguments: JSON.stringify(chunk.input)
                    }
                  }]
                }
              }]
            };
          }
        }

        logger.logApiResponse(200, { stream: true });
        return; // successful stream — done
      } catch (error: any) {
        lastError = error;
        const info = classifyError(error);
        logger.logApiError('POST', `${endpoint}/chat/stream (model=${modelId})`, info.status ?? info.code, error?.message);
        logger.error('GrokClient.chatStream failed', error);

        if (info.retryable && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
          logger.info(`Retrying chatStream() in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES}) — ${info.code}`);
          await sleep(delay);
          continue;
        }

        throw new GrokApiError(info);
      }
    }

    throw new GrokApiError(classifyError(lastError));
  }

  async search(query: string, searchParameters?: SearchParameters): Promise<GrokResponse> {
    const searchMessage: GrokMessage = { role: "user", content: query };
    const searchOptions: SearchOptions = {
      search_parameters: searchParameters || { mode: "on" },
    };
    return this.chat([searchMessage], [], undefined, searchOptions);
  }

  private convertTools(tools?: GrokTool[]): Record<string, any> {
    if (!tools || tools.length === 0) return {};
    const result: Record<string, any> = {};
    for (const tool of tools) {
      result[tool.function.name] = {
        description: tool.function.description,
        inputSchema: jsonSchema(tool.function.parameters),
      };
    }
    return result;
  }

  private convertToolCalls(toolCalls?: any[]): GrokToolCall[] {
    if (!toolCalls || toolCalls.length === 0) return [];
    return toolCalls.map(tc => ({
      id: tc.toolCallId || tc.id || `call_${Date.now()}`,
      type: 'function' as const,
      function: {
        name: tc.toolName || tc.name,
        arguments: typeof tc.input === 'string'
          ? tc.input
          : JSON.stringify(tc.input ?? {})
      }
    }));
  }
}

/** Custom error class that carries structured API error info. */
export class GrokApiError extends Error {
  public readonly info: ApiErrorInfo;

  constructor(info: ApiErrorInfo) {
    super(info.message);
    this.name = 'GrokApiError';
    this.info = info;
  }
}
