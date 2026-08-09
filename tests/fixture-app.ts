import { createServer, type Server } from 'node:http';

const page = (body: string, script = '') => `<!doctype html><html><body>${body}<script>${script}</script></body></html>`;

export async function startFixtureApp(): Promise<{ url: (path: string) => string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const route = request.url || '/send';
    const routes: Record<string, string> = {
      '/send': page('<label>Email <input aria-label="Email"></label><button>Send</button><output></output>', `document.querySelector('button').onclick=()=>setTimeout(()=>document.querySelector('output').textContent='Message sent',30)`),
      '/sent': page('<label>Email <input aria-label="Email"></label><button>Sent</button><output></output>', `document.querySelector('button').onclick=()=>document.querySelector('output').textContent='Message sent'`),
      '/missing': page('<label>Email <input aria-label="Email"></label><output>Unavailable</output>'),
      '/ambiguous': page('<button>Send</button><button>Send</button><output></output>', `document.querySelectorAll('button').forEach(b=>b.onclick=()=>document.querySelector('output').textContent='mutated')`),
      '/dialog': page('<button>Open composer</button><div id="mount"></div><output></output>', `document.querySelector('button').onclick=()=>{document.querySelector('#mount').innerHTML='<div role="dialog" aria-label="Composer"><label>Message <input aria-label="Message"></label><button>Send</button></div>';document.querySelector('[role=dialog] button').onclick=()=>document.querySelector('output').textContent='Message sent'}`),
      '/select': page('<label>Role <select><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label><dialog aria-label="Hidden settings"><button>Hidden action</button></dialog><output></output>', `document.querySelector('select').onchange=event=>document.querySelector('output').textContent=event.target.value`),
      '/delete': page('<button>Delete account</button><output></output>', `document.querySelector('button').onclick=()=>document.querySelector('output').textContent='deleted'`),
    };
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(routes[route] || routes['/send']);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to start fixture app');
  return { url: path => `http://127.0.0.1:${address.port}${path}`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
