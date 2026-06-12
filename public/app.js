const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  meta: null,
  roomCode: "",
  selectedOrigin: location.origin,
  ws: null,
  reconnectTimer: null,
  clientId: "",
  deviceToken: getOrCreate("landrop.deviceToken", createId),
  items: new Map(),
  peers: [],
  uploads: new Map()
};

const els = {
  serverName: $("#serverName"),
  connectionStatus: $("#connectionStatus"),
  deviceName: $("#deviceName"),
  newRoomButton: $("#newRoomButton"),
  roomCode: $("#roomCode"),
  qrCanvas: $("#qrCanvas"),
  qrFallback: $("#qrFallback"),
  addressSelect: $("#addressSelect"),
  joinUrl: $("#joinUrl"),
  copyUrlButton: $("#copyUrlButton"),
  joinForm: $("#joinForm"),
  joinCodeInput: $("#joinCodeInput"),
  peerCount: $("#peerCount"),
  peerList: $("#peerList"),
  textInput: $("#textInput"),
  sendTextButton: $("#sendTextButton"),
  pasteSendButton: $("#pasteSendButton"),
  dropZone: $("#dropZone"),
  fileInput: $("#fileInput"),
  uploadList: $("#uploadList"),
  activityMeta: $("#activityMeta"),
  activityList: $("#activityList"),
  clearLocalButton: $("#clearLocalButton"),
  toast: $("#toast")
};

init();

async function init() {
  bindEvents();
  hydrateDeviceName();

  try {
    state.meta = await fetchJson("/api/meta");
    renderMeta();
  } catch {
    setStatus("error", "服务不可用");
    showToast("无法读取本机服务信息");
  }

  const urlRoom = new URLSearchParams(location.search).get("room");
  if (/^\d{6}$/.test(urlRoom || "")) {
    await joinRoom(urlRoom);
  } else {
    await createRoom();
  }
}

function bindEvents() {
  els.deviceName.addEventListener("change", () => {
    localStorage.setItem("landrop.deviceName", normalizedDeviceName());
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "rename", name: normalizedDeviceName() }));
    }
  });

  els.newRoomButton.addEventListener("click", createRoom);
  els.addressSelect.addEventListener("change", () => {
    state.selectedOrigin = els.addressSelect.value;
    updateJoinUrl();
  });

  els.copyUrlButton.addEventListener("click", () => copyToClipboard(els.joinUrl.value, "已复制加入链接"));

  els.joinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await joinRoom(els.joinCodeInput.value.replace(/\D/g, ""));
  });

  els.joinCodeInput.addEventListener("input", () => {
    els.joinCodeInput.value = els.joinCodeInput.value.replace(/\D/g, "").slice(0, 6);
  });

  els.sendTextButton.addEventListener("click", sendText);
  els.pasteSendButton.addEventListener("click", pasteAndSend);
  els.fileInput.addEventListener("change", () => queueFiles(els.fileInput.files));

  ["dragenter", "dragover"].forEach((type) => {
    els.dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropZone.classList.add("is-dragging");
    });
  });

  ["dragleave", "drop"].forEach((type) => {
    els.dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropZone.classList.remove("is-dragging");
    });
  });

  els.dropZone.addEventListener("drop", (event) => {
    queueFiles(event.dataTransfer.files);
  });

  els.clearLocalButton.addEventListener("click", () => {
    state.items.clear();
    renderActivity();
  });

  window.addEventListener("online", () => {
    if (state.roomCode) connectSocket(state.roomCode);
  });
  window.addEventListener("offline", () => setStatus("offline", "离线"));
}

function hydrateDeviceName() {
  const saved = localStorage.getItem("landrop.deviceName");
  els.deviceName.value = saved || defaultDeviceName();
  localStorage.setItem("landrop.deviceName", normalizedDeviceName());
}

function defaultDeviceName() {
  const ua = navigator.userAgent;
  const type = /Mobi|Android|iPhone|iPad/i.test(ua) ? "手机" : "电脑";
  return `我的${type}`;
}

