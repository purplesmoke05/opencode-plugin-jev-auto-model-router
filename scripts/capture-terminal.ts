import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { z } from "zod";

const { values } = parseArgs({
  options: {
    command: { type: "string" },
    output: { type: "string", default: "docs/usage.png" },
    input: { type: "string", multiple: true, default: [] },
    ready: { type: "string", default: "Ask anything" },
    wait: { type: "string", default: "Auto (Jev)" },
    cols: { type: "string", default: "110" },
    rows: { type: "string", default: "32" },
  },
});

class CaptureError extends Error {
  override readonly name = "CaptureError";
}

if (!values.command) throw new CaptureError("Pass --command with an isolated demo command.");
const command = values.command;
const columns = z.coerce.number().int().min(50).max(180).parse(values.cols);
const rows = z.coerce.number().int().min(15).max(60).parse(values.rows);
const executablePath =
  process.env["CHROME_BIN"] ?? Bun.which("google-chrome") ?? Bun.which("chromium");
if (!executablePath) throw new CaptureError("Set CHROME_BIN to a Chrome/Chromium executable.");

let child: ReturnType<typeof Bun.spawn> | undefined;
let raw = "";
const decoder = new TextDecoder();
const browser = await chromium.launch({ executablePath, headless: true });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, instance) {
    const path = new URL(request.url).pathname;
    if (path === "/socket" && instance.upgrade(request)) return;
    if (path === "/xterm.js")
      return new Response(Bun.file(Bun.resolveSync("@xterm/xterm/lib/xterm.js", import.meta.dir)));
    if (path === "/xterm.css")
      return new Response(Bun.file(Bun.resolveSync("@xterm/xterm/css/xterm.css", import.meta.dir)));
    if (path === "/unicode.js")
      return new Response(
        Bun.file(Bun.resolveSync("@xterm/addon-unicode11/lib/addon-unicode11.js", import.meta.dir)),
      );
    return new Response(
      `<!doctype html><html><head><link rel="stylesheet" href="/xterm.css">
<style>html,body{margin:0;background:#0a0a0a}#terminal{padding:12px;width:fit-content}</style></head>
<body><div id="terminal"></div><script src="/xterm.js"></script><script src="/unicode.js"></script>
<script>
const term = new Terminal({cols:${columns},rows:${rows},fontSize:16,fontFamily:'"DejaVu Sans Mono", monospace',allowProposedApi:true,theme:{background:'#0a0a0a',foreground:'#dedede'}});
term.loadAddon(new Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion='11';
term.open(document.getElementById('terminal')); term.focus();
const ws = new WebSocket('ws://'+location.host+'/socket');
ws.onmessage = e => term.write(e.data);
term.onData(data => {if(ws.readyState===1)ws.send(data)});
window.terminalText = () => Array.from({length:term.rows},(_,i)=>term.buffer.active.getLine(term.buffer.active.viewportY+i)?.translateToString(true)||'').join('\\n');
</script></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  },
  websocket: {
    open(socket) {
      child = Bun.spawn(["bash", "-c", command], {
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
        terminal: {
          cols: columns,
          rows,
          data(_terminal, data) {
            const text = decoder.decode(data, { stream: true });
            raw += text;
            socket.send(text);
          },
        },
      });
    },
    message(_socket, message) {
      child?.terminal?.write(typeof message === "string" ? message : new Uint8Array(message));
    },
  },
});

try {
  const page = await browser.newPage({
    viewport: { width: columns * 11 + 32, height: rows * 23 + 32 },
    deviceScaleFactor: 1,
  });
  await page.goto(server.url.href);
  page.on("pageerror", (error) => console.error(error.message));
  await page.waitForFunction(
    `window.terminalText && window.terminalText().includes(${JSON.stringify(values.ready)})`,
    undefined,
    { timeout: 60000 },
  );
  for (const input of values.input) {
    if (input.startsWith("{WaitFor:") && input.endsWith("}")) {
      await page.waitForFunction(
        `window.terminalText().includes(${JSON.stringify(input.slice(9, -1))})`,
        undefined,
        { timeout: 20000 },
      );
    } else if (input.startsWith("{") && input.endsWith("}"))
      await page.keyboard.press(input.slice(1, -1));
    else await page.keyboard.insertText(input);
  }
  await page.waitForFunction(
    `window.terminalText().includes(${JSON.stringify(values.wait)})`,
    undefined,
    { timeout: 60000 },
  );
  const output = resolve(values.output);
  await mkdir(resolve(output, ".."), { recursive: true });
  const text = z.string().parse(await page.evaluate("window.terminalText()"));
  await page.locator("#terminal").screenshot({ path: output });
  await Bun.write(`${output}.txt`, text);
  await Bun.write(`${output}.ansi`, raw);
  console.log(`Captured actual OpenCode PTY through xterm.js: ${output}`);
} finally {
  child?.kill();
  if (child) await child.exited;
  child?.terminal?.close();
  server.stop(true);
  await browser.close();
}
