/**
 * Serves the test fixtures page so it can be opened in VS Code's Simple Browser
 * (Ctrl+Shift+P, "Simple Browser: Show") rather than a separate Windows browser.
 *
 * Two reasons this beats opening the file directly:
 *
 *   - the page is regenerated on every request, so editing the fixture list in
 *     test_fixtures.mjs and hitting refresh is the whole loop
 *   - http://localhost is a secure context, so the copy buttons use the real
 *     clipboard API instead of the execCommand fallback file:// forces
 *
 * Binds to loopback only. Nothing here is secret, but the page has no business
 * being reachable from the rest of the network.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

import { OUTPUT, fixtureSummary, render } from './test_fixtures.mjs';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;

function chosenPort() {
  const flag = process.argv.indexOf('--port');
  const raw = flag !== -1 ? process.argv[flag + 1] : process.env.FIXTURES_PORT;
  const port = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }

  const path = new URL(req.url ?? '/', `http://${HOST}`).pathname;
  if (path !== '/' && path !== '/fixtures.html') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found\n');
    return;
  }

  try {
    const problems = await render();
    for (const problem of problems) console.error(`  fixture problem — ${problem}`);

    const html = readFileSync(OUTPUT);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': html.length,
      // The point of regenerating per request is defeated by a cached response.
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  } catch (err) {
    console.error(err);
    res
      .writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      .end(`Could not build fixtures:\n${err.stack ?? err.message}\n`);
  }
});

const port = chosenPort();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Try: npm run fixtures:serve -- --port ${port + 1}`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, HOST, () => {
  console.log(`Serving ${fixtureSummary()} at http://localhost:${port}`);
  console.log('VS Code: Ctrl+Shift+P, "Simple Browser: Show", then paste that URL.');
  console.log('Rebuilt on every request, so edit test_fixtures.mjs and refresh. Ctrl+C to stop.');
});
