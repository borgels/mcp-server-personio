#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../server.js';
import { readEnvString } from '../config-env.js';

async function main(): Promise<void> {
  // Local use only: stdio has no gateway, so the employee profile acts as
  // PERSONIO_DEFAULT_USER (your own Personio email) when set.
  const server = createServer({ onBehalfOf: readEnvString('PERSONIO_DEFAULT_USER') });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
