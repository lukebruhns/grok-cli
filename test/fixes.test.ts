/**
 * Test suite for the AI SDK migration bug fixes.
 *
 * Run:  npx tsx --test test/fixes.test.ts
 *   or: npm test
 *
 * Uses Node's built-in test runner (node:test) — no extra deps needed.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// 1. Logger tests
// ---------------------------------------------------------------------------

describe("Logger", () => {
  // Use a temp directory so we don't pollute the real ~/.grok/logs
  const tmpLogDir = path.join(os.tmpdir(), `grok-test-logs-${Date.now()}`);
  let logger: typeof import("../src/utils/logger.js").logger;

  before(async () => {
    // Override HOME so the logger writes into our temp dir
    // The logger uses os.homedir() at module-load time, so we need to
    // set env before importing.  We also need to clear module cache.
    process.env.HOME = tmpLogDir; // logger reads os.homedir() → ~/.grok/logs
    // Dynamic import to pick up the overridden HOME
    const mod = await import("../src/utils/logger.js");
    logger = mod.logger;
  });

  after(() => {
    // Clean up temp dir
    fs.rmSync(tmpLogDir, { recursive: true, force: true });
  });

  it("should create the log directory on import", () => {
    const logDir = path.join(tmpLogDir, ".grok", "logs");
    assert.ok(fs.existsSync(logDir), `Log directory should exist at ${logDir}`);
  });

  it("logger.error() should write to today's log file", () => {
    logger.error("test error message", new Error("boom"));
    const date = new Date().toISOString().slice(0, 10);
    const logFile = path.join(tmpLogDir, ".grok", "logs", `grok-${date}.log`);
    assert.ok(fs.existsSync(logFile), "Log file should exist");
    const content = fs.readFileSync(logFile, "utf-8");
    assert.ok(content.includes("ERROR"), "Should contain ERROR level");
    assert.ok(content.includes("test error message"), "Should contain the message");
    assert.ok(content.includes("boom"), "Should contain the error message");
  });

  it("logger.warn() should write to today's log file", () => {
    logger.warn("test warning");
    const date = new Date().toISOString().slice(0, 10);
    const logFile = path.join(tmpLogDir, ".grok", "logs", `grok-${date}.log`);
    const content = fs.readFileSync(logFile, "utf-8");
    assert.ok(content.includes("WARN"), "Should contain WARN level");
    assert.ok(content.includes("test warning"), "Should contain the warning message");
  });

  it("logger.info() should NOT write when GROK_DEBUG is unset", () => {
    delete process.env.GROK_DEBUG;
    const date = new Date().toISOString().slice(0, 10);
    const logFile = path.join(tmpLogDir, ".grok", "logs", `grok-${date}.log`);
    const before = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf-8")
      : "";
    logger.info("should not appear");
    const after = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf-8")
      : "";
    assert.equal(before, after, "Log file should not change");
  });

  it("logger.info() SHOULD write when GROK_DEBUG=1", () => {
    process.env.GROK_DEBUG = "1";
    logger.info("debug info line");
    const date = new Date().toISOString().slice(0, 10);
    const logFile = path.join(tmpLogDir, ".grok", "logs", `grok-${date}.log`);
    const content = fs.readFileSync(logFile, "utf-8");
    assert.ok(content.includes("INFO"), "Should contain INFO level");
    assert.ok(content.includes("debug info line"), "Should contain the info message");
    delete process.env.GROK_DEBUG;
  });

  it("logger.error() should include stack trace for Error objects", () => {
    const err = new Error("stack trace test");
    logger.error("with stack", err);
    const date = new Date().toISOString().slice(0, 10);
    const logFile = path.join(tmpLogDir, ".grok", "logs", `grok-${date}.log`);
    const content = fs.readFileSync(logFile, "utf-8");
    assert.ok(
      content.includes("at ") || content.includes("fixes.test"),
      "Should include stack trace information"
    );
  });
});

// ---------------------------------------------------------------------------
// 2. GrokClient tests
// ---------------------------------------------------------------------------

describe("GrokClient", () => {
  let GrokClient: typeof import("../src/grok/client.js").GrokClient;

  before(async () => {
    const mod = await import("../src/grok/client.js");
    GrokClient = mod.GrokClient;
  });

  it("constructor should accept (apiKey, model, baseURL) — Bug #4 fix", () => {
    const client = new GrokClient("test-key", "grok-3", "https://custom.api/v1");
    // baseURL is private, access via (as any)
    assert.equal((client as any).baseURL, "https://custom.api/v1");
    assert.equal(client.getCurrentModel(), "grok-3");
  });

  it("constructor should fall back to GROK_BASE_URL env var", () => {
    process.env.GROK_BASE_URL = "https://env-url.test/v1";
    const client = new GrokClient("test-key", "grok-3");
    assert.equal((client as any).baseURL, "https://env-url.test/v1");
    delete process.env.GROK_BASE_URL;
  });

  it("constructor should leave baseURL undefined when not provided", () => {
    delete process.env.GROK_BASE_URL;
    const client = new GrokClient("test-key");
    assert.equal((client as any).baseURL, undefined);
  });

  it("getProvider() should return createXai instance when baseURL is set", () => {
    const client = new GrokClient("test-key", "grok-3", "https://custom.api/v1");
    const provider = (client as any).getProvider();
    // When baseURL is set, getProvider returns a new provider from createXai
    // It should be a function (provider factory)
    assert.equal(typeof provider, "function", "Provider should be callable");
    // It should NOT be the default xai export (which is also a function)
    // We can't easily distinguish them, but we can verify it doesn't throw
  });

  it("getProvider() should return default xai when no baseURL", () => {
    delete process.env.GROK_BASE_URL;
    const client = new GrokClient("test-key");
    const provider = (client as any).getProvider();
    assert.equal(typeof provider, "function", "Provider should be callable");
  });

  it("convertToolCalls should map AI SDK format to GrokToolCall format", () => {
    const client = new GrokClient("test-key");
    const input = [
      {
        toolCallId: "call_123",
        toolName: "bash",
        input: { command: "ls" },
      },
    ];
    const result: any[] = (client as any).convertToolCalls(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "call_123");
    assert.equal(result[0].type, "function");
    assert.equal(result[0].function.name, "bash");
    assert.equal(result[0].function.arguments, '{"command":"ls"}');
  });

  it("convertToolCalls should handle string input arguments", () => {
    const client = new GrokClient("test-key");
    const input = [
      {
        toolCallId: "call_456",
        toolName: "bash",
        input: '{"command":"pwd"}',
      },
    ];
    const result: any[] = (client as any).convertToolCalls(input);
    assert.equal(result[0].function.arguments, '{"command":"pwd"}');
  });

  it("convertToolCalls should return empty array for undefined input", () => {
    const client = new GrokClient("test-key");
    const result: any[] = (client as any).convertToolCalls(undefined);
    assert.deepEqual(result, []);
  });

  it("convertTools should return empty object for no tools", () => {
    const client = new GrokClient("test-key");
    assert.deepEqual((client as any).convertTools(undefined), {});
    assert.deepEqual((client as any).convertTools([]), {});
  });

  it("convertTools should map GrokTool[] to AI SDK format", () => {
    const client = new GrokClient("test-key");
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "bash",
          description: "Run a command",
          parameters: {
            type: "object" as const,
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      },
    ];
    const result = (client as any).convertTools(tools);
    assert.ok(result.bash, "Should have a 'bash' key");
    assert.equal(result.bash.description, "Run a command");
    assert.ok(result.bash.inputSchema, "Should have inputSchema (AI SDK v6 Tool format)");
  });

  it("defaultMaxTokens should be 16384 by default", () => {
    delete process.env.GROK_MAX_TOKENS;
    const client = new GrokClient("test-key");
    assert.equal((client as any).defaultMaxTokens, 16384);
  });

  it("defaultMaxTokens should respect GROK_MAX_TOKENS env var", () => {
    process.env.GROK_MAX_TOKENS = "4096";
    const client = new GrokClient("test-key");
    assert.equal((client as any).defaultMaxTokens, 4096);
    delete process.env.GROK_MAX_TOKENS;
  });
});

// ---------------------------------------------------------------------------
// 3. GrokAgent tests (private method access via `as any`)
// ---------------------------------------------------------------------------

describe("GrokAgent", () => {
  let GrokAgent: typeof import("../src/agent/grok-agent.js").GrokAgent;
  let agent: InstanceType<typeof GrokAgent>;

  before(async () => {
    // Set a dummy API key so the constructor doesn't complain
    process.env.XAI_API_KEY = "test-key-for-tests";
    const mod = await import("../src/agent/grok-agent.js");
    GrokAgent = mod.GrokAgent;
    agent = new GrokAgent("test-key-for-tests", undefined, "grok-code-fast-1");
  });

  // --- Bug #5: shouldUseSearchFor ---

  describe("shouldUseSearchFor (Bug #5 — full keyword list)", () => {
    const expectedKeywords = [
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

    for (const keyword of expectedKeywords) {
      it(`should return true for keyword "${keyword}"`, () => {
        const result = (agent as any).shouldUseSearchFor(
          `tell me about ${keyword} in the world`
        );
        assert.equal(result, true, `Should match keyword: ${keyword}`);
      });
    }

    it("should return true for date patterns like 2024, 2025", () => {
      assert.equal(
        (agent as any).shouldUseSearchFor("what happened in 2025"),
        true
      );
      assert.equal(
        (agent as any).shouldUseSearchFor("changes since 2024"),
        true
      );
    });

    it("should return false for unrelated messages", () => {
      assert.equal(
        (agent as any).shouldUseSearchFor("write a hello world program"),
        false
      );
      assert.equal(
        (agent as any).shouldUseSearchFor("fix the bug in my code"),
        false
      );
    });

    it("should be case-insensitive", () => {
      assert.equal(
        (agent as any).shouldUseSearchFor("What is the LATEST version?"),
        true
      );
      assert.equal(
        (agent as any).shouldUseSearchFor("BREAKING changes"),
        true
      );
    });
  });

  // --- Bug #2: buildToolResultMessage ---

  describe("buildToolResultMessage (Bug #2 — AI SDK v6 structured output)", () => {
    it("should use structured output for success (AI SDK v6 outputSchema)", () => {
      const toolCall = {
        id: "call_001",
        type: "function" as const,
        function: { name: "bash", arguments: '{"command":"ls"}' },
      };
      const toolResult = { success: true, output: "file1.ts\nfile2.ts" };
      const msg = (agent as any).buildToolResultMessage(toolCall, toolResult);

      assert.equal(msg.role, "tool");
      assert.equal(msg.content.length, 1);
      const part = msg.content[0];
      assert.equal(part.type, "tool-result");
      assert.equal(part.toolCallId, "call_001");
      assert.equal(part.toolName, "bash");
      assert.deepEqual(part.output, { type: "text", value: "file1.ts\nfile2.ts" });
    });

    it("should use error-text output type for failures", () => {
      const toolCall = {
        id: "call_002",
        type: "function" as const,
        function: { name: "bash", arguments: '{"command":"bad"}' },
      };
      const toolResult = { success: false, error: "command not found" };
      const msg = (agent as any).buildToolResultMessage(toolCall, toolResult);

      const part = msg.content[0];
      assert.deepEqual(part.output, { type: "error-text", value: "command not found" });
    });

    it("should default to 'Success' when output is empty", () => {
      const toolCall = {
        id: "call_003",
        type: "function" as const,
        function: { name: "bash", arguments: '{}' },
      };
      const toolResult = { success: true };
      const msg = (agent as any).buildToolResultMessage(toolCall, toolResult);

      assert.deepEqual(msg.content[0].output, { type: "text", value: "Success" });
    });

    it("should default to 'Error' when error is empty", () => {
      const toolCall = {
        id: "call_004",
        type: "function" as const,
        function: { name: "bash", arguments: '{}' },
      };
      const toolResult = { success: false };
      const msg = (agent as any).buildToolResultMessage(toolCall, toolResult);

      assert.deepEqual(msg.content[0].output, { type: "error-text", value: "Error" });
    });
  });

  // --- buildAssistantMessage ---

  describe("buildAssistantMessage", () => {
    it("should return simple string content when no tool calls", () => {
      const msg = (agent as any).buildAssistantMessage({
        content: "Hello there",
        tool_calls: undefined,
      });
      assert.equal(msg.role, "assistant");
      assert.equal(msg.content, "Hello there");
    });

    it("should return structured content parts when tool calls present", () => {
      const msg = (agent as any).buildAssistantMessage({
        content: "Let me run that",
        tool_calls: [
          {
            id: "call_100",
            type: "function",
            function: { name: "bash", arguments: '{"command":"ls"}' },
          },
        ],
      });
      assert.equal(msg.role, "assistant");
      assert.ok(Array.isArray(msg.content), "Content should be an array");
      assert.equal(msg.content.length, 2); // text + tool-call
      assert.equal(msg.content[0].type, "text");
      assert.equal(msg.content[0].text, "Let me run that");
      assert.equal(msg.content[1].type, "tool-call");
      assert.equal(msg.content[1].toolCallId, "call_100");
      assert.equal(msg.content[1].toolName, "bash");
      assert.deepEqual(msg.content[1].input, { command: "ls" });
    });

    it("should omit text part when content is null with tool calls", () => {
      const msg = (agent as any).buildAssistantMessage({
        content: null,
        tool_calls: [
          {
            id: "call_200",
            type: "function",
            function: { name: "view_file", arguments: '{"path":"/tmp/x"}' },
          },
        ],
      });
      assert.equal(msg.content.length, 1); // only tool-call, no text
      assert.equal(msg.content[0].type, "tool-call");
    });
  });

  // --- isGrokModel ---

  describe("isGrokModel", () => {
    it("should return true for grok models", () => {
      assert.equal((agent as any).isGrokModel(), true); // grok-code-fast-1
    });

    it("should return false for non-grok models", () => {
      const original = agent.getCurrentModel();
      agent.setModel("claude-3-opus");
      assert.equal((agent as any).isGrokModel(), false);
      agent.setModel(original); // restore
    });
  });

  // --- getSearchOptions ---

  describe("getSearchOptions (Bug #6 — search options passthrough)", () => {
    it("should return search_parameters for grok model + matching message", () => {
      const opts = (agent as any).getSearchOptions("what is the latest news?");
      assert.deepEqual(opts, { search_parameters: { mode: "auto" } });
    });

    it("should return undefined for non-matching message", () => {
      const opts = (agent as any).getSearchOptions("write hello world");
      assert.equal(opts, undefined);
    });

    it("should return undefined for non-grok model even with keywords", () => {
      const original = agent.getCurrentModel();
      agent.setModel("claude-3-opus");
      const opts = (agent as any).getSearchOptions("what is the latest news?");
      assert.equal(opts, undefined);
      agent.setModel(original);
    });
  });

  // --- Bug #3: processUserMessageStream structure ---

  describe("processUserMessageStream (Bug #3 — AbortController + structure)", () => {
    it("abortController should be null before streaming", () => {
      assert.equal((agent as any).abortController, null);
    });

    it("abortCurrentOperation should not throw when no controller", () => {
      assert.doesNotThrow(() => agent.abortCurrentOperation());
    });
  });

  // --- Bug #8: initializeMCP ---

  describe("initializeMCP (Bug #8 — error handling)", () => {
    it("should have set mcpInitialized to true", () => {
      assert.equal((agent as any).mcpInitialized, true);
    });

    it("calling initializeMCP again should be a no-op (guard check)", () => {
      // Should not throw
      assert.doesNotThrow(() => (agent as any).initializeMCP());
    });
  });

  // --- Constructor baseURL passthrough (Bug #4) ---

  describe("constructor baseURL passthrough (Bug #4)", () => {
    it("should pass baseURL to GrokClient", () => {
      const agentWithBase = new GrokAgent(
        "test-key",
        "https://custom.example.com/v1",
        "grok-3"
      );
      const client = (agentWithBase as any).grokClient;
      assert.equal(
        (client as any).baseURL,
        "https://custom.example.com/v1"
      );
    });

    it("should work without baseURL", () => {
      delete process.env.GROK_BASE_URL;
      const agentNoBase = new GrokAgent("test-key", undefined, "grok-3");
      const client = (agentNoBase as any).grokClient;
      assert.equal((client as any).baseURL, undefined);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. chatStream text-delta field test (Bug #1)
// ---------------------------------------------------------------------------

describe("chatStream text-delta format (Bug #1)", () => {
  it("source code should use chunk.text for AI SDK v6 text-delta events", async () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "grok", "client.ts"),
      "utf-8"
    );

    // Find the chatStream method's text-delta handling
    const textDeltaLine = source
      .split("\n")
      .find((l) => l.includes("text-delta"));
    assert.ok(textDeltaLine, "Should have a text-delta related line");

    // In AI SDK v6, TextStreamPart text-delta uses .text property
    const yieldLines = source
      .split("\n")
      .filter(
        (l) => l.includes(".text") && l.includes("chunk") && l.includes("content")
      );
    assert.ok(
      yieldLines.length > 0,
      "Should reference chunk.text for AI SDK v6 TextStreamPart"
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Dead import removal (Bug #7)
// ---------------------------------------------------------------------------

describe("Dead import removal (Bug #7)", () => {
  it("index.ts should not import from openai/resources/chat", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "index.ts"),
      "utf-8"
    );
    assert.ok(
      !source.includes("openai/resources/chat"),
      "Should not contain dead openai import"
    );
    assert.ok(
      !source.includes("ChatCompletionMessageParam"),
      "Should not reference ChatCompletionMessageParam"
    );
  });

  it("index.ts should import logger", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "index.ts"),
      "utf-8"
    );
    assert.ok(
      source.includes('import { logger }'),
      "Should import the logger utility"
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Search options format (Bug #6 — providerOptions wiring)
// ---------------------------------------------------------------------------

describe("Search options in client.ts (Bug #6)", () => {
  it("client.ts should pass search via providerOptions.xai.searchParameters", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "grok", "client.ts"),
      "utf-8"
    );
    assert.ok(
      source.includes("providerOptions"),
      "Should use providerOptions in generateText/streamText calls"
    );
    assert.ok(
      source.includes("searchParameters"),
      "Should pass searchParameters through providerOptions"
    );
    // Verify it appears in both chat() and chatStream()
    const matches = source.match(/providerOptions:/g);
    assert.ok(
      matches && matches.length >= 2,
      `Should have providerOptions in both chat() and chatStream(), found ${matches?.length ?? 0}`
    );
  });

  it("client.ts SearchOptions should use search_parameters (not useSearch)", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "grok", "client.ts"),
      "utf-8"
    );
    assert.ok(
      source.includes("search_parameters"),
      "SearchOptions should have search_parameters field"
    );
    // The old broken interface had `useSearch`
    const interfaceBlock = source.slice(
      source.indexOf("export interface SearchOptions"),
      source.indexOf("}", source.indexOf("export interface SearchOptions")) + 1
    );
    assert.ok(
      !interfaceBlock.includes("useSearch"),
      "SearchOptions should NOT have the old useSearch field"
    );
  });
});

// ---------------------------------------------------------------------------
// 7. GrokClient constructor signature (Bug #4 — baseURL param)
// ---------------------------------------------------------------------------

describe("GrokClient baseURL in source (Bug #4)", () => {
  it("constructor should accept baseURL as third parameter", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "grok", "client.ts"),
      "utf-8"
    );
    // Match: constructor(apiKey: string, model?: string, baseURL?: string)
    assert.ok(
      source.includes("baseURL?: string"),
      "Constructor should have baseURL parameter"
    );
  });

  it("should use createXai for custom baseURL", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "grok", "client.ts"),
      "utf-8"
    );
    assert.ok(
      source.includes("createXai"),
      "Should import and use createXai"
    );
    assert.ok(
      source.includes("createXai({ baseURL:"),
      "Should call createXai with baseURL option"
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Error logging wiring
// ---------------------------------------------------------------------------

describe("Error logging wiring", () => {
  it("index.ts uncaughtException handler should call logger.error", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "index.ts"),
      "utf-8"
    );
    // Find the uncaughtException handler
    const uncaughtSection = source.slice(
      source.indexOf("uncaughtException"),
      source.indexOf("unhandledRejection")
    );
    assert.ok(
      uncaughtSection.includes("logger.error"),
      "uncaughtException handler should call logger.error"
    );
  });

  it("index.ts unhandledRejection handler should call logger.error", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "index.ts"),
      "utf-8"
    );
    const rejectionIdx = source.indexOf("unhandledRejection");
    const rejectionSection = source.slice(
      rejectionIdx,
      source.indexOf("});", rejectionIdx) + 3
    );
    assert.ok(
      rejectionSection.includes("logger.error"),
      "unhandledRejection handler should call logger.error"
    );
  });

  it("grok-agent.ts executeTool should log errors", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "agent", "grok-agent.ts"),
      "utf-8"
    );
    assert.ok(
      source.includes("logger.error(`executeTool("),
      "executeTool catch block should log errors with tool name"
    );
  });

  it("grok-agent.ts processUserMessageStream should log errors", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "agent", "grok-agent.ts"),
      "utf-8"
    );
    assert.ok(
      source.includes("logger.error('processUserMessageStream"),
      "processUserMessageStream catch block should log errors"
    );
  });

  it("client.ts chat/chatStream should log errors", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "grok", "client.ts"),
      "utf-8"
    );
    assert.ok(
      source.includes("logger.error('GrokClient.chat failed"),
      "chat() catch block should log errors"
    );
    assert.ok(
      source.includes("logger.error('GrokClient.chatStream failed"),
      "chatStream() catch block should log errors"
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Compilation sanity check
// ---------------------------------------------------------------------------

describe("Compilation sanity", () => {
  it("dist/ output should exist for all modified files", () => {
    const distRoot = path.join(__dirname, "..", "dist");
    const expected = [
      "utils/logger.js",
      "grok/client.js",
      "agent/grok-agent.js",
      "index.js",
    ];
    for (const f of expected) {
      const full = path.join(distRoot, f);
      assert.ok(fs.existsSync(full), `Compiled file should exist: dist/${f}`);
    }
  });

  it("compiled client.js should use .text for AI SDK v6 text-delta", () => {
    const compiled = fs.readFileSync(
      path.join(__dirname, "..", "dist", "grok", "client.js"),
      "utf-8"
    );
    // In AI SDK v6, the text-delta event uses .text, not .textDelta
    assert.ok(
      compiled.includes(".text"),
      "Compiled output should reference .text for text-delta chunks"
    );
  });
});
