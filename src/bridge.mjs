import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(moduleDir, "..");
const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;

export class BridgeError extends Error {}

export function splitTelegramText(text, maxLength = MAX_TELEGRAM_MESSAGE_LENGTH) {
  const value = String(text ?? "");
  if (value.length <= maxLength) return [value || "（Codex からテキストの回答は返されませんでした）"];

  const chunks = [];
  let remaining = value;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < Math.floor(maxLength * 0.6)) splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt < Math.floor(maxLength * 0.6)) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\s+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function readConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) throw new BridgeError("TELEGRAM_BOT_TOKEN と TELEGRAM_CHAT_ID は必須です。");

  const cwd = path.resolve(env.CODEX_CWD?.trim() || projectDir);
  const pollTimeout = Number(env.TELEGRAM_POLL_TIMEOUT_SECONDS || 30);
  if (!Number.isInteger(pollTimeout) || pollTimeout < 1 || pollTimeout > 50) {
    throw new BridgeError("TELEGRAM_POLL_TIMEOUT_SECONDS は 1〜50 の整数で指定してください。");
  }

  return {
    telegramToken: token,
    telegramChatId: chatId,
    codexBin: env.CODEX_BIN?.trim() || "codex",
    codexCwd: cwd,
    model: env.CODEX_MODEL?.trim() || null,
    effort: env.CODEX_EFFORT?.trim() || null,
    pollTimeout,
    statePath: path.resolve(env.BRIDGE_STATE_PATH?.trim() || path.join(projectDir, "data", "state.json")),
  };
}

export async function assertDirectory(directory) {
  try {
    await access(directory, fsConstants.R_OK);
    const info = await stat(directory);
    if (!info.isDirectory()) throw new BridgeError(`${directory} はディレクトリではありません。`);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(`CODEX_CWD を読み取れません: ${directory}`);
  }
}

export class StateStore {
  constructor(statePath) {
    this.statePath = statePath;
  }

  async load() {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        version: 1,
        telegramOffset: Number.isInteger(parsed.telegramOffset) ? parsed.telegramOffset : 0,
        threadId: typeof parsed.threadId === "string" && parsed.threadId ? parsed.threadId : null,
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, telegramOffset: 0, threadId: null };
      throw new BridgeError(`状態ファイルを読み込めません: ${error.message}`);
    }
  }

  async save(state) {
    const directory = path.dirname(this.statePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.statePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.statePath);
  }
}

