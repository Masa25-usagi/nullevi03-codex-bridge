import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, readConfig, splitTelegramText } from "../src/bridge.mjs";

test("Telegram の 4096 文字制限で文章を分割する", () => {
  const text = `${"a".repeat(4090)}\n${"b".repeat(20)}`;
  const chunks = splitTelegramText(text);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 4096));
  assert.equal(chunks.join("\n"), text);
});

test("必須の Telegram 設定を検証する", () => {
  assert.throws(() => readConfig({}), BridgeError);
});

test("有効な設定を読み込む", () => {
  const config = readConfig({
    TELEGRAM_BOT_TOKEN: "123:token",
    TELEGRAM_CHAT_ID: "456",
    CODEX_CWD: "/tmp/codex-workspace",
    TELEGRAM_POLL_TIMEOUT_SECONDS: "10",
  });
  assert.equal(config.telegramChatId, "456");
  assert.equal(config.pollTimeout, 10);
});