function normalizedDeviceName() {
  return (els.deviceName.value || "匿名设备").trim().slice(0, 40) || "匿名设备";
}

function getDeviceKind() {
  const ua = navigator.userAgent;
  if (/iPad|Tablet/i.test(ua)) return "平板";
  if (/Mobi|Android|iPhone/i.test(ua)) return "手机";
  return "电脑";
}

function getOrCreate(key, createValue) {
  let value = localStorage.getItem(key);
  if (!value) {
    value = createValue();
    localStorage.setItem(key, value);
  }
  return value;
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const random = globalThis.crypto?.getRandomValues
    ? Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16).padStart(8, "0")).join("")
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return `local-${random}`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || "请求失败");
    error.status = response.status;
    throw error;
  }
  return data;
}

function renderMeta() {
  const host = state.meta?.name || "本机";
  const maxSize = humanSize(state.meta?.maxUploadBytes || 0);
  els.serverName.textContent = `${host} · 单文件上限 ${maxSize}`;

  const choices = [];
  const current = location.origin;
  if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(current)) choices.push(current);
  for (const url of state.meta?.lanUrls || []) choices.push(url);
  choices.push(state.meta?.localUrl || current);

  const unique = Array.from(new Set(choices.filter(Boolean)));
  state.selectedOrigin = unique[0] || current;
  els.addressSelect.replaceChildren(...unique.map((url) => {
    const option = document.createElement("option");
    option.value = url;
    option.textContent = url;
    return option;
  }));
}

async function createRoom() {
  setStatus("loading", "创建中");
  try {
    const room = await fetchJson("/api/rooms", { method: "POST" });
    state.items.clear();
    state.roomCode = room.code;
    history.replaceState(null, "", `/?room=${room.code}`);
    updateRoomDisplay();
    connectSocket(room.code);
    showToast("新房间已创建");
  } catch (error) {
    setStatus("error", "创建失败");
    showToast(error.message || "创建房间失败");
  }
}

async function joinRoom(code) {
  if (!/^\d{6}$/.test(code || "")) {
    showToast("请输入 6 位配对码");
    return;
  }

  setStatus("loading", "加入中");
  try {
    const room = await fetchJson(`/api/rooms/${code}`);
    state.items.clear();
    state.roomCode = code;
    history.replaceState(null, "", `/?room=${code}`);
    applyRoom(room);
    updateRoomDisplay();
    connectSocket(code);
    els.joinCodeInput.value = "";
  } catch (error) {
    setStatus("error", "加入失败");
    showToast(error.message || "没有找到这个房间");
  }
}

function updateRoomDisplay() {
  els.roomCode.textContent = state.roomCode || "------";
  updateJoinUrl();
}

function updateJoinUrl() {
  if (!state.roomCode) return;
  const url = new URL("/", state.selectedOrigin || location.origin);
  url.searchParams.set("room", state.roomCode);
  els.joinUrl.value = url.toString();
  drawJoinQr(url.toString());
}

