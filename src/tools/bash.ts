import { spawn } from 'child_process';
import { ToolResult } from '../types/index.js';
import { ConfirmationService } from '../utils/confirmation-service.js';

const MAX_OUTPUT_SIZE = 100 * 1024; // 100KB

export class BashTool {
  private currentDirectory: string = process.cwd();
  private confirmationService = ConfirmationService.getInstance();

  async execute(command: string, timeout: number = 120000): Promise<ToolResult> {
    try {
      if (!command || typeof command !== 'string') {
        return {
          success: false,
          error: 'No command provided. Please specify a command to execute.',
        };
      }

      // Check if user has already accepted bash commands for this session
      const sessionFlags = this.confirmationService.getSessionFlags();
      if (!sessionFlags.bashCommands && !sessionFlags.allOperations) {
        // Request confirmation showing the command
        const confirmationResult = await this.confirmationService.requestConfirmation({
          operation: 'Run bash command',
          filename: command,
          showVSCodeOpen: false,
          content: `Command: ${command}\nWorking directory: ${this.currentDirectory}`
        }, 'bash');

        if (!confirmationResult.confirmed) {
          return {
            success: false,
            error: confirmationResult.feedback || 'Command execution cancelled by user'
          };
        }
      }

      if (command.startsWith('cd ')) {
        const newDir = command.substring(3).trim();
        try {
          process.chdir(newDir);
          this.currentDirectory = process.cwd();
          return {
            success: true,
            output: `Changed directory to: ${this.currentDirectory}`
          };
        } catch (error: any) {
          return {
            success: false,
            error: `Cannot change directory: ${error.message}`
          };
        }
      }

      return await this.spawnCommand(command, timeout);
    } catch (error: any) {
      return {
        success: false,
        error: `Command failed: ${error.message}`
      };
    }
  }

  private spawnCommand(command: string, timeout: number): Promise<ToolResult> {
    return new Promise((resolve) => {
      const child = spawn('bash', ['-c', command], {
        cwd: this.currentDirectory,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killed = false;
      let outputTruncated = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        // Force kill after 5 seconds if SIGTERM doesn't work
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 5000);
      }, timeout);

      child.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        if (stdout.length + chunk.length > MAX_OUTPUT_SIZE) {
          if (!outputTruncated) {
            stdout += chunk.substring(0, MAX_OUTPUT_SIZE - stdout.length);
            outputTruncated = true;
          }
        } else {
          stdout += chunk;
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        if (stderr.length + chunk.length > MAX_OUTPUT_SIZE) {
          if (!outputTruncated) {
            stderr += chunk.substring(0, MAX_OUTPUT_SIZE - stderr.length);
            outputTruncated = true;
          }
        } else {
          stderr += chunk;
        }
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);

        const truncationMsg = outputTruncated ? '\n\n[Output truncated — exceeded 100KB limit]' : '';
        const output = stdout + (stderr ? `\nSTDERR: ${stderr}` : '') + truncationMsg;

        if (killed) {
          resolve({
            success: false,
            error: `Command timed out after ${Math.round(timeout / 1000)}s. Partial output:\n${output.trim()}`
          });
          return;
        }

        if (signal) {
          resolve({
            success: false,
            error: `Command killed by signal ${signal}. Output:\n${output.trim()}`
          });
          return;
        }

        if (code !== 0) {
          resolve({
            success: false,
            error: `Command exited with code ${code}.\n${output.trim()}`
          });
          return;
        }

        resolve({
          success: true,
          output: output.trim() || 'Command executed successfully (no output)'
        });
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({
          success: false,
          error: `Failed to start command: ${error.message}`
        });
      });
    });
  }

  getCurrentDirectory(): string {
    return this.currentDirectory;
  }
}
