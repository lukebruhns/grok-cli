import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CLONE_TARGET = join(homedir(), "code", "Machine-Learning");
const PROJECT_ROOT = join(import.meta.dirname, "..");

describe("Integration: Grok CLI clone repo via headless prompt", () => {
  before(() => {
    // Ensure the target directory doesn't exist before the test
    if (existsSync(CLONE_TARGET)) {
      rmSync(CLONE_TARGET, { recursive: true, force: true });
    }
  });

  after(() => {
    // Clean up after test
    if (existsSync(CLONE_TARGET)) {
      rmSync(CLONE_TARGET, { recursive: true, force: true });
    }
  });

  it("should clone the Machine-Learning repo when asked via headless prompt", async () => {
    // Skip if no API key is available
    const apiKey = process.env.GROK_API_KEY;
    if (!apiKey) {
      console.log("  SKIPPED: GROK_API_KEY not set");
      return;
    }

    const prompt =
      "i accidentally deleted my lukebruhns/Machine-Learning project locally please clone it from github and put it in my code directory right under my home dir";

    // Run grok-cli in headless mode with --prompt flag
    // Use a generous timeout since the API call + git clone may take a while
    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve) => {
      let stdout = "";
      let stderr = "";

      const child = spawn(
        "node",
        [
          "--import", "tsx",
          join(PROJECT_ROOT, "src", "index.ts"),
          "--prompt", prompt,
          "--max-tool-rounds", "10",
        ],
        {
          cwd: PROJECT_ROOT,
          env: {
            ...process.env,
            NODE_NO_WARNINGS: "1",
          },
          timeout: 120_000,
        }
      );

      child.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        process.stdout.write(`  [grok stdout] ${text}`);
      });

      child.stderr.on("data", (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        // Only log non-trivial stderr
        if (!text.includes("ExperimentalWarning") && !text.includes("DeprecationWarning")) {
          process.stderr.write(`  [grok stderr] ${text}`);
        }
      });

      child.on("close", (exitCode) => {
        resolve({ stdout, stderr, exitCode });
      });

      child.on("error", (err) => {
        resolve({ stdout, stderr: stderr + "\n" + err.message, exitCode: 1 });
      });
    });

    console.log(`  Exit code: ${result.exitCode}`);
    console.log(`  Stdout length: ${result.stdout.length}`);

    // The process should not crash with InvalidPromptError
    assert.ok(
      !result.stderr.includes("InvalidPromptError"),
      `Should not throw InvalidPromptError. Stderr: ${result.stderr.slice(0, 500)}`
    );
    assert.ok(
      !result.stderr.includes("AI_InvalidPromptError"),
      `Should not throw AI_InvalidPromptError. Stderr: ${result.stderr.slice(0, 500)}`
    );

    // Check that the repo was actually cloned
    assert.ok(
      existsSync(CLONE_TARGET),
      `Expected ${CLONE_TARGET} to exist after clone. Stdout: ${result.stdout.slice(-500)}`
    );
    assert.ok(
      existsSync(join(CLONE_TARGET, ".git")),
      `Expected ${CLONE_TARGET}/.git to exist (valid git repo)`
    );

    console.log("  SUCCESS: Machine-Learning repo cloned to ~/code/Machine-Learning");
  });
});