function connectSocket(code) {
  clearTimeout(state.reconnectTimer);
  if (state.ws) state.ws.close();

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${location.host}/ws`);
  state.ws = ws;

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({
      type: "hello",
      room: code,
      name: normalizedDeviceName(),
      device: getDeviceKind()
    }));
  });

  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "hello") {
      state.clientId = data.clientId;
      applyRoom(data.room);
      setStatus("online", "已连接");
      return;
    }
    if (data.type === "room-state") {
      applyRoom(data.room);
      return;
    }
    if (data.type === "text" || data.type === "file") {
      upsertItem(data.item);
      renderActivity();
      if (data.item.senderId !== state.deviceToken) {
        showToast(data.type === "text" ? "收到文字" : `收到文件：${data.item.name}`);
      }
      return;
    }
    if (data.type === "error") {
      setStatus("error", "连接失败");
      showToast(data.message || "连接失败");
    }
  });

  ws.addEventListener("close", () => {
    if (state.ws !== ws) return;
    setStatus("offline", "已断开");
    state.reconnectTimer = setTimeout(() => connectSocket(code), 1600);
  });

  ws.addEventListener("error", () => {
    setStatus("error", "连接异常");
  });
}

function applyRoom(room) {
  if (!room) return;
  state.roomCode = room.code || state.roomCode;
  state.peers = room.peers || [];

  for (const item of room.messages || []) upsertItem(item);
  for (const item of room.files || []) upsertItem(item);

  updateRoomDisplay();
  renderPeers();
  renderActivity();
}

function upsertItem(item) {
  if (!item?.id) return;
  state.items.set(item.id, item);
}

function setStatus(stateName, label) {
  els.connectionStatus.dataset.state = stateName;
  els.connectionStatus.textContent = label;
}

function renderPeers() {
  els.peerCount.textContent = `${state.peers.length} 台`;
  if (!state.peers.length) {
    els.peerList.innerHTML = `<li class="peer-item"><span class="peer-name">等待设备加入</span><span class="peer-badge">空</span></li>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const peer of state.peers) {
    const li = document.createElement("li");
    li.className = "peer-item";

    const name = document.createElement("span");
    name.className = "peer-name";
    name.textContent = peer.name || "匿名设备";

    const badge = document.createElement("span");
    badge.className = "peer-badge";
    badge.textContent = peer.id === state.clientId ? "本机" : (peer.device || "设备");

    li.append(name, badge);
    fragment.append(li);
  }
  els.peerList.replaceChildren(fragment);
}

async function sendText() {
  const text = els.textInput.value.trim();
  if (!text) {
    showToast("请输入要发送的文字");
    return;
  }
  if (!state.roomCode) {
    showToast("请先创建或加入房间");
    return;
  }

  els.sendTextButton.disabled = true;
  try {
    await fetchJson("/api/text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        room: state.roomCode,
        text,
        sender: normalizedDeviceName(),
        senderId: state.deviceToken
      })
    });
    els.textInput.value = "";
  } catch (error) {
    showToast(error.message || "发送失败");
  } finally {
    els.sendTextButton.disabled = false;
  }
}

async function pasteAndSend() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      showToast("剪贴板没有文字");
      return;
    }
    els.textInput.value = text;
    await sendText();
  } catch {
    showToast("浏览器拒绝读取剪贴板，请手动粘贴");
  }
}

function queueFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!state.roomCode) {
    showToast("请先创建或加入房间");
    return;
  }
  for (const file of files) uploadFile(file);
  els.fileInput.value = "";
}

