import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import cron, { ScheduledTask } from 'node-cron';
import { spawn } from 'child_process';

interface StoredTask {
  name: string;
  schedule: string;
  command: string;
  args: string[];
  task: ScheduledTask;
  lastRunOutput?: string;
  lastRunError?: string;
  lastRunExitCode?: number;
  lastRunTime?: Date;
}

// Store scheduled tasks managed by this server
const scheduledTasks: Map<string, StoredTask> = new Map();

async function runServer() {
  console.warn('Starting Task Scheduling MCP Server...');

  const server = new McpServer({
    name: 'TaskSchedulingServer',
    version: '1.0.0',
  });

  // Tool: SCHEDULE_TASK - Schedule a task to run
  server.tool(
    'SCHEDULE_TASK',
    {
      name: z.string().min(1), // Unique name for the task
      schedule: z.string().min(1), // Cron pattern (e.g., '* * * * *')
      command: z.string().min(1),
      args: z.array(z.string()).optional().default([]),
    },
    async ({ name, schedule, command, args }) => {
      console.warn(
        `Handling SCHEDULE_TASK: ${name} - "${schedule}" - ${command} ${args.join(' ')}`,
      );

      if (scheduledTasks.has(name)) {
        return {
          content: [{ type: 'text', text: `Error: Task with name "${name}" already exists.` }],
          isError: true,
        };
      }

      if (!cron.validate(schedule)) {
        return {
          content: [{ type: 'text', text: `Error: Invalid cron schedule format "${schedule}".` }],
          isError: true,
        };
      }

      try {
        const task = cron.schedule(schedule, () => {
          console.warn(`Executing scheduled task "${name}": ${command} ${args.join(' ')}`);

          // Create a new stored task or get the existing one
          const storedTask = scheduledTasks.get(name) || {
            name,
            schedule,
            command,
            args,
            task,
          };

          // Update the last run time
          storedTask.lastRunTime = new Date();

          // Spawn the process but capture stdout and stderr instead of inheriting
          const child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let stdout = '';
          let stderr = '';

          child.stdout.on('data', (data) => {
            stdout += data.toString();
            console.warn(`[${name}] stdout: ${data}`);
          });

          child.stderr.on('data', (data) => {
            stderr += data.toString();
            console.warn(`[${name}] stderr: ${data}`);
          });

          child.on('error', (err) => {
            console.error(`Error executing task "${name}":`, err);
            storedTask.lastRunError = err.message;
          });

          child.on('close', (code) => {
            console.warn(`Task "${name}" finished with code ${code}`);
            storedTask.lastRunExitCode = code || undefined;
            storedTask.lastRunOutput = stdout;
            storedTask.lastRunError = stderr;

            // Update the stored task with the new output
            scheduledTasks.set(name, storedTask);
          });
        });

        const storedTask: StoredTask = { name, schedule, command, args, task };
        scheduledTasks.set(name, storedTask);

        console.warn(`Task "${name}" scheduled successfully.`);
        return {
          content: [
            {
              type: 'text',
              text: `Task "${name}" scheduled successfully with schedule "${schedule}".`,
            },
          ],
        };
      } catch (error: any) {
        console.error(`Error scheduling task "${name}":`, error);
        return {
          content: [{ type: 'text', text: `Error scheduling task: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: LIST_TASKS - View all scheduled tasks
  server.tool('LIST_TASKS', {}, async () => {
    console.warn('Handling LIST_TASKS request...');
    if (scheduledTasks.size === 0) {
      return { content: [{ type: 'text', text: 'No tasks scheduled.' }] };
    }

    const taskList = Array.from(scheduledTasks.values())
      .map((t) => {
        let taskInfo = `- ${t.name}: "${t.schedule}" -> ${t.command} ${t.args.join(' ')}`;
        if (t.lastRunTime) {
          taskInfo += `\n  Last run: ${t.lastRunTime.toISOString()}`;
          taskInfo += `\n  Exit code: ${t.lastRunExitCode !== undefined ? t.lastRunExitCode : 'N/A'}`;
        }
        return taskInfo;
      })
      .join('\n\n');

    return {
      content: [{ type: 'text', text: `Scheduled Tasks:\n${taskList}` }],
    };
  });

  // Tool: GET_TASK_OUTPUT - Get the output of a specific task
  server.tool('GET_TASK_OUTPUT', { name: z.string().min(1) }, async ({ name }) => {
    console.warn(`Handling GET_TASK_OUTPUT request for "${name}"`);
    const storedTask = scheduledTasks.get(name);

    if (!storedTask) {
      return {
        content: [{ type: 'text', text: `Error: Task with name "${name}" not found.` }],
        isError: true,
      };
    }

    if (!storedTask.lastRunTime) {
      return {
        content: [{ type: 'text', text: `Task "${name}" has not been executed yet.` }],
      };
    }

    let outputText = `Output for task "${name}" (run at ${storedTask.lastRunTime.toISOString()}):\n\n`;
    outputText += `Exit code: ${storedTask.lastRunExitCode !== undefined ? storedTask.lastRunExitCode : 'N/A'}\n\n`;

    if (storedTask.lastRunOutput) {
      outputText += `STDOUT:\n${storedTask.lastRunOutput}\n\n`;
    } else {
      outputText += `STDOUT: <no output>\n\n`;
    }

    if (storedTask.lastRunError && storedTask.lastRunError.length > 0) {
      outputText += `STDERR:\n${storedTask.lastRunError}`;
    }

    return {
      content: [{ type: 'text', text: outputText }],
    };
  });

  // Tool: CANCEL_TASK - Remove a scheduled task
  server.tool('CANCEL_TASK', { name: z.string().min(1) }, async ({ name }) => {
    console.warn(`Handling CANCEL_TASK request for "${name}"`);
    const storedTask = scheduledTasks.get(name);

    if (!storedTask) {
      return {
        content: [{ type: 'text', text: `Error: Task with name "${name}" not found.` }],
        isError: true,
      };
    }

    try {
      storedTask.task.stop(); // Stop the node-cron task
      scheduledTasks.delete(name); // Remove from our map
      console.warn(`Task "${name}" cancelled successfully.`);
      return {
        content: [{ type: 'text', text: `Task "${name}" cancelled successfully.` }],
      };
    } catch (error: any) {
      console.error(`Error cancelling task "${name}":`, error);
      return {
        content: [{ type: 'text', text: `Error cancelling task: ${error.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  console.warn('Task Scheduling MCP Server listening on stdio...');
  await server.connect(transport);
  console.warn('Task Scheduling MCP Server stopped.');

  // Clean up cron jobs on exit
  scheduledTasks.forEach((storedTask) => {
    try {
      storedTask.task.stop();
    } catch (e) {
      console.warn(`Failed to stop task ${storedTask.name} on exit:`, e);
    }
  });
}

runServer().catch(console.error);
