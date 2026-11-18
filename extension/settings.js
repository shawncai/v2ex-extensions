import { getCredentials, setToken } from "./session.js";

const MAX_TOKEN_LENGTH = 4096;
const MAX_FILE_BYTES = 128 * 1024;

function validateToken(value) {
  if (!value) throw new Error("请输入个人访问令牌。");
  if (value.length > MAX_TOKEN_LENGTH || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error("令牌格式有误，请检查是否包含空格、换行或非英文字符。");
  }
  return value;
}

function readToken(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?TOKEN\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const raw = match[1];
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const quoted = raw.match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
      if (!quoted) throw new Error("TOKEN 的引号不完整，请检查文件。");
      return validateToken(quoted[2]);
    }
    return validateToken(raw.split("#", 1)[0].trimEnd());
  }
  throw new Error("文件中找不到 TOKEN，请使用 TOKEN=令牌 的格式。");
}

const byId = (id) => document.getElementById(id);
const state = byId("settings-state");
const form = byId("settings-form");
const fields = byId("settings-fields");
const input = byId("token-input");
const file = byId("token-file");
const message = byId("settings-error");
const clear = byId("settings-clear");
const save = byId("settings-save");
let reading = false;
let fileRevision = 0;

function notify(text, isError = false) {
  message.dataset.error = String(isError);
  message.textContent = text;
}

function showMode(configured) {
  state.textContent = configured ? "个人令牌" : "公开模式";
  state.dataset.personal = String(configured);
  clear.hidden = !configured;
}

function discardRead() {
  fileRevision++;
  reading = false;
  save.disabled = false;
  file.value = "";
}

input.addEventListener("input", () => {
  discardRead();
  notify("");
});

file.addEventListener("change", async () => {
  const selected = file.files[0];
  if (!selected) return;
  const revision = ++fileRevision;
  input.value = "";
  notify("");
  reading = true;
  save.disabled = true;
  try {
    if (selected.size > MAX_FILE_BYTES) {
      notify("文件超过 128 KB，请选择较小的配置文件。", true);
      return;
    }
    const text = await selected.text();
    if (fileRevision !== revision) return;
    try {
      input.value = readToken(text);
      notify("已读取 TOKEN，点击保存令牌即可启用。");
    } catch (error) {
      notify(error.message, true);
    }
  } catch {
    if (fileRevision === revision) notify("读取文件失败，请重新选择。", true);
  } finally {
    if (fileRevision === revision) discardRead();
  }
});

async function persist(value) {
  if (fields.disabled || reading) return;
  fields.disabled = true;
  notify("");
  try {
    await setToken(value);
    form.reset();
    showMode(Boolean(value));
    notify(value ? "令牌已保存，可以打开主题速览了。" : "本次会话的令牌已清除。");
  } catch {
    notify("保存失败，请重试。", true);
  } finally {
    fields.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (fields.disabled || reading) return;
  try {
    void persist(validateToken(input.value));
  } catch (error) {
    notify(error.message, true);
    input.focus();
  }
});

clear.addEventListener("click", () => {
  discardRead();
  void persist("");
});

window.addEventListener("pagehide", () => {
  discardRead();
  form.reset();
});

async function initialize() {
  try {
    const credentials = await getCredentials();
    showMode(Boolean(credentials.token));
  } catch {
    state.textContent = "状态未知";
    notify("无法读取会话设置，请重新打开此页。", true);
  } finally {
    fields.disabled = false;
  }
}

void initialize();
