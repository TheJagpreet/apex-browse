import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const rawPath = resolve(process.argv[2] ?? 'benchmark/results/raw-luna-2026-08-09.jsonl');
const repositoryRoot = process.cwd();

function sanitizeString(value: string): string {
  return value
    .replaceAll(repositoryRoot, '<REPOSITORY_ROOT>')
    .replaceAll(repositoryRoot.replaceAll('\\', '/'), '<REPOSITORY_ROOT>')
    .replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://benchmark.local')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, '<USER_HOME>')
    .replace(/[A-Za-z]:\/Users\/[^/\s"']+/g, '<USER_HOME>')
    .replace(/C:\\Program Files\\nodejs\\node\.exe/gi, 'node');
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === 'thread_id' ? '<REDACTED_THREAD_ID>' : sanitizeValue(entry)]));
  return value;
}

const records = (await readFile(rawPath, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
for (const record of records) {
  if (record.type !== 'metadata') continue;
  const node = record.runtime?.node ?? record.environment?.node;
  delete record.environment;
  delete record.git;
  record.runtime = node ? { node } : undefined;
  record.apexMcpCommand = 'node dist/mcp-server.js';
  record.machineDetailsRedacted = true;
}
await writeFile(rawPath, `${records.map(record => JSON.stringify(sanitizeValue(record))).join('\n')}\n`);

const transcriptDir = join(dirname(rawPath), `${basename(rawPath, '.jsonl')}-transcripts`);
for (const filename of (await readdir(transcriptDir)).filter(file => file.endsWith('.json'))) {
  const path = join(transcriptDir, filename);
  const transcript = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, `${JSON.stringify(sanitizeValue(transcript), null, 2)}\n`);
}

process.stdout.write(`Sanitized ${records.length} raw records and benchmark transcripts.\n`);
