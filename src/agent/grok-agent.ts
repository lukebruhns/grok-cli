import { GrokClient, GrokMessage, GrokToolCall, GrokResponse, SearchOptions, GrokApiError } from "../grok/client.js";
import {
  GROK_TOOLS,
  addMCPToolsToGrokTools,
  getAllGrokTools,
  getMCPManager,
  initializeMCPServers,
} from "../grok/tools.js";
import { loadMCPConfig } from "../mcp/config.js";
import {
  TextEditorTool,
  MorphEditorTool,
  BashTool,
  TodoTool,
  ConfirmationTool,
  SearchTool,
  GlobTool,
  GrepTool,
} from "../tools/index.js";
import { ToolResult } from "../types/index.js";
import { EventEmitter } from "events";
import { createTokenCounter, TokenCounter } from "../utils/token-counter.js";
import { loadCustomInstructions } from "../utils/custom-instructions.js";
import { getSettingsManager } from "../utils/settings-manager.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { logger } from "../utils/logger.js";

export interface ChatEntry {
  type: "user" | "assistant" | "tool_result" | "tool_call";
  content: string;
  timestamp: Date;
  toolCalls?: GrokToolCall[];
  toolCall?: GrokToolCall;
  toolResult?: { success: boolean; output?: string; error?: string };
  isStreaming?: boolean;
}

export interface StreamingChunk {
  type: "content" | "tool_calls" | "tool_result" | "done" | "token_count";
  content?: string;
  toolCalls?: GrokToolCall[];
  toolCall?: GrokToolCall;
  toolResult?: ToolResult;
  tokenCount?: number;
}

export class GrokAgent extends EventEmitter {
  private grokClient: GrokClient;
  private textEditor: TextEditorTool;
  private morphEditor: MorphEditorTool | null;
  private bash: BashTool;
  private todoTool: TodoTool;
  private confirmationTool: ConfirmationTool;
  private search: SearchTool;
  private globTool: GlobTool;
  private grepTool: GrepTool;
  private chatHistory: ChatEntry[] = [];
  private messages: GrokMessage[] = [];
  private tokenCounter: TokenCounter;
  private abortController: AbortController | null = null;
  private mcpInitialized: boolean = false;
  private maxToolRounds: number;

  constructor(
    apiKey: string,
    baseURL?: string,
    model?: string,
    maxToolRounds?: number
  ) {
    super();
    const manager = getSettingsManager();
    const savedModel = manager.getCurrentModel();
    const modelToUse = model || savedModel || "grok-code-fast-1";
    this.maxToolRounds = maxToolRounds || 400;
    this.grokClient = new GrokClient(apiKey, modelToUse, baseURL);
    this.textEditor = new TextEditorTool();
    this.morphEditor = process.env.MORPH_API_KEY ? new MorphEditorTool() : null;
    this.bash = new BashTool();
    this.todoTool = new TodoTool();
    this.confirmationTool = new ConfirmationTool();
    this.search = new SearchTool();
    this.globTool = new GlobTool();
    this.grepTool = new GrepTool();
    this.tokenCounter = createTokenCounter(modelToUse);

    // Initialize MCP servers if configured
    this.initializeMCP();

    // Load custom instructions and build system prompt
    const customInstructions = loadCustomInstructions();

    this.messages.push({
      role: "system",
      content: buildSystemPrompt({
        hasMorphEditor: !!this.morphEditor,
        customInstructions: customInstructions || undefined,
        currentDirectory: process.cwd(),
      }),
    });
  }

  private initializeMCP() {
    if (this.mcpInitialized) return;
    this.mcpInitialized = true;
    Promise.resolve().then(async () => {
      try {
        await initializeMCPServers();
      } catch (error) {
        logger.warn('MCP initialization failed: ' + error);
      }
    });
  }

  private isGrokModel(): boolean {
    return this.getCurrentModel().startsWith('grok');
  }

  private shouldUseSearchFor(message: string): boolean {
    const q = message.toLowerCase();
    const keywords = [
      "today",
      "latest",
      "news",
      "trending",
      "breaking",
      "current",
      "now",
      "recent",
      "x.com",
      "twitter",
      "tweet",
      "what happened",
      "as of",
      "update on",
      "release notes",
      "changelog",
      "price",
      "weather",
    ];
    if (keywords.some((k) => q.includes(k))) return true;
    // crude date pattern (e.g., 2024/2025) may imply recency
    if (/(20\d{2})/.test(q)) return true;
    return false;
  }

