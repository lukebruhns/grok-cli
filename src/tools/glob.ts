import fg from "fast-glob";
import * as path from "path";
import { ToolResult } from "../types/index.js";

export class GlobTool {
  private currentDirectory: string = process.cwd();

  async execute(pattern: string, searchPath?: string): Promise<ToolResult> {
    try {
      const baseDir = searchPath
        ? path.resolve(this.currentDirectory, searchPath)
        : this.currentDirectory;

      const entries = await fg(pattern, {
        cwd: baseDir,
        dot: false,
        onlyFiles: true,
        ignore: ["**/node_modules/**", "**/.git/**"],
        suppressErrors: true,
        followSymbolicLinks: false,
      });

      // Sort by path for consistent output
      entries.sort();

      if (entries.length === 0) {
        return {
          success: true,
          output: `No files matched pattern "${pattern}" in ${baseDir}`,
        };
      }

      const MAX_RESULTS = 500;
      const truncated = entries.length > MAX_RESULTS;
      const displayEntries = truncated ? entries.slice(0, MAX_RESULTS) : entries;

      let output = displayEntries.join("\n");
      if (truncated) {
        output += `\n\n... and ${entries.length - MAX_RESULTS} more files (${entries.length} total)`;
      } else {
        output += `\n\n${entries.length} files matched.`;
      }

      return {
        success: true,
        output,
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Glob error: ${error.message}`,
      };
    }
  }

  setCurrentDirectory(directory: string): void {
    this.currentDirectory = directory;
  }

  getCurrentDirectory(): string {
    return this.currentDirectory;
  }
}
