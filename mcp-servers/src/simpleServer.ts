import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

async function runServer() {
  console.warn('Starting Simple MCP Server...');

  const server = new McpServer({
    name: 'SimpleServer',
    version: '1.0.0',
  });

  // Tool: HELLO [name] - Personalized greeting
  server.tool(
    'HELLO',
    'Sends a simple greeting message, optionally personalized with a name. Useful for testing the connection or initiating interaction',
    { name: z.string().optional() },
    async ({ name }) => {
      const greeting = `Hello, ${name || 'world'}!`;
      console.warn(`Responding to HELLO: ${greeting}`);
      return {
        content: [{ type: 'text', text: greeting }],
      };
    },
  );

  // Tool: ECHO [message] - Echoes back user input
  server.tool(
    'ECHO',
    'Repeats the exact message provided as input. Useful for testing message transmission or demonstrating input handling.',
    { message: z.string() },
    async ({ message }) => {
      console.warn(`Responding to ECHO: ${message}`);
      return {
        content: [{ type: 'text', text: message }],
      };
    },
  );

  // Tool: TIME - Returns system time
  server.tool(
    'TIME',
    'Retrieves the current system date and time from the server',
    {}, // No arguments
    async () => {
      const currentTime = new Date().toISOString();
      console.warn(`Responding to TIME: ${currentTime}`);
      return {
        content: [{ type: 'text', text: currentTime }],
      };
    },
  );

  const transport = new StdioServerTransport();
  console.warn('Simple MCP Server listening on stdio...');
  await server.connect(transport);
  console.warn('Simple MCP Server stopped.');
}

runServer().catch(console.error);