  /** Build the SearchOptions to pass to GrokClient based on the user message. */
  private getSearchOptions(message: string): SearchOptions | undefined {
    if (this.isGrokModel() && this.shouldUseSearchFor(message)) {
      return { search_parameters: { mode: "auto" } };
    }
    return undefined;
  }

  /**
   * Sync current directory from bash tool to search, glob, and grep tools.
   * Called after bash executes so that `cd` propagates everywhere.
   */
  private syncCurrentDirectory(): void {
    const dir = this.bash.getCurrentDirectory();
    this.search.setCurrentDirectory(dir);
    this.globTool.setCurrentDirectory(dir);
    this.grepTool.setCurrentDirectory(dir);
  }

  /**
   * Build an AI SDK compatible assistant message from a GrokResponse message.
   * The Vercel AI SDK expects tool calls as structured content parts,
   * not as a separate tool_calls array.
   */
  private buildAssistantMessage(responseMessage: { content: string | null; tool_calls?: GrokToolCall[] }): any {
    const hasToolCalls = responseMessage.tool_calls && responseMessage.tool_calls.length > 0;

    if (!hasToolCalls) {
      return { role: 'assistant', content: responseMessage.content || '' };
    }

    const contentParts: any[] = [];
    if (responseMessage.content) {
      contentParts.push({ type: 'text', text: responseMessage.content });
    }
    for (const tc of responseMessage.tool_calls!) {
      contentParts.push({
        type: 'tool-call',
        toolCallId: tc.id,
        toolName: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    }
    return { role: 'assistant', content: contentParts };
  }

  /**
   * Build an AI SDK compatible tool result message.
   */
  private buildToolResultMessage(toolCall: GrokToolCall, result: ToolResult): any {
    return {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        output: result.success
          ? { type: 'text', value: result.output || 'Success' }
          : { type: 'error-text', value: result.error || 'Error' },
      }],
    };
  }

  async processUserMessage(message: string): Promise<GrokResponse> {
    const tools = await getAllGrokTools();
    this.messages.push({ role: "user", content: message });

    let toolRounds = 0;
    let inputTokens = this.tokenCounter.countMessageTokens(this.messages as any);
    let totalOutputTokens = 0;

    let currentResponse: GrokResponse | null = null;

    while (toolRounds < this.maxToolRounds) {
      currentResponse = await this.grokClient.chat(
        this.messages,
        tools,
        undefined,
        this.getSearchOptions(message)
      );

      const responseMessage = currentResponse.choices[0].message;

      this.messages.push(this.buildAssistantMessage(responseMessage));

      const entry: ChatEntry = {
        type: "assistant",
        content: responseMessage.content || "",
        timestamp: new Date(),
        toolCalls: responseMessage.tool_calls,
      };
      this.chatHistory.push(entry);

      totalOutputTokens += this.tokenCounter.countMessageTokens([responseMessage] as any);

      if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        toolRounds++;

        for (const toolCall of responseMessage.tool_calls) {
          const result = await this.executeTool(toolCall);

          const toolResultEntry: ChatEntry = {
            type: "tool_result",
            content: result.success
              ? result.output || "Success"
              : result.error || "Error occurred",
            timestamp: new Date(),
            toolCall: toolCall,
            toolResult: result,
          };
          this.chatHistory.push(toolResultEntry);

          this.messages.push(this.buildToolResultMessage(toolCall, result));
        }

        inputTokens = this.tokenCounter.countMessageTokens(this.messages as any);
      } else {
        break;
      }
    }

    if (toolRounds >= this.maxToolRounds) {
      const errorEntry: ChatEntry = {
        type: "assistant",
        content: "\n\nMaximum tool execution rounds reached. Stopping to prevent infinite loops.",
        timestamp: new Date(),
      };
      this.chatHistory.push(errorEntry);
    }

