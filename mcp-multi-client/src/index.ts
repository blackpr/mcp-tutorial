import { Anthropic } from '@anthropic-ai/sdk';
import { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import readline from 'readline/promises';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { fileURLToPath } from 'url';

dotenv.config();

interface ToolUseBlock {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  type: 'tool_use';
}

interface ToolResultPart {
  type: 'tool_result';
  tool_use_id: string;
  content: string | any;
  is_error: boolean;
}

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: any;
}

interface MCPToolCallResult {
  content: Array<{ type: string; text?: string; [key: string]: any }> | any;
  error?: boolean;
}

interface StdioClientTransportOptions {
  command: string;
  args: string[];
  cwd?: string;
}

const ServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
});

const ConfigSchema = z.object({
  mcpServers: z.record(z.string(), ServerConfigSchema),
});

type McpServerConfig = z.infer<typeof ConfigSchema>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class MCPMultiClient {
  private anthropic: Anthropic;
  private serverConfigs: McpServerConfig | null = null;
  private mcpClients: Map<string, Client> = new Map();
  private transports: Map<string, StdioClientTransport> = new Map();
  private allTools: Tool[] = [];
  private toolToServerMap: Map<string, string> = new Map(); // toolName -> serverName

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set in .env file');
    }
    this.anthropic = new Anthropic({ apiKey });
  }

  public loadConfig(configPath: string): void {
    try {
      console.log(`Loading configuration from: ${configPath}`);
      const configData = fs.readFileSync(configPath, 'utf-8');
      const rawConfig = JSON.parse(configData);
      this.serverConfigs = ConfigSchema.parse(rawConfig);
      console.log(
        `Loaded configuration for servers: ${Object.keys(this.serverConfigs.mcpServers).join(', ')}`,
      );
    } catch (error) {
      console.error(`Failed to load or parse configuration file "${configPath}":`, error);
      throw error;
    }
  }

  public async connectToServers(): Promise<void> {
    if (!this.serverConfigs) {
      throw new Error('Configuration not loaded. Call loadConfig first.');
    }

    console.log('\nConnecting to MCP servers...');
    const connectionPromises: Promise<void>[] = [];

    for (const [serverName, config] of Object.entries(this.serverConfigs.mcpServers)) {
      console.log(`  Attempting connection to "${serverName}"...`);
      const transportOptions: StdioClientTransportOptions = {
        command: config.command,
        args: config.args,
        // Optional: Add cwd if needed, especially for relative paths in args
        // cwd: path.dirname(config.args[0]) // Example if args[0] is the script path
      };

      const transport = new StdioClientTransport(transportOptions);
      const client = new Client({ name: `mcp-multi-client-${serverName}`, version: '1.0.0' });

      this.transports.set(serverName, transport);
      this.mcpClients.set(serverName, client);

      // Connect and fetch tools for this server
      connectionPromises.push(
        (async () => {
          try {
            await client.connect(transport);
            console.log(`  Successfully connected to "${serverName}". Fetching tools...`);
            const toolsResult = await client.listTools();

            // Map MCP ToolInfo to Anthropic Tool format and store mapping
            const serverTools: Tool[] = toolsResult.tools.map((mcpTool: ToolInfo) => {
              if (this.toolToServerMap.has(mcpTool.name)) {
                console.warn(
                  `  ⚠️ Duplicate tool name found: "${mcpTool.name}". Provided by "${this.toolToServerMap.get(mcpTool.name)}" and now "${serverName}". The client will use the one from "${serverName}".`,
                );
              }
              this.toolToServerMap.set(mcpTool.name, serverName); // Store which server has this tool

              // Basic schema validation/conversion (adjust if needed based on actual schema complexity)
              let inputSchema: Tool['input_schema'] = { type: 'object', properties: {} };
              if (mcpTool.inputSchema && typeof mcpTool.inputSchema === 'object') {
                // Attempt to use directly, assuming it's compatible JSON Schema
                // WARNING: Anthropic's expected schema might have nuances.
                // For complex cases, you might need a more robust conversion.
                inputSchema = mcpTool.inputSchema as Tool['input_schema'];
              } else if (mcpTool.inputSchema) {
                console.warn(
                  `  Tool "${mcpTool.name}" from server "${serverName}" has an unexpected schema format. Using empty schema.`,
                );
              }

              return {
                name: mcpTool.name,
                description:
                  mcpTool.description || `Tool ${mcpTool.name} from server ${serverName}`,
                input_schema: inputSchema,
              };
            });

            this.allTools.push(...serverTools);
            console.log(
              `  Server "${serverName}" tools registered: ${serverTools.map((t) => t.name).join(', ') || 'None'}`,
            );
          } catch (e) {
            console.error(`  ❌ Failed to connect or fetch tools from "${serverName}":`, e);
            this.mcpClients.delete(serverName);
            this.transports.delete(serverName);
          }
        })(),
      );
    }

    await Promise.all(connectionPromises);

    if (this.mcpClients.size === 0) {
      console.error('\n❌ No MCP servers connected successfully. Exiting.');
      process.exit(1);
    }

    console.log(`\n✅ Connected to ${this.mcpClients.size} server(s).`);
    console.log(
      `Available tools for Claude: ${this.allTools.map((t) => t.name).join(', ') || 'None'}`,
    );
  }

  public async processQuery(query: string): Promise<string> {
    if (this.allTools.length === 0) {
      console.log('No tools available from connected servers. Asking Claude directly.');
    }

    const messages: MessageParam[] = [{ role: 'user', content: query }];
    let finalAnswer = '';

    try {
      console.log('\nSending query to Claude with available tools...');
      const initialResponse = await this.anthropic.messages.create({
        model: 'claude-3-5-sonnet-20240620',
        max_tokens: 2048,
        messages: messages,
        tools: this.allTools.length > 0 ? this.allTools : undefined, // Only send tools if available
      });

      console.log("Claude's initial response received.");
      // console.log("Initial response content:", JSON.stringify(initialResponse.content, null, 2));

      const toolCalls: ToolUseBlock[] = [];
      const textContents: string[] = [];

      // Process initial response content
      initialResponse.content.forEach((contentBlock) => {
        if (contentBlock.type === 'text') {
          textContents.push(contentBlock.text);
        } else if (contentBlock.type === 'tool_use') {
          toolCalls.push(contentBlock as ToolUseBlock);
        }
      });

      // Append initial text response
      if (textContents.length > 0) {
        finalAnswer += textContents.join('\n') + '\n';
        console.log("Claude's initial text:", textContents.join('\n'));
      }

      // If no tool calls, we're done with this turn
      if (toolCalls.length === 0) {
        console.log('No tool calls requested by Claude.');
        // Handle stop reasons if needed
        if (initialResponse.stop_reason === 'tool_use') {
          console.warn(
            'Warning: Claude stopped for tool use, but no tool_use blocks found in content. This might indicate an issue.',
          );
        }
        return finalAnswer.trim() || 'Claude did not provide a text response.';
      }

      // --- Handle Tool Calls ---
      console.log(
        `Claude requested ${toolCalls.length} tool call(s): ${toolCalls.map((tc) => tc.name).join(', ')}`,
      );
      messages.push({ role: 'assistant', content: initialResponse.content }); // Add assistant's turn (including tool_use requests)

      const toolResults: ToolResultPart[] = [];

      for (const toolCall of toolCalls) {
        const toolName = toolCall.name;
        const toolInput = toolCall.input || {};
        const toolUseId = toolCall.id;

        console.log(`  Executing tool: ${toolName} with ID: ${toolUseId}`);
        console.log(`  Arguments: ${JSON.stringify(toolInput)}`);

        const serverName = this.toolToServerMap.get(toolName);
        const client = serverName ? this.mcpClients.get(serverName) : undefined;

        if (!client) {
          console.error(`  ❌ Error: Cannot find server/client for tool "${toolName}". Skipping.`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: `Error: Tool "${toolName}" is not available or its server is disconnected.`,
            is_error: true,
          });
          continue; // Skip to next tool call
        }

        try {
          const result = (await client.callTool({
            name: toolName,
            arguments: toolInput as Record<string, unknown>, // Fixed: Pass validated/structured args
          })) as MCPToolCallResult;

          console.log(`  Tool "${toolName}" executed successfully on server "${serverName}".`);
          // console.log("  Raw tool result:", JSON.stringify(result, null, 2)); // Debugging

          // Format result content for Anthropic. Expecting text or structured content.
          // MCP returns { content: [{ type: 'text', text: '...' }], error?: boolean }
          // Anthropic expects string or [{ type: 'text', text: '...' }]
          let resultOutput: string = `Tool ${toolName} executed.`; // Default

          // Fixed: Check if content is an array with length property
          if (result.content && Array.isArray(result.content) && result.content.length > 0) {
            // Prioritize text content if available
            const textBlock = result.content.find((c: any) => c.type === 'text');
            if (textBlock && typeof textBlock.text === 'string') {
              resultOutput = textBlock.text;
            } else {
              // Fallback: stringify the whole content array if no simple text
              resultOutput = JSON.stringify(result.content);
            }
          } else if (result.error) {
            // Use error instead of deprecated isError
            resultOutput = `Tool ${toolName} reported an error.`;
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: resultOutput,
            is_error: result.error === true,
          });
        } catch (error: any) {
          console.error(`  ❌ Error calling tool "${toolName}" on server "${serverName}":`, error);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: `Error executing tool ${toolName}: ${error.message}`,
            is_error: true,
          });
        }
      } // End of tool call loop

      // --- Send Tool Results Back to Claude ---
      console.log('\nSending tool results back to Claude...');
      messages.push({
        role: 'user',
        content: toolResults,
      });

      const finalResponse = await this.anthropic.messages.create({
        model: 'claude-3-opus-20240229', // Use the same model
        max_tokens: 2048,
        messages: messages,
        // No tools needed here, just processing results
      });

      console.log("Claude's final response received.");

      // Append final text response from Claude
      const finalContent = finalResponse.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      finalAnswer += finalContent;
      console.log("Claude's final text:", finalContent);

      return finalAnswer.trim();
    } catch (error) {
      console.error('\n❌ An error occurred during query processing:', error);
      return `An error occurred: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // --- Interactive Chat Loop ---
  public async chatLoop(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      console.log('\n===== MCP Multi-Client Chat =====');
      console.log('Connected to servers:', Array.from(this.mcpClients.keys()).join(', '));
      console.log("Type your queries or 'quit' to exit.");

      while (true) {
        const message = await rl.question('\nQuery: ');
        if (message.toLowerCase() === 'quit') {
          break;
        }
        if (!message.trim()) {
          continue;
        }
        const response = await this.processQuery(message);
        console.log('\nClaude:', response);
      }
    } finally {
      rl.close();
    }
  }

  // --- Cleanup: Close Connections ---
  public async cleanup(): Promise<void> {
    console.log('\nShutting down client and closing connections...');
    const closePromises: Promise<void>[] = [];
    this.mcpClients.forEach((client, serverName) => {
      console.log(`  Closing connection to "${serverName}"...`);
      closePromises.push(
        client
          .close()
          .catch((e) => console.error(`  Error closing connection to ${serverName}:`, e)),
      );
    });
    await Promise.all(closePromises);
    console.log('All connections closed.');
  }
}

// --- Main Execution ---
async function main() {
  const defaultConfigFile = path.resolve(__dirname, '../mcp-servers.json');
  const configFile = process.argv[2] || defaultConfigFile;

  if (!fs.existsSync(configFile)) {
    console.error(`Error: Configuration file not found at "${configFile}"`);
    console.error(
      `Please provide the path as an argument or place mcp-servers.json next to the build output.`,
    );
    process.exit(1);
  }

  const mcpClient = new MCPMultiClient();

  try {
    mcpClient.loadConfig(configFile);
    await mcpClient.connectToServers();
    await mcpClient.chatLoop();
  } catch (error) {
    console.error('An unhandled error occurred:', error);
  } finally {
    await mcpClient.cleanup();
    console.log('MCP Multi-Client finished.');
    process.exit(0);
  }
}

void main();
