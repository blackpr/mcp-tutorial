import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import si from 'systeminformation';

async function runServer() {
  console.warn('Starting Resource Monitoring MCP Server...');

  const server = new McpServer({
    name: 'ResourceMonitorServer',
    version: '1.0.0',
  });

  // Tool: GET_CPU_USAGE - Monitor CPU load
  server.tool(
    'GET_CPU_USAGE',
    "Retrieves the current overall CPU load percentage of the server's host system.",
    {},
    async () => {
      console.warn('Handling GET_CPU_USAGE request...');
      try {
        const load = await si.currentLoad();
        // currentLoad gives average load since boot, currentLoad gives instantaneous %
        const cpuText = `Current CPU Load: ${load.currentLoad.toFixed(2)}% (Avg: ${load.avgLoad.toFixed(2)}%)`;
        return {
          content: [{ type: 'text', text: cpuText }],
        };
      } catch (error: any) {
        console.error('Error getting CPU usage:', error);
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    },
  );

  // Tool: GET_MEMORY_USAGE - Track memory consumption
  server.tool(
    'GET_MEMORY_USAGE',
    'Retrieves the current system memory usage statistics (e.g., total, used/active, free, percentage used).',
    {},
    async () => {
      console.warn('Handling GET_MEMORY_USAGE request...');
      try {
        const mem = await si.mem();
        // Convert bytes to GB for readability
        const totalGb = (mem.total / 1024 / 1024 / 1024).toFixed(2);
        const usedGb = (mem.active / 1024 / 1024 / 1024).toFixed(2);
        const freeGb = (mem.free / 1024 / 1024 / 1024).toFixed(2);
        const usedPercent = ((mem.active / mem.total) * 100).toFixed(2);

        const memText = `Memory Usage: ${usedGb} GB / ${totalGb} GB (${usedPercent}% Active)\nFree: ${freeGb} GB`;
        return {
          content: [{ type: 'text', text: memText }],
        };
      } catch (error: any) {
        console.error('Error getting Memory usage:', error);
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    },
  );

  // Tool: GET_DISK_SPACE - Check available disk space
  server.tool(
    'GET_DISK_SPACE',
    "Retrieves disk space usage statistics (e.g., total, used, available, percentage used) for the server's file systems. Can optionally filter by a specific mount point.\n",
    // Optional: Add argument for specific mount point
    { mountPoint: z.string().optional() },
    async ({ mountPoint }) => {
      console.warn(`Handling GET_DISK_SPACE request (Mount: ${mountPoint || 'all'})`);
      try {
        const fsData = await si.fsSize();
        let diskText = 'Disk Space:\n';

        const targetFs = mountPoint ? fsData.filter((fs) => fs.mount === mountPoint) : fsData;

        if (targetFs.length === 0) {
          return {
            content: [{ type: 'text', text: `Mount point "${mountPoint}" not found.` }],
            isError: true,
          };
        }

        targetFs.forEach((fs) => {
          const totalGb = (fs.size / 1024 / 1024 / 1024).toFixed(2);
          const usedGb = (fs.used / 1024 / 1024 / 1024).toFixed(2);
          const availGb = ((fs.size - fs.used) / 1024 / 1024 / 1024).toFixed(2);
          diskText += `- ${fs.fs} on ${fs.mount}: ${usedGb} GB Used / ${totalGb} GB Total (${fs.use.toFixed(1)}% Used), Available: ${availGb} GB\n`;
        });

        return {
          content: [{ type: 'text', text: diskText.trim() }],
        };
      } catch (error: any) {
        console.error('Error getting Disk usage:', error);
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    },
  );

  const transport = new StdioServerTransport();
  console.warn('Resource Monitoring MCP Server listening on stdio...');
  await server.connect(transport);
  console.warn('Resource Monitoring MCP Server stopped.');
}

runServer().catch(console.error);