    return currentResponse as GrokResponse;
  }

  async *processUserMessageStream(message: string): AsyncGenerator<StreamingChunk, void, unknown> {
    // Create new abort controller for this request
    this.abortController = new AbortController();

    // Add user message to conversation history
    const userEntry: ChatEntry = {
      type: "user",
      content: message,
      timestamp: new Date(),
    };
    this.chatHistory.push(userEntry);
    this.messages.push({ role: "user", content: message });

    // Calculate initial input tokens
    let inputTokens = this.tokenCounter.countMessageTokens(this.messages as any);
    yield { type: "token_count", tokenCount: inputTokens };

    let toolRounds = 0;
    let totalOutputTokens = 0;

    try {
      while (toolRounds < this.maxToolRounds) {
        // Check if operation was cancelled
        if (this.abortController?.signal.aborted) {
          yield { type: "content", content: "\n\n[Operation cancelled by user]" };
          yield { type: "done" };
          return;
        }

        const tools = await getAllGrokTools();
        const stream = this.grokClient.chatStream(
          this.messages,
          tools,
          undefined,
          this.getSearchOptions(message)
        );

        let accumulatedContent = '';
        let accumulatedToolCalls: GrokToolCall[] = [];

        for await (const chunk of stream) {
          // Check for cancellation in the streaming loop
          if (this.abortController?.signal.aborted) {
            yield { type: "content", content: "\n\n[Operation cancelled by user]" };
            yield { type: "done" };
            return;
          }

          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            accumulatedContent += delta.content;
            yield { type: "content", content: delta.content };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              // Each tool call from fullStream is complete, so just collect them
              const existing = accumulatedToolCalls.find(atc => atc.id === tc.id);
              if (existing) {
                existing.function.arguments += tc.function.arguments || '';
              } else {
                accumulatedToolCalls.push({
                  id: tc.id,
                  type: tc.type || 'function',
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments || ''
                  }
                });
              }
            }
          }

          totalOutputTokens += 1;
          yield { type: "token_count", tokenCount: inputTokens + totalOutputTokens };
        }

        // Yield all tool calls at once after stream completes (for UI to show)
        if (accumulatedToolCalls.length > 0) {
          yield { type: "tool_calls", toolCalls: accumulatedToolCalls };
        }

        // Push the assistant message in AI SDK format
        this.messages.push(this.buildAssistantMessage({
          content: accumulatedContent || null,
          tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
        }));

        const entry: ChatEntry = {
          type: "assistant",
          content: accumulatedContent,
          timestamp: new Date(),
          toolCalls: accumulatedToolCalls,
          isStreaming: true,
        };
        this.chatHistory.push(entry);

        if (accumulatedToolCalls.length > 0) {
          toolRounds++;

          for (const toolCall of accumulatedToolCalls) {
            // Check for cancellation before executing each tool
            if (this.abortController?.signal.aborted) {
              yield { type: "content", content: "\n\n[Operation cancelled by user]" };
              yield { type: "done" };
              return;
            }

            const result = await this.executeTool(toolCall);

            const toolResultEntry: ChatEntry = {
              type: "tool_result",
              content: result.success
                ? result.output || "Success"
                : result.error || "Error occurred",
              timestamp: new Date(),
              toolCall: toolCall,
              toolResult: result,
            };
            this.chatHistory.push(toolResultEntry);

            yield { type: "tool_result", toolCall, toolResult: result };

            this.messages.push(this.buildToolResultMessage(toolCall, result));
          }

          // Update token count after processing all tool calls
          inputTokens = this.tokenCounter.countMessageTokens(this.messages as any);
          yield { type: "token_count", tokenCount: inputTokens + totalOutputTokens };
        } else {
          yield { type: "done" };
          return;
        }
      }

      yield { type: "content", content: "\n\nMaximum tool execution rounds reached. Stopping to prevent infinite loops." };
      yield { type: "done" };
    } catch (error: any) {
      // Check if this was a cancellation
      if (this.abortController?.signal.aborted) {
        yield { type: "content", content: "\n\n[Operation cancelled by user]" };
        yield { type: "done" };
        return;
      }

      logger.error('processUserMessageStream failed', error);

      let userMessage: string;
      if (error instanceof GrokApiError) {
        userMessage = `\n\nAPI Error: ${error.info.message}`;
      } else {
        userMessage = `\n\nSorry, I encountered an error: ${error.message}`;
      }

      const errorEntry: ChatEntry = {
        type: "assistant",
        content: userMessage,
        timestamp: new Date(),
      };
      this.chatHistory.push(errorEntry);
      yield { type: "content", content: errorEntry.content };
      yield { type: "done" };
    } finally {
      // Clean up abort controller
      this.abortController = null;
    }
  }

  private async executeTool(toolCall: GrokToolCall): Promise<ToolResult> {
    try {
      const args = JSON.parse(toolCall.function.arguments);

      switch (toolCall.function.name) {
        case "view_file": {
          const range: [number, number] | undefined = args.start_line && args.end_line ? [args.start_line, args.end_line] : undefined;
          return await this.textEditor.view(args.path, range, args.offset, args.limit);
        }

        case "write_file":
          return await this.textEditor.write(args.path, args.content);

        case "create_file":
          // Backward compatibility: route to write
          return await this.textEditor.write(args.path, args.content);

        case "str_replace_editor":
          return await this.textEditor.strReplace(args.path, args.old_str, args.new_str, args.replace_all);

        case "edit_file":
          if (!this.morphEditor) {
            return {
              success: false,
              error: "Morph Fast Apply not available. Please set MORPH_API_KEY environment variable to use this feature.",
            };
          }
          return await this.morphEditor.editFile(args.target_file, args.instructions, args.code_edit);

        case "bash": {
          const timeout = args.timeout ? Math.min(args.timeout, 600000) : undefined;
          const result = await this.bash.execute(args.command, timeout);
          // Sync directory after bash in case of `cd`
          this.syncCurrentDirectory();
          return result;
        }

        case "glob":
          return await this.globTool.execute(args.pattern, args.path);

        case "grep":
          return await this.grepTool.execute({
            pattern: args.pattern,
            path: args.path,
            outputMode: args.output_mode,
            glob: args.glob,
            type: args.type,
            caseSensitive: args.case_sensitive,
            contextLines: args.context_lines,
          });

        case "create_todo_list":
          return await this.todoTool.createTodoList(args.todos);

        case "update_todo_list":
          return await this.todoTool.updateTodoList(args.updates);

        case "search":
          return await this.search.search(args.query, {
            searchType: args.search_type,
            includePattern: args.include_pattern,
            excludePattern: args.exclude_pattern,
            caseSensitive: args.case_sensitive,
            wholeWord: args.whole_word,
            regex: args.regex,
            maxResults: args.max_results,
            fileTypes: args.file_types,
            includeHidden: args.include_hidden,
          });

        default:
          if (toolCall.function.name.startsWith("mcp__")) {
            return await this.executeMCPTool(toolCall);
          }

          return {
            success: false,
            error: `Unknown tool: ${toolCall.function.name}`,
          };
      }
    } catch (error: any) {
      logger.error(`executeTool(${toolCall.function.name}) failed`, error);
      return {
        success: false,
        error: `Tool execution error: ${error.message}`,
      };
    }
  }

  private async executeMCPTool(toolCall: GrokToolCall): Promise<ToolResult> {
    try {
      const args = JSON.parse(toolCall.function.arguments);
      const mcpManager = getMCPManager();

      const result = await mcpManager.callTool(toolCall.function.name, args);

      if (result.isError) {
        return {
          success: false,
          error: (result.content[0] as any)?.text || "MCP tool error",
        };
      }

      const output = result.content
        .map((item) => {
          if (item.type === "text") {
            return item.text;
          } else if (item.type === "resource") {
            return `Resource: ${item.resource?.uri || "Unknown"}`;
          }
          return String(item);
        })
        .join("\n");

      return {
        success: true,
        output: output || "Success",
      };
    } catch (error: any) {
      return {
        success: false,
        error: `MCP tool execution error: ${error.message}`,
      };
    }
  }

  getChatHistory(): ChatEntry[] {
    return [...this.chatHistory];
  }

  getCurrentDirectory(): string {
    return this.bash.getCurrentDirectory();
  }

  async executeBashCommand(command: string): Promise<ToolResult> {
    return await this.bash.execute(command);
  }

  getCurrentModel(): string {
    return this.grokClient.getCurrentModel();
  }

  setModel(model: string): void {
    this.grokClient.setModel(model);
    this.tokenCounter.dispose();
    this.tokenCounter = createTokenCounter(model);
  }

  abortCurrentOperation(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
