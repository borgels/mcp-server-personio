import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PersonioClient, type PersonioClientOptions } from './personio/client.js';
import { registerPersonioTools } from './tools/personio.js';

export interface CreateServerOptions {
  client?: PersonioClient;
  clientOptions?: PersonioClientOptions;
  /** Gateway-verified end-user email; the employee profile pins all tools to this person. */
  onBehalfOf?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'personio',
    version: '0.1.0',
  });

  const client = options.client ?? new PersonioClient(options.clientOptions);
  registerPersonioTools(server, client, { onBehalfOf: options.onBehalfOf });

  return server;
}
