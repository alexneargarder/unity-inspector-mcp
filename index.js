#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import net from 'net';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

class UnityInspectorClient {
  constructor() {
    this.host = null;
    this.port = 9999;
    this.connected = false;
  }

  async getServerHost() {
    // Check if running in WSL
    if (os.release().toLowerCase().includes('microsoft')) {
      try {
        // Get Windows host IP from default route
        const result = await execAsync('ip route show default');
        const host = result.stdout.split(' ')[2];
        console.error(`WSL detected, using Windows host: ${host}`);
        return host;
      } catch (e) {
        console.error('Failed to get WSL host, using fallback: 172.21.80.1');
        return '172.21.80.1';
      }
    }
    return '127.0.0.1';
  }

  async connect() {
    if (!this.host) {
      this.host = await this.getServerHost();
    }

    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      
      this.socket.connect(this.port, this.host, () => {
        this.connected = true;
        console.error(`Connected to Unity Inspector at ${this.host}:${this.port}`);
        resolve();
      });

      this.socket.on('error', (err) => {
        this.connected = false;
        reject(err);
      });

      this.socket.on('close', () => {
        this.connected = false;
        console.error('Connection to Unity Inspector closed');
      });
    });
  }

  async sendCommand(method, params = {}) {
    if (!this.connected) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      const message = JSON.stringify({
        id: Date.now().toString(),
        method: method,
        params: params
      }) + '\n';

      let responseData = '';

      const dataHandler = (data) => {
        responseData += data.toString();
        if (responseData.includes('\n')) {
          this.socket.removeListener('data', dataHandler);
          try {
            const response = JSON.parse(responseData.trim());
            if (response.success) {
              resolve(response.result);
            } else {
              reject(new Error(response.error || 'Command failed'));
            }
          } catch (e) {
            reject(new Error(`Invalid response: ${responseData}`));
          }
        }
      };

      this.socket.on('data', dataHandler);
      this.socket.write(message);

      // Timeout after 5 seconds
      setTimeout(() => {
        this.socket.removeListener('data', dataHandler);
        reject(new Error('Command timeout'));
      }, 5000);
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.destroy();
      this.connected = false;
    }
  }
}

const unityClient = new UnityInspectorClient();

const server = new Server(
  {
    name: "unity-inspector-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "ping",
        description: "Test connection to Unity Inspector",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_gameobjects",
        description: "List all GameObjects in the scene",
        inputSchema: {
          type: "object",
          properties: {
            includeInactive: {
              type: "boolean",
              description: "Include inactive GameObjects",
              default: true,
            },
          },
        },
      },
      {
        name: "inspect_gameobject",
        description: "Inspect a specific GameObject by path",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the GameObject (e.g., '/Player')",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "query_gameobjects",
        description: "Search for GameObjects by name or component",
        inputSchema: {
          type: "object",
          properties: {
            namePattern: {
              type: "string",
              description: "Name pattern to search for",
            },
            componentType: {
              type: "string",
              description: "Component type to filter by",
            },
            includeInactive: {
              type: "boolean",
              description: "Include inactive GameObjects",
              default: true,
            },
            maxResults: {
              type: "number",
              description: "Maximum number of results",
              default: 100,
            },
          },
        },
      },
      {
        name: "inspect_player",
        description: "Get detailed information about the player(s)",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_enemies",
        description: "List all enemies in the scene",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "take_screenshot",
        description: "Take a screenshot of the game",
        inputSchema: {
          type: "object",
          properties: {
            filename: {
              type: "string",
              description: "Filename for the screenshot",
              default: "latest.png",
            },
          },
        },
      },
      {
        name: "execute_code",
        description: "Execute C# code in the Unity context (not yet implemented)",
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "C# code to execute",
            },
          },
          required: ["code"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case "ping":
        result = await unityClient.sendCommand("ping");
        break;

      case "list_gameobjects":
        result = await unityClient.sendCommand("list_gameobjects", {
          includeInactive: args.includeInactive ?? true,
        });
        break;

      case "inspect_gameobject":
        if (!args.path) {
          throw new Error("GameObject path is required");
        }
        result = await unityClient.sendCommand("inspect_gameobject", {
          path: args.path,
        });
        break;

      case "query_gameobjects":
        result = await unityClient.sendCommand("query_gameobjects", {
          namePattern: args.namePattern,
          componentType: args.componentType,
          includeInactive: args.includeInactive ?? true,
          maxResults: args.maxResults ?? 100,
        });
        break;

      case "inspect_player":
        result = await unityClient.sendCommand("inspect_player");
        break;

      case "list_enemies":
        result = await unityClient.sendCommand("list_enemies");
        break;

      case "take_screenshot":
        result = await unityClient.sendCommand("take_screenshot", {
          filename: args.filename ?? "latest.png",
        });
        break;

      case "execute_code":
        if (!args.code) {
          throw new Error("Code is required");
        }
        result = await unityClient.sendCommand("execute_code", {
          code: args.code,
        });
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error(`Tool error: ${error.message}`);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Cleanup on exit
process.on('SIGINT', () => {
  console.error('Shutting down Unity Inspector MCP server...');
  unityClient.disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  unityClient.disconnect();
  process.exit(0);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Unity Inspector MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});