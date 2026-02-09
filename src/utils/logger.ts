import fs from "fs";
import path from "path";
import os from "os";

const LOG_DIR = path.join(os.homedir(), ".grok", "logs");
const MAX_AGE_DAYS = 7;

function ensureLogDir(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // ignore — if we can't create the dir we'll silently skip logging
  }
}

function logFilePath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `grok-${date}.log`);
}

function timestamp(): string {
  return new Date().toISOString();
}

function appendLine(line: string): void {
  try {
    fs.appendFileSync(logFilePath(), line + "\n");
  } catch {
    // silently ignore write failures
  }
}

function pruneOldLogs(): void {
  try {
    const files = fs.readdirSync(LOG_DIR);
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.startsWith("grok-") || !file.endsWith(".log")) continue;
      const full = path.join(LOG_DIR, file);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(full);
        }
      } catch {
        // ignore individual file errors
      }
    }
  } catch {
    // ignore
  }
}

// Initialise on import
ensureLogDir();
pruneOldLogs();

function isDebug(): boolean {
  return process.env.GROK_DEBUG === "1";
}

export const logger = {
  error(message: string, error?: unknown): void {
    const errStr =
      error instanceof Error
        ? `${error.message}\n${error.stack ?? ""}`
        : error !== undefined
          ? String(error)
          : "";
    appendLine(`[${timestamp()}] ERROR ${message}${errStr ? " | " + errStr : ""}`);
  },

  warn(message: string): void {
    appendLine(`[${timestamp()}] WARN  ${message}`);
  },

  info(message: string): void {
    if (isDebug()) {
      appendLine(`[${timestamp()}] INFO  ${message}`);
    }
  },

  debug(message: string): void {
    if (isDebug()) {
      appendLine(`[${timestamp()}] DEBUG ${message}`);
    }
  },

  /** Log an outgoing API request (only when debug enabled). */
  logApiRequest(method: string, endpoint: string, body?: unknown): void {
    if (!isDebug()) return;
    const safeBody = body ? JSON.stringify(body, null, 2) : "(no body)";
    appendLine(
      `[${timestamp()}] DEBUG API_REQUEST ${method} ${endpoint}\n` +
      `  Body: ${safeBody}`
    );
  },

  /** Log an incoming API response (only when debug enabled). */
  logApiResponse(status: number, body?: unknown): void {
    if (!isDebug()) return;
    const safeBody = body ? JSON.stringify(body, null, 2) : "(no body)";
    appendLine(
      `[${timestamp()}] DEBUG API_RESPONSE status=${status}\n` +
      `  Body: ${safeBody}`
    );
  },

  /** Log an API error (always, regardless of debug flag). */
  logApiError(method: string, endpoint: string, status: number | string, errorBody?: unknown): void {
    const safeBody = errorBody ? JSON.stringify(errorBody, null, 2) : "(no body)";
    appendLine(
      `[${timestamp()}] ERROR API_ERROR ${method} ${endpoint} status=${status}\n` +
      `  Body: ${safeBody}`
    );
  },
};