function uploadFile(file) {
  const uploadId = createId();
  state.uploads.set(uploadId, {
    id: uploadId,
    name: file.name,
    size: file.size,
    progress: 0,
    status: "等待"
  });
  renderUploads();

  const params = new URLSearchParams({
    room: state.roomCode,
    name: file.name,
    sender: normalizedDeviceName(),
    senderId: state.deviceToken
  });
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/upload?${params.toString()}`);
  xhr.setRequestHeader("content-type", file.type || "application/octet-stream");

  xhr.upload.addEventListener("progress", (event) => {
    const item = state.uploads.get(uploadId);
    if (!item) return;
    item.progress = event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : 20;
    item.status = "上传中";
    renderUploads();
  });

  xhr.addEventListener("load", () => {
    const item = state.uploads.get(uploadId);
    if (!item) return;
    if (xhr.status >= 200 && xhr.status < 300) {
      item.progress = 100;
      item.status = "完成";
      renderUploads();
      setTimeout(() => {
        state.uploads.delete(uploadId);
        renderUploads();
      }, 1200);
    } else {
      item.status = parseUploadError(xhr.responseText);
      renderUploads();
    }
  });

  xhr.addEventListener("error", () => {
    const item = state.uploads.get(uploadId);
    if (!item) return;
    item.status = "上传失败";
    renderUploads();
  });

  xhr.send(file);
}

function parseUploadError(raw) {
  try {
    return JSON.parse(raw).message || "上传失败";
  } catch {
    return "上传失败";
  }
}

function renderUploads() {
  if (!state.uploads.size) {
    els.uploadList.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const upload of state.uploads.values()) {
    const item = document.createElement("div");
    item.className = "upload-item";

    const top = document.createElement("div");
    top.className = "upload-top";

    const name = document.createElement("span");
    name.className = "upload-name";
    name.textContent = upload.name;

    const meta = document.createElement("span");
    meta.textContent = `${upload.status} · ${upload.progress}%`;

    const track = document.createElement("div");
    track.className = "progress-track";

    const bar = document.createElement("div");
    bar.className = "progress-bar";
    bar.style.setProperty("--progress", `${upload.progress}%`);

    top.append(name, meta);
    track.append(bar);
    item.append(top, track);
    fragment.append(item);
  }
  els.uploadList.replaceChildren(fragment);
}

function renderActivity() {
  const items = Array.from(state.items.values()).sort((a, b) => b.createdAt - a.createdAt);
  els.activityMeta.textContent = items.length ? `${items.length} 条记录` : "等待传输";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "文字和文件会出现在这里";
    els.activityList.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    fragment.append(item.type === "file" ? renderFileItem(item) : renderTextItem(item));
  }
  els.activityList.replaceChildren(fragment);
}

function renderTextItem(item) {
  const wrapper = baseActivityItem(item, "文字");
  const text = document.createElement("p");
  text.className = "activity-text";
  text.textContent = item.text || "";

  const actions = document.createElement("div");
  actions.className = "activity-actions";

  const copy = document.createElement("button");
  copy.className = "secondary-button";
  copy.type = "button";
  copy.textContent = "复制文字";
  copy.addEventListener("click", () => copyToClipboard(item.text || "", "已复制文字"));

  actions.append(copy);
  wrapper.append(text, actions);
  return wrapper;
}

function renderFileItem(item) {
  const wrapper = baseActivityItem(item, "文件");
  const info = document.createElement("p");
  info.className = "activity-text";
  info.textContent = `${item.name} · ${humanSize(item.size || 0)}`;

  const actions = document.createElement("div");
  actions.className = "activity-actions";

  const link = document.createElement("a");
  link.className = "download-link";
  link.href = item.url;
  link.download = item.name;
  link.textContent = "下载文件";

  actions.append(link);
  wrapper.append(info, actions);
  return wrapper;
}

function baseActivityItem(item, label) {
  const wrapper = document.createElement("article");
  wrapper.className = `activity-item${item.senderId === state.deviceToken ? " is-mine" : ""}`;

  const top = document.createElement("div");
  top.className = "activity-top";

  const title = document.createElement("div");
  title.className = "activity-title";
  title.textContent = `${item.senderId === state.deviceToken ? "我" : item.sender || "匿名设备"}发送了${label}`;

  const meta = document.createElement("div");
  meta.className = "activity-meta";
  meta.textContent = formatTime(item.createdAt);

  top.append(title, meta);
  wrapper.append(top);
  return wrapper;
}

async function copyToClipboard(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage);
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
    showToast(successMessage);
  }
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2200);
}

function humanSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value || Date.now()));
}

function drawJoinQr(text) {
  try {
    drawQrCode(els.qrCanvas, text);
    els.qrCanvas.hidden = false;
    els.qrFallback.hidden = true;
  } catch {
    els.qrCanvas.hidden = true;
    els.qrFallback.hidden = false;
  }
}

function drawQrCode(canvas, text) {
  const qr = createQr(text);
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  const quiet = 4;
  const scale = Math.floor(size / (qr.size + quiet * 2));
  const offset = Math.floor((size - qr.size * scale) / 2);

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#111";

  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (qr.modules[y][x]) {
        ctx.fillRect(offset + x * scale, offset + y * scale, scale, scale);
      }
    }
  }
}

function createQr(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = bytes.length <= 78 ? 4 : 5;
  const config = version === 4
    ? { version, size: 33, dataCodewords: 80, ecCodewords: 20, align: [6, 26] }
    : { version, size: 37, dataCodewords: 108, ecCodewords: 26, align: [6, 30] };
  if (bytes.length > 106) throw new Error("QR payload too long");

  const data = makeDataCodewords(bytes, config.dataCodewords);
  const ecc = reedSolomonRemainder(data, config.ecCodewords);
  const codewords = data.concat(ecc);
  return buildQrMatrix(config, codewords, 2);
}

function makeDataCodewords(bytes, dataCodewords) {
  const bits = [];
  appendBits(bits, 0x4, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);

  const capacity = dataCodewords * 8;
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);

  const result = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    result.push(value);
  }
  for (let pad = 0xec; result.length < dataCodewords; pad ^= 0xfd) result.push(pad);
  return result;
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

function buildQrMatrix(config, codewords, mask) {
  const modules = Array.from({ length: config.size }, () => Array(config.size).fill(false));
  const reserved = Array.from({ length: config.size }, () => Array(config.size).fill(false));
  const set = (x, y, dark, reserve = true) => {
    modules[y][x] = dark;
    if (reserve) reserved[y][x] = true;
  };

  drawFinder(set, config.size, 3, 3);
  drawFinder(set, config.size, config.size - 4, 3);
  drawFinder(set, config.size, 3, config.size - 4);
  drawTiming(set, reserved, config.size);
  drawAlignment(set, reserved, config.align);
  drawFormatBits(set, config.size, mask);
  set(8, config.version * 4 + 9, true);
  placeData(modules, reserved, config.size, codewords, mask);
  drawFormatBits(set, config.size, mask);

  return { size: config.size, modules };
}

function drawFinder(set, size, cx, cy) {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawTiming(set, reserved, size) {
  for (let i = 0; i < size; i += 1) {
    if (!reserved[6][i]) set(i, 6, i % 2 === 0);
    if (!reserved[i][6]) set(6, i, i % 2 === 0);
  }
}

function drawAlignment(set, reserved, positions) {
  for (const y of positions) {
    for (const x of positions) {
      if (reserved[y][x]) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
}

function drawFormatBits(set, size, mask) {
  const bits = getFormatBits(mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;

  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));

  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

function getFormatBits(mask) {
  const data = (1 << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) ? 0x537 : 0);
  }
  return ((data << 10) | (remainder & 0x3ff)) ^ 0x5412;
}

function placeData(modules, reserved, size, codewords, mask) {
  const bits = [];
  for (const codeword of codewords) appendBits(bits, codeword, 8);

  let index = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vert = 0; vert < size; vert += 1) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        if (reserved[y][x]) continue;
        const raw = index < bits.length ? bits[index] === 1 : false;
        modules[y][x] = raw !== maskBit(mask, x, y);
        index += 1;
      }
    }
    upward = !upward;
  }
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return false;
  }
}

const gfExp = new Array(512);
const gfLog = new Array(256);
let gfValue = 1;
for (let i = 0; i < 255; i += 1) {
  gfExp[i] = gfValue;
  gfLog[gfValue] = i;
  gfValue <<= 1;
  if (gfValue & 0x100) gfValue ^= 0x11d;
}
for (let i = 255; i < 512; i += 1) gfExp[i] = gfExp[i - 255];

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return gfExp[gfLog[a] + gfLog[b]];
}

function reedSolomonGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], gfExp[i]);
    }
    poly = next;
  }
  return poly;
}

function reedSolomonRemainder(data, degree) {
  const generator = reedSolomonGenerator(degree);
  const result = Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < degree; i += 1) {
      result[i] ^= gfMul(generator[i + 1], factor);
    }
  }
  return result;
}
