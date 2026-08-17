import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE_PATH = '/ModelTree/';
const VIEWPORT = { width: 320, height: 900 };
const CLASSIC_SCROLLBAR_WIDTH = 15;
const LAYOUT_WIDTH = VIEWPORT.width - CLASSIC_SCROLLBAR_WIDTH;
const routes = [
  { name: 'model tree', path: `${BASE_PATH}tree/` },
  { name: 'home', path: BASE_PATH },
];

type LayoutMetrics = {
  path: string;
  screenWidth: number;
  innerWidth: number;
  clientWidth: number;
  scrollWidth: number;
};
type ProtocolMessage = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message: string };
};
type EvaluationResult<T> = {
  result: { value?: T; description?: string };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string };
  };
};

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getFreePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate a local test port.');
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function findBrowser() {
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    process.env.BROWSER_PATH,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    localAppData && join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    localAppData && join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter((candidate): candidate is string => Boolean(candidate));

  const browser = candidates.find(existsSync);
  if (!browser) {
    throw new Error(
      'Responsive route tests require an installed Chromium browser. '
      + 'Set BROWSER_PATH when Chrome or Edge is not in a standard location.',
    );
  }
  return browser;
}

class DevToolsClient {
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>();
  private events = new Map<string, Array<() => void>>();

  private constructor(private socket: WebSocket) {
    socket.addEventListener('close', () => {
      this.pending.forEach(({ reject }) => reject(new Error('DevTools connection closed.')));
      this.pending.clear();
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const message = JSON.parse(event.data) as ProtocolMessage;

      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
        return;
      }

      if (message.method) {
        const listeners = this.events.get(message.method) ?? [];
        this.events.delete(message.method);
        listeners.forEach((resolve) => resolve());
      }
    });
  }

  static async connect(url: string) {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error('Could not connect to the Chromium DevTools endpoint.')),
        { once: true },
      );
    });
    return new DevToolsClient(socket);
  }

  send<T>(method: string, params: Record<string, unknown> = {}) {
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  waitFor(method: string) {
    return new Promise<void>((resolve) => {
      const listeners = this.events.get(method) ?? [];
      listeners.push(resolve);
      this.events.set(method, listeners);
    });
  }

  close() {
    this.socket.close();
  }
}

async function waitForPageTarget(port: number, browserProcess: ChildProcess) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    if (browserProcess.exitCode !== null) {
      throw new Error(`Chromium exited before exposing DevTools (code ${browserProcess.exitCode}).`);
    }

    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const targets = await response.json() as Array<{
          type: string;
          webSocketDebuggerUrl?: string;
        }>;
        const page = targets.find((target) => (
          target.type === 'page' && target.webSocketDebuggerUrl
        ));
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {
      // Chromium is still starting.
    }
    await delay(50);
  }

  throw new Error('Timed out waiting for Chromium to expose a page DevTools target.');
}

async function waitForAstro(astroProcess: ChildProcess, getLogs: () => string) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (astroProcess.exitCode !== null) {
      throw new Error(`Astro exited before serving routes (code ${astroProcess.exitCode}).`);
    }
    if (getLogs().includes('watching for file changes')) {
      // Astro logs readiness before its middleware is consistently reachable.
      await delay(2_000);
      return;
    }
    await delay(50);
  }

  throw new Error(`Timed out waiting for Astro.\n${getLogs()}`);
}

