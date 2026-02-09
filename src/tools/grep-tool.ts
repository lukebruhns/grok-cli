import { spawn } from "child_process";
import { ToolResult } from "../types/index.js";

const MAX_OUTPUT_SIZE = 50 * 1024; // 50KB

export interface GrepOptions {
  pattern: string;
  path?: string;
  outputMode?: "files_with_matches" | "content" | "count";
  glob?: string;
  type?: string;
  caseSensitive?: boolean;
  contextLines?: number;
  beforeContext?: number;
  afterContext?: number;
}

export class GrepTool {
  private currentDirectory: string = process.cwd();

  async execute(options: GrepOptions): Promise<ToolResult> {
    try {
      const args = this.buildArgs(options);
      return await this.runRipgrep(args);
    } catch (error: any) {
      return {
        success: false,
        error: `Grep error: ${error.message}`,
      };
    }
  }

  private buildArgs(options: GrepOptions): string[] {
    const args: string[] = [
      "--no-heading",
      "--color=never",
      "--no-require-git",
      "--glob", "!.git/**",
      "--glob", "!node_modules/**",
    ];

    // Output mode
    switch (options.outputMode) {
      case "files_with_matches":
        args.push("--files-with-matches");
        break;
      case "count":
        args.push("--count");
        break;
      case "content":
      default:
        args.push("--line-number");
        break;
    }

    // Case sensitivity
    if (!options.caseSensitive) {
      args.push("--ignore-case");
    }

    // Context lines
    if (options.contextLines !== undefined) {
      args.push("--context", options.contextLines.toString());
    }
    if (options.beforeContext !== undefined) {
      args.push("--before-context", options.beforeContext.toString());
    }
    if (options.afterContext !== undefined) {
      args.push("--after-context", options.afterContext.toString());
    }

    // Glob filter
    if (options.glob) {
      args.push("--glob", options.glob);
    }

    // Type filter
    if (options.type) {
      args.push("--type", options.type);
    }

    // Pattern and path
    args.push(options.pattern);
    if (options.path) {
      args.push(options.path);
    } else {
      args.push(this.currentDirectory);
    }

    return args;
  }

  private runRipgrep(args: string[]): Promise<ToolResult> {
    return new Promise((resolve) => {
      const rg = spawn("rg", args, {
        cwd: this.currentDirectory,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let truncated = false;

      rg.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        if (stdout.length + chunk.length > MAX_OUTPUT_SIZE) {
          if (!truncated) {
            stdout += chunk.substring(0, MAX_OUTPUT_SIZE - stdout.length);
            truncated = true;
          }
        } else {
          stdout += chunk;
        }
      });

      rg.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      rg.on("close", (code) => {
        const truncationMsg = truncated
          ? "\n\n[Output truncated — exceeded 50KB limit]"
          : "";

        if (code === 0) {
          resolve({
            success: true,
            output: (stdout.trim() + truncationMsg) || "No matches found.",
          });
        } else if (code === 1) {
          // ripgrep returns 1 when no matches found
          resolve({
            success: true,
            output: "No matches found.",
          });
        } else {
          resolve({
            success: false,
            error: `Ripgrep failed (code ${code}): ${stderr.trim()}`,
          });
        }
      });

      rg.on("error", (error) => {
        resolve({
          success: false,
          error: `Failed to run ripgrep: ${error.message}. Is 'rg' installed?`,
        });
      });
    });
  }

  setCurrentDirectory(directory: string): void {
    this.currentDirectory = directory;
  }

  getCurrentDirectory(): string {
    return this.currentDirectory;
  }
}
