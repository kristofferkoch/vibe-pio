// browser.js — a zero-dependency headless-Chromium CDP client for the
// layout gate (web/tests/layout.test.js). Node >= 22 ships a stable
// global WebSocket, so Chrome's DevTools protocol needs nothing outside
// the standard library — the same "runtime stays dependency-free"
// discipline as everything else under web/ (npm exists for biome only).
//
// Firefox is not drivable from here: it dropped CDP support (the Remote
// Agent) in 2024; its automation surface is WebDriver BiDi. If a
// Firefox leg ever matters, it joins as a second driver behind the same
// launch/newPage/evaluate shape — the layout tests stay protocol-blind.

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Discovery: $PIO_BROWSER wins (lets a container or a nonstandard build
// pin the binary), then the usual chromium/chrome names on PATH.
const CANDIDATES = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chrome',
  'headless_shell',
];

function findBrowser() {
  if (process.env.PIO_BROWSER) return process.env.PIO_BROWSER;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of CANDIDATES) {
      const p = path.join(dir, name);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

// One headless Chromium; each call gets a throwaway profile so a stale
// user session can never leak into the gate. --remote-debugging-port=0
// makes Chrome pick a free port and print the DevTools endpoint on
// stderr — that line is the handshake.
async function launch() {
  const exe = findBrowser();
  if (!exe) {
    throw new Error(
      'layout gate: no Chromium found — install chromium (or set PIO_BROWSER=/path/to/chrome). ' +
        'Firefox cannot drive this gate: it dropped CDP; see docs/js-tooling.md.',
    );
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pio-layout-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--window-size=1280,800',
    'about:blank',
  ];
  // containers run as root; Chromium refuses its sandbox there
  if (process.getuid && process.getuid() === 0) args.unshift('--no-sandbox');
  // detached = own process group, so close() can SIGKILL the whole
  // tree: killing the parent alone leaves the renderer/crashpad
  // children writing into the profile (CI red, run 34059566631: the
  // after-hook's rmSync hit ENOTEMPTY and the orphans hung the job)
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(
      () => reject(new Error(`layout gate: ${exe} printed no DevTools endpoint`)),
      15000,
    );
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`layout gate: ${exe} exited early:\n${buf}`));
    });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('layout gate: browser websocket failed'));
  });

  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject}
  const events = []; // page-level events (only loadEventFired matters)
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(`CDP ${m.error.message} (${m.method || 'response'})`));
      else resolve(m.result);
    } else if (m.method) {
      events.push(m);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  async function newPage() {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const page = {
      send: (method, params) => send(method, params, sessionId),
      // Exact logical viewport regardless of the window's chrome: the
      // 13"-laptop reference sizes are assertions, not hopes.
      async setViewport(width, height) {
        await page.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
      },
      async goto(target) {
        await page.send('Page.enable');
        const loaded = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`page load timeout: ${target}`)), 15000);
          const poll = setInterval(() => {
            const i = events.findIndex(
              (ev) => ev.method === 'Page.loadEventFired' && ev.sessionId === sessionId,
            );
            if (i >= 0) {
              events.splice(0, i + 1);
              clearInterval(poll);
              clearTimeout(timer);
              resolve();
            }
          }, 20);
          poll.unref();
        });
        await page.send('Page.navigate', { url: target });
        await loaded;
      },
      // Global-scope eval: classic-script top-level bindings (V, render)
      // are visible here even though they are not window properties.
      async evaluate(expression) {
        const r = await page.send('Runtime.evaluate', {
          expression,
          returnByValue: true,
        });
        if (r.exceptionDetails) {
          throw new Error(
            `page eval failed: ${r.exceptionDetails.exception?.description || expression}`,
          );
        }
        return r.result.value;
      },
      async close() {
        await send('Target.closeTarget', { targetId });
      },
    };
    return page;
  }

  return {
    newPage,
    async close() {
      // kill first, socket second: the browser's death RSTs the CDP
      // connection, which tears undici's socket down for real. The
      // reverse order (a graceful close handshake racing SIGKILL)
      // leaves a half-open socket holding node's event loop — and this
      // gate — open forever. The group kill (negative pid — proc was
      // spawned detached) takes the children down with the parent.
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      proc.kill('SIGKILL');
      proc.stderr.destroy();
      await new Promise((resolve) => {
        ws.onclose = resolve;
        ws.onerror = resolve;
        const bail = setTimeout(resolve, 2000);
        bail.unref();
      });
      // best-effort: a leaked /tmp profile must never fail the gate
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        // children still flushing — the OS reaps /tmp
      }
    },
  };
}

module.exports = { launch, findBrowser };
