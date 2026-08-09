import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { workloads, type WorkloadId } from './workloads.js';

type RecordedOutcome = { workload: WorkloadId; payload: Record<string, unknown>; recordedAt: string };

const outcomes = new Map<WorkloadId, RecordedOutcome>();

const shell = (title: string, body: string, script: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;max-width:760px;margin:40px auto;padding:0 20px}label{display:block;margin:12px 0}input,select,button{font:inherit;padding:7px}nav a{margin-right:18px}.noise{color:#666}dialog{padding:24px;border:1px solid #777}</style></head>
<body><header><nav><a href="#docs">Documentation</a><a href="#support">Support</a><a href="#account">Account</a></nav></header>
<main><h1>${title}</h1><p class="noise">Controlled benchmark application. All submitted values are checked by an independent server-side oracle.</p>${body}</main>
<script>const record=(workload,payload)=>fetch('/api/record',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workload,payload})});${script}</script></body></html>`;

const profileFields = (drift: boolean) => drift ? `
<section><form id="profile"><div><label>First name <span><input name="firstName" autocomplete="off"></span></label></div>
<fieldset><legend>Identity</legend><label>Last name <input name="lastName" autocomplete="off"></label><label>Email <input name="email" type="email" autocomplete="off"></label></fieldset>
<div><label>Role <select name="role"><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label></div>
<p><label><input name="terms" type="checkbox"> Terms and conditions</label></p><footer><button type="submit">Save profile</button></footer></form><output id="status"></output></section>` : `
<form id="profile"><label>First name <input name="firstName" autocomplete="off"></label><label>Last name <input name="lastName" autocomplete="off"></label>
<label>Email <input name="email" type="email" autocomplete="off"></label><label>Role <select name="role"><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label>
<label><input name="terms" type="checkbox"> Terms and conditions</label><button type="submit">Save profile</button></form><output id="status"></output>`;

const profilePage = (drift: boolean) => shell('Profile editor', profileFields(drift), `
document.querySelector('#profile').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.currentTarget);await record('${drift ? 'profile-drift' : 'profile'}',{firstName:form.get('firstName'),lastName:form.get('lastName'),email:form.get('email'),role:form.get('role'),terms:form.get('terms')==='on'});document.querySelector('#status').textContent='Profile saved';});`);

const dialogPage = shell('Workspace', `<button id="open">Open team settings</button><dialog aria-label="Team settings"><form id="settings">
<h2>Team settings</h2><label>Team name <input name="teamName"></label><label>Time zone <select name="timeZone"><option value="utc">UTC</option><option value="ist">India Standard Time</option></select></label>
<label><input name="notifications" type="checkbox"> Email notifications</label><button type="submit">Save changes</button></form></dialog><output id="status"></output>`, `
const dialog=document.querySelector('dialog');document.querySelector('#open').addEventListener('click',()=>dialog.showModal());document.querySelector('#settings').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.currentTarget);await record('dialog',{teamName:form.get('teamName'),timeZone:form.get('timeZone'),notifications:form.get('notifications')==='on'});dialog.close();document.querySelector('#status').textContent='Team settings saved';});`);

const renamedPage = shell('Message composer', `<form id="message"><label>Message <input name="message"></label><button type="submit">Sent</button></form><output id="status"></output>`, `
let activation='implicit-submit';document.querySelector('#message button').addEventListener('click',event=>{activation=event.detail>0?'button-click':'implicit-submit';});document.querySelector('#message').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.currentTarget);await record('renamed-control',{message:form.get('message'),activation});document.querySelector('#status').textContent='Message sent';});`);

const catalogPage = shell('Product catalog', `<label>Search catalog <input id="query" type="search"></label><button id="search">Search</button><section id="results" aria-live="polite"></section><section id="details"></section>`, `
const showResults=()=>{const query=document.querySelector('#query').value;document.querySelector('#results').innerHTML='<h2>Results</h2><a href="#galaxy">Galaxy S25 Ultra</a><br><a href="#case">Galaxy S25 Ultra Case</a>';document.querySelector('#results a').addEventListener('click',async event=>{event.preventDefault();await record('catalog',{query,product:'Galaxy S25 Ultra'});document.querySelector('#details').innerHTML='<h2>Product details</h2><p>Galaxy S25 Ultra</p>';});};document.querySelector('#search').addEventListener('click',showResults);document.querySelector('#query').addEventListener('keydown',event=>{if(event.key==='Enter')showResults();});`);

const pages = new Map<string, string>([
  ['/profile', profilePage(false)], ['/profile-drift', profilePage(true)], ['/dialog', dialogPage],
  ['/renamed-control', renamedPage], ['/catalog', catalogPage],
]);

const readJson = async (request: import('node:http').IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

export type BenchmarkServer = { server: Server; baseUrl: string; close(): Promise<void>; reset(id?: WorkloadId): void; outcome(id: WorkloadId): RecordedOutcome | undefined };

export async function startBenchmarkServer(port = 0): Promise<BenchmarkServer> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/api/record') {
      try {
        const body = await readJson(request) as { workload: WorkloadId; payload: Record<string, unknown> };
        if (!workloads.some(item => item.id === body.workload)) throw new Error('Unknown workload');
        outcomes.set(body.workload, { workload: body.workload, payload: body.payload, recordedAt: new Date().toISOString() });
        response.writeHead(204).end();
      } catch (error) { response.writeHead(400, { 'content-type': 'text/plain' }).end(String(error)); }
      return;
    }
    const html = pages.get(url.pathname);
    if (html) { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html); return; }
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Benchmark server did not bind to TCP');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => { server.close(); await once(server, 'close'); },
    reset: id => { if (id) outcomes.delete(id); else outcomes.clear(); },
    outcome: id => outcomes.get(id),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) {
  const app = await startBenchmarkServer(Number(process.env.APEX_BENCHMARK_PORT ?? 4173));
  process.stdout.write(`${app.baseUrl}\n`);
}
