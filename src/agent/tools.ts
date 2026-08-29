import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { exec } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, string>;
}

export interface ToolResult {
  tool_call_id: string;
  name: string;
  content: string;
  success: boolean;
}

const WORKSPACE_ROOT = process.cwd();

const BLOCKED_COMMANDS = [
  "rm -rf /",
  "sudo",
  "chmod 777",
  "mkfs",
  ":(){ :|:& };:",
];

function isCommandSafe(command: string): boolean {
  const lower = command.toLowerCase().trim();
  return !BLOCKED_COMMANDS.some((blocked) => lower.includes(blocked));
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read the contents of a file from disk within the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path from workspace root (e.g. src/main.ts)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write or update a file on disk, creating parent directories if needed.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path from workspace root (e.g. src/main.ts)",
        },
        content: {
          type: "string",
          description: "The full file content to write",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "execute_command",
    description: "Execute a terminal command (e.g. npm run build, git status, flutter pub get) and return stdout/stderr.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
      },
      required: ["command"],
    },
  },
];

export type AgentMode = 'PLAN' | 'BUILD';

export function getToolSystemPrompt(mode?: AgentMode): string {
  if (mode === 'PLAN') {
    return `
## Available Tools

In PLAN mode, tool execution for modifying files or running terminal commands is DISABLED.
You are acting as an architect and planner. You may analyze codebase structure and design implementation plans.
`;
  }
  return `
## Available Tools

You have access to the following tools for autonomous file and terminal operations:

${TOOL_DEFINITIONS.map((t) => `### ${t.name}\n${t.description}\nParameters: ${JSON.stringify(t.parameters, null, 2)}`).join("\n\n")}

## Tool Calling Format

When you need to use a tool, respond with a JSON code block in this exact format:
\`\`\`tool_call
{
  "name": "tool_name",
  "arguments": { "param": "value" }
}
\`\`\`

You can issue multiple tool calls in sequence. After each tool execution, you will receive the result and can continue your work.

## Rules
- Always use relative paths from the workspace root.
- Read files before modifying them to understand existing code.
- Use execute_command for build, test, and dependency operations.
- Do not attempt destructive operations (rm -rf /, sudo, etc.).
`;
}

export function parseToolCalls(response: string): ToolCall[] {
  const TOOL_CALL_REGEX = /```tool_call\s*\n([\s\S]*?)\n```/g;
  const calls: ToolCall[] = [];
  let match;

  while ((match = TOOL_CALL_REGEX.exec(response)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!);
      calls.push({
        id: `tc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        name: parsed.name,
        arguments: parsed.arguments || {},
      });
    } catch {
      // skip malformed tool calls
    }
  }

  return calls;
}

export async function executeToolCall(call: ToolCall, mode?: AgentMode): Promise<ToolResult> {
  if (mode === 'PLAN' && (call.name === 'write_file' || call.name === 'execute_command')) {
    return {
      tool_call_id: call.id,
      name: call.name,
      content: `Error: Tool "${call.name}" execution is DISABLED in PLAN mode. Switch to BUILD mode to perform file modifications or command execution.`,
      success: false,
    };
  }

  try {
    switch (call.name) {
      case "read_file":
        return executeReadFile(call);
      case "write_file":
      case "create_file":
        return executeWriteFile(call);
      case "execute_command":
      case "run_command":
      case "bash":
        return executeCommand(call);
      default:
        return {
          tool_call_id: call.id,
          name: call.name,
          content: `Error: Unknown tool "${call.name}"`,
          success: false,
        };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      tool_call_id: call.id,
      name: call.name,
      content: `Tool execution error: ${msg}`,
      success: false,
    };
  }
}

function executeReadFile(call: ToolCall): ToolResult {
  const relPath = call.arguments.path || (call.arguments as any).filePath;
  if (!relPath) {
    return { tool_call_id: call.id, name: call.name, content: "Error: path parameter required", success: false };
  }

  const absPath = resolve(WORKSPACE_ROOT, relPath);
  if (!existsSync(absPath)) {
    return { tool_call_id: call.id, name: call.name, content: `Error: File not found: ${relPath}`, success: false };
  }

  try {
    const content = readFileSync(absPath, "utf-8");
    return { tool_call_id: call.id, name: call.name, content, success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { tool_call_id: call.id, name: call.name, content: `Error reading file: ${msg}`, success: false };
  }
}

function executeWriteFile(call: ToolCall): ToolResult {
  const relPath = call.arguments.path || (call.arguments as any).filePath;
  const content = call.arguments.content;
  if (!relPath || content === undefined) {
    return { tool_call_id: call.id, name: call.name, content: "Error: path and content parameters required", success: false };
  }

  const absPath = resolve(WORKSPACE_ROOT, relPath);

  try {
    const isUpdate = existsSync(absPath);
    const dir = dirname(absPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(absPath, content, "utf-8");
    const actionLabel = isUpdate ? "updated" : "created";
    return { tool_call_id: call.id, name: call.name, content: `File ${actionLabel} successfully: ${relPath}`, success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { tool_call_id: call.id, name: call.name, content: `Error writing file: ${msg}`, success: false };
  }
}

async function executeCommand(call: ToolCall): Promise<ToolResult> {
  const command = call.arguments.command || (call.arguments as any).cmd;
  if (!command) {
    return { tool_call_id: call.id, name: call.name, content: "Error: command parameter required", success: false };
  }

  if (!isCommandSafe(command)) {
    return {
      tool_call_id: call.id,
      name: call.name,
      content: `Error: Command blocked for safety: ${command}`,
      success: false,
    };
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKSPACE_ROOT,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    return {
      tool_call_id: call.id,
      name: call.name,
      content: output || "(command completed with no output)",
      success: true,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { tool_call_id: call.id, name: call.name, content: `Command failed: ${msg}`, success: false };
  }
}

export function formatToolResults(results: ToolResult[]): string {
  return results
    .map((r) => {
      const status = r.success ? "✓" : "✗";
      return `[Tool ${status} ${r.name}]\n${r.content}`;
    })
    .join("\n\n");
}

export function writeFile(relPath: string, content: string): void {
  const absPath = resolve(WORKSPACE_ROOT, relPath);
  const dir = dirname(absPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(absPath, content, "utf-8");
}
