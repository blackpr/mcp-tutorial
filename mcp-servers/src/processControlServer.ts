import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { exec, spawn, ChildProcess } from 'child_process';
import pidusage from 'pidusage';
import { promisify } from 'util';

const execPromise = promisify(exec);

const StringOrNumberPidSchema = z.union([
  z.number().int().positive(),
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive()), // Regex ensures it's only digits before transforming
]);

// Store running processes managed by this server
const runningProcesses: Map<number, { command: string; args: string[]; process: ChildProcess }> =
  new Map();

async function runServer() {
  console.warn('Starting Process Control MCP Server...');

  const server = new McpServer({
    name: 'ProcessControlServer',
    version: '1.0.0',
  });

  // Tool: LIST_PROCESSES - List running processes (platform dependent)
  server.tool(
    'LIST_PROCESSES',
    "Retrieves a list of currently running processes on the server's host system, including both system processes and those managed by this server.",
    {},
    async () => {
      console.warn('Handling LIST_PROCESSES request...');
      try {
        // Platform-specific command. Using 'ps aux' for Linux/macOS example.
        // For Windows, use 'tasklist'. Error handling needed for cross-platform.
        const command = process.platform === 'win32' ? 'tasklist' : 'ps aux';
        const { stdout, stderr } = await execPromise(command);

        if (stderr) {
          console.error('LIST_PROCESSES stderr:', stderr);
          // Decide if stderr should be an error or just included
        }

        // Include processes started by this server instance
        const managedProcesses = Array.from(runningProcesses.entries())
          .map(
            ([pid, data]) => `Managed PID: ${pid}, Command: ${data.command} ${data.args.join(' ')}`,
          )
          .join('\n');

        const output = `System Processes:\n${stdout}\n\nManaged Processes:\n${managedProcesses || 'None'}`;

        return {
          content: [{ type: 'text', text: output }],
        };
      } catch (error: any) {
        console.error('Error listing processes:', error);
        return {
          content: [{ type: 'text', text: `Error listing processes: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: START_PROCESS - Launch a new process
  server.tool(
    'START_PROCESS',
    "Launches a new background process on the server's host system using the specified command and arguments. Returns the Process ID (PID) if successful",
    { command: z.string(), args: z.array(z.string()).optional().default([]) },
    async ({ command, args }) => {
      console.warn(`Handling START_PROCESS request: ${command} ${args.join(' ')}`);
      try {
        // Spawn in detached mode so it can outlive the server if needed (optional)
        const child = spawn(command, args, {
          detached: true,
          stdio: 'ignore', // Or pipe/inherit as needed
        });

        child.unref(); // Allow parent process to exit independently

        if (child.pid) {
          runningProcesses.set(child.pid, { command, args, process: child });
          console.warn(`Started process ${command} with PID: ${child.pid}`);
          return {
            content: [{ type: 'text', text: `Process started with PID: ${child.pid}` }],
          };
        } else {
          throw new Error('Failed to get PID for started process.');
        }
      } catch (error: any) {
        console.error('Error starting process:', error);
        return {
          content: [{ type: 'text', text: `Error starting process: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: STOP_PROCESS - Terminate a running process
  server.tool(
    'STOP_PROCESS',
    "Attempts to terminate a running process on the server's host system, identified by its Process ID (PID).",
    { pid: StringOrNumberPidSchema },
    async ({ pid }) => {
      console.warn(`Handling STOP_PROCESS request for PID: ${pid}`);
      try {
        // Check if it's a process managed by this server first
        if (runningProcesses.has(pid)) {
          const success = runningProcesses.get(pid)?.process.kill(); // Sends SIGTERM
          if (success) {
            runningProcesses.delete(pid);
            console.warn(`Sent kill signal to managed process PID: ${pid}`);
            return {
              content: [{ type: 'text', text: `Kill signal sent to managed process PID: ${pid}.` }],
            };
          } else {
            throw new Error(`Failed to send kill signal to managed process PID: ${pid}.`);
          }
        } else {
          // Attempt to kill any process by PID (requires appropriate permissions)
          process.kill(pid); // Sends SIGTERM by default
          console.warn(`Sent kill signal to external process PID: ${pid}`);
          return {
            content: [
              {
                type: 'text',
                text: `Kill signal sent to external process PID: ${pid}. Check system logs for confirmation.`,
              },
            ],
          };
        }
      } catch (error: any) {
        console.error(`Error stopping process PID ${pid}:`, error);
        // Common errors: EPERM (permission denied), ESRCH (no such process)
        return {
          content: [{ type: 'text', text: `Error stopping process PID ${pid}: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: MONITOR_PROCESS - Get resource usage of a process
  server.tool(
    'MONITOR_PROCESS',
    'Fetches the current CPU and memory resource usage for a specific running process, identified by its Process ID (PID).',
    { pid: StringOrNumberPidSchema },
    async ({ pid }) => {
      console.warn(`Handling MONITOR_PROCESS request for PID: ${pid}`);
      pid = Number(pid);
      try {
        const stats = await pidusage(pid);
        // stats contains { cpu: %, memory: bytes, ppid: parent_pid, pid: pid, ctime: ms, elapsed: ms, timestamp: ms }
        console.warn(`Usage stats for PID ${pid}:`, stats);
        const usageText = `Resource usage for PID ${pid}:
- CPU: ${stats.cpu.toFixed(2)}%
- Memory: ${(stats.memory / 1024 / 1024).toFixed(2)} MB
- Uptime (approx): ${(stats.elapsed / 1000).toFixed(0)} seconds`;
        return {
          content: [{ type: 'text', text: usageText }],
        };
      } catch (error: any) {
        console.error(`Error monitoring process PID ${pid}:`, error);
        // Common error: ESRCH (no such process)
        return {
          content: [
            { type: 'text', text: `Error monitoring process PID ${pid}: ${error.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  console.warn('Process Control MCP Server listening on stdio...');
  await server.connect(transport);
  console.warn('Process Control MCP Server stopped.');

  // Clean up any remaining managed processes on server exit
  runningProcesses.forEach((data, pid) => {
    try {
      console.warn(`Cleaning up managed process PID: ${pid}`);
      data.process.kill();
    } catch (e) {
      console.warn(`Failed to clean up PID ${pid} on exit:`, e);
    }
  });
}

runServer().catch(console.error);