describe('320px route layout', () => {
  let astroProcess: ChildProcess;
  let browserProcess: ChildProcess;
  let browserProfile: string;
  let client: DevToolsClient;
  let origin: string;
  let astroLogs = '';

  beforeAll(async () => {
    const serverPort = await getFreePort();
    const devToolsPort = await getFreePort();
    const webRoot = fileURLToPath(new URL('..', import.meta.url));
    const astroCli = fileURLToPath(new URL('../node_modules/astro/bin/astro.mjs', import.meta.url));
    const astroEnv: NodeJS.ProcessEnv = {
      ...process.env,
      BASE_PATH,
      NODE_ENV: 'development',
    };
    Object.keys(astroEnv)
      .filter((name) => name.startsWith('VITEST'))
      .forEach((name) => delete astroEnv[name]);
    origin = `http://127.0.0.1:${serverPort}`;
    astroProcess = spawn(
      process.execPath,
      [
        astroCli,
        'dev',
        '--ignore-lock',
        '--host',
        '127.0.0.1',
        `--port=${serverPort}`,
      ],
      {
        cwd: webRoot,
        env: astroEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    astroProcess.stdout?.on('data', (chunk) => { astroLogs += chunk.toString(); });
    astroProcess.stderr?.on('data', (chunk) => { astroLogs += chunk.toString(); });
    await waitForAstro(astroProcess, () => astroLogs);

    browserProfile = await mkdtemp(join(tmpdir(), 'modeltree-browser-'));
    browserProcess = spawn(findBrowser(), [
      '--headless=new',
      '--disable-gpu',
      '--disable-features=OverlayScrollbar,OverlayScrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${devToolsPort}`,
      `--user-data-dir=${browserProfile}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      'about:blank',
    ], { stdio: 'ignore' });

    client = await DevToolsClient.connect(await waitForPageTarget(devToolsPort, browserProcess));
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setScrollbarsHidden', { hidden: false });
  }, 45_000);

  async function measureRoute(path: string, viewportWidth: number) {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: viewportWidth,
      height: VIEWPORT.height,
      screenWidth: VIEWPORT.width,
      screenHeight: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const loaded = client.waitFor('Page.loadEventFired');
    await client.send('Page.navigate', { url: `${origin}${path}` });
    await loaded;

    const evaluation = await client.send<EvaluationResult<LayoutMetrics>>(
      'Runtime.evaluate',
      {
        expression: `(async () => {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            if (getComputedStyle(document.documentElement).getPropertyValue('--cp-bg')) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          if (!getComputedStyle(document.documentElement).getPropertyValue('--cp-bg')) {
            throw new Error('Global stylesheet did not load.');
          }
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return {
            path: location.pathname,
            screenWidth: screen.width,
            innerWidth,
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth
          };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      },
    );
    if (evaluation.exceptionDetails) {
      throw new Error(
        evaluation.exceptionDetails.exception?.description
        ?? evaluation.exceptionDetails.text,
      );
    }
    if (!evaluation.result.value) {
      throw new Error(evaluation.result.description ?? 'Chromium returned no layout metrics.');
    }
    return evaluation.result.value;
  }

  afterAll(async () => {
    if (browserProcess && browserProcess.exitCode === null) {
      const exited = new Promise((resolve) => browserProcess.once('exit', resolve));
      try {
        await Promise.race([client.send('Browser.close'), delay(2_000)]);
      } catch {
        client.close();
      }
      await Promise.race([exited, delay(5_000)]);
    }
    if (browserProcess && browserProcess.exitCode === null) {
      const exited = new Promise((resolve) => browserProcess.once('exit', resolve));
      browserProcess.kill();
      await Promise.race([exited, delay(5_000)]);
    }
    if (astroProcess && astroProcess.exitCode === null) {
      const exited = new Promise((resolve) => astroProcess.once('exit', resolve));
      astroProcess.kill();
      await Promise.race([exited, delay(5_000)]);
    }
    if (browserProfile) {
      await rm(browserProfile, {
        force: true,
        recursive: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  }, 30_000);

  it.each(routes)('keeps the $name route within the viewport', async ({ path }) => {
    const response = await fetch(`${origin}${path}`, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200);

    let metrics = await measureRoute(path, VIEWPORT.width);
    if (metrics.clientWidth === VIEWPORT.width) {
      // Overlay-scrollbar browsers do not reserve the 15px that exposed the QA
      // failure. Emulate the same 305px layout viewport while retaining a 320px screen.
      metrics = await measureRoute(path, LAYOUT_WIDTH);
    }

    expect(metrics.path).toBe(path);
    expect(metrics.screenWidth).toBe(VIEWPORT.width);
    expect(metrics.clientWidth).toBe(LAYOUT_WIDTH);
    expect(
      metrics.scrollWidth,
      `${path} overflowed: ${metrics.scrollWidth}px > ${metrics.clientWidth}px`,
    ).toBeLessThanOrEqual(metrics.clientWidth);
  }, 20_000);
});