export class TelegramClient {
  constructor(token) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async call(method, fields = {}) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) body.set(key, String(value));
    }

    let response;
    try {
      response = await fetch(`${this.baseUrl}/${method}`, { method: "POST", body, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      throw new BridgeError(`Telegram ${method} への接続に失敗しました: ${error.message}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new BridgeError(`Telegram ${method} が JSON 以外を返しました (HTTP ${response.status})。`);
    }
    if (!response.ok || !payload.ok) {
      throw new BridgeError(`Telegram ${method} に失敗しました: ${payload.description || `HTTP ${response.status}`}`);
    }
    return payload.result;
  }

  getUpdates(offset, timeout) {
    return this.call("getUpdates", { offset, timeout, allowed_updates: JSON.stringify(["message"]) });
  }

  async sendText(chatId, text) {
    for (const chunk of splitTelegramText(text)) {
      await this.call("sendMessage", { chat_id: chatId, text: chunk, disable_web_page_preview: "true" });
    }
  }
}

export class AppServerClient {
  constructor(config) {
    this.config = config;
    this.process = null;
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.turnText = new Map();
    this.completedTurns = new Map();
    this.turnWaiters = new Map();
  }

  async start() {
    const args = [
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      this.config.codexCwd,
      "app-server",
      "--stdio",
    ];
    this.process = spawn(this.config.codexBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.process.on("error", (error) => this.#close(new BridgeError(`Codex を起動できません: ${error.message}`)));
    this.process.on("close", (code, signal) => {
      this.#close(new BridgeError(`Codex App Server が終了しました (code=${code}, signal=${signal || "none"})。`));
    });
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (data) => process.stderr.write(`[codex] ${data}`));
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.#onLine(line));
    await this.request("initialize", {
      clientInfo: { name: "nullevi03_codex_telegram", title: "nullevi03 Codex Telegram bridge", version: "0.1.0" },
    });
    this.notify("initialized", {});
  }

  stop() {
    this.closed = true;
    this.process?.kill("SIGTERM");
  }

  notify(method, params) {
    this.#write({ method, params });
  }

  request(method, params, timeoutMs = 60_000) {
    if (this.closed) return Promise.reject(new BridgeError("Codex App Server は停止しています。"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`Codex App Server の ${method} が時間切れになりました。`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.#write({ method, id, params });
    });
  }

  async ensureThread(previousThreadId) {
    const params = {
      cwd: this.config.codexCwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ...(this.config.model ? { model: this.config.model } : {}),
    };
    let result;
    if (previousThreadId) {
      try {
        result = await this.request("thread/resume", { threadId: previousThreadId, ...params });
      } catch (error) {
        console.error(`保存済み Codex スレッドを再開できないため、新規に開始します: ${error.message}`);
      }
    }
    if (!result) result = await this.request("thread/start", params);
    this.#assertUnsafeMode(result);
    return result.thread.id;
  }

  async runTurn(threadId, text) {
    console.error(`Starting Codex turn for thread=${threadId}`);
    const result = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      cwd: this.config.codexCwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.effort ? { effort: this.config.effort } : {}),
    });
    console.error(`Codex turn accepted: ${result.turn.id}`);
    const completed = await this.#waitForTurn(result.turn.id);
    console.error(`Codex turn completed: ${result.turn.id} (${completed.turn.status})`);
    if (completed.turn.status !== "completed") {
      const detail = completed.turn.error?.message || completed.turn.status;
      throw new BridgeError(`Codex の処理が完了しませんでした: ${detail}`);
    }
    const streamed = this.turnText.get(result.turn.id)?.trim();
    const fromItems = completed.turn.items
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.text)
      .join("\n")
      .trim();
    this.turnText.delete(result.turn.id);
    return streamed || fromItems || "（Codex からテキストの回答は返されませんでした）";
  }

  #assertUnsafeMode(result) {
    if (result?.approvalPolicy !== "never" || result?.sandbox?.type !== "dangerFullAccess") {
      throw new BridgeError("Codex App Server が approvalPolicy=never / danger-full-access で開始されませんでした。安全側へフォールバックしたまま起動しません。");
    }
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.error(`Codex App Server から不正な JSON を受信しました: ${line}`);
      return;
    }

    if (message.method && Object.hasOwn(message, "id")) {
      this.#respondToServerRequest(message);
      return;
    }
    if (Object.hasOwn(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new BridgeError(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const { turnId, delta } = message.params || {};
      if (turnId && typeof delta === "string") this.turnText.set(turnId, `${this.turnText.get(turnId) || ""}${delta}`);
      return;
    }
    if (message.method === "turn/completed") {
      const turnId = message.params?.turn?.id;
      if (!turnId) return;
      this.completedTurns.set(turnId, message.params);
      const waiter = this.turnWaiters.get(turnId);
      if (waiter) {
        this.turnWaiters.delete(turnId);
        waiter.resolve(message.params);
      }
    }
  }

  #respondToServerRequest(message) {
    console.error(`Codex App Server requested: ${message.method}`);
    let result;
    switch (message.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        result = { decision: "accept" };
        break;
      case "execCommandApproval":
      case "applyPatchApproval":
        result = { decision: "approved" };
        break;
      case "item/permissions/requestApproval":
        result = { permissions: message.params.permissions, scope: "session" };
        break;
      default:
        this.#write({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } });
        return;
    }
    this.#write({ id: message.id, result });
  }

  #waitForTurn(turnId) {
    const completed = this.completedTurns.get(turnId);
    if (completed) return Promise.resolve(completed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(new BridgeError("Codex のターン完了通知が時間切れになりました。"));
      }, 30 * 60_000);
      this.turnWaiters.set(turnId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
  }

  #write(message) {
    if (!this.process?.stdin.writable) throw new BridgeError("Codex App Server の入力が閉じています。");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const [, waiter] of this.turnWaiters) waiter.reject(error);
    this.turnWaiters.clear();
  }
}

export async function runBridge(config) {
  await assertDirectory(config.codexCwd);
  const stateStore = new StateStore(config.statePath);
  const state = await stateStore.load();
  const telegram = new TelegramClient(config.telegramToken);
  const appServer = new AppServerClient(config);
  await appServer.start();

  const stop = () => appServer.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    state.threadId = await appServer.ensureThread(state.threadId);
    await stateStore.save(state);
    console.error(`Telegram bridge ready (chat_id=${config.telegramChatId}, thread=${state.threadId})`);

    while (!appServer.closed) {
      const updates = await telegram.getUpdates(state.telegramOffset, config.pollTimeout);
      for (const update of updates) {
        if (!Number.isInteger(update.update_id)) continue;
        state.telegramOffset = update.update_id + 1;
        await stateStore.save(state);

        const message = update.message;
        if (!message || String(message.chat?.id) !== config.telegramChatId || typeof message.text !== "string") continue;
        try {
          const answer = await appServer.runTurn(state.threadId, message.text);
          await telegram.sendText(config.telegramChatId, answer);
        } catch (error) {
          console.error(error);
          await telegram.sendText(config.telegramChatId, `Codex bridge error: ${error.message}`);
          if (appServer.closed) throw error;
        }
      }
    }
  } finally {
    appServer.stop();
  }
}

async function main() {
  try {
    await runBridge(readConfig());
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
