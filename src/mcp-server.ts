import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApexMcpServer } from './mcp.js';

const server = createApexMcpServer();
await server.connect(new StdioServerTransport());
