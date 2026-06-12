const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3789);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 1024 * 1024 * 1024);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const STORAGE_DIR = process.env.LANDROP_STORAGE_DIR || path.join(ROOT, "storage");

fs.mkdirSync(STORAGE_DIR, { recursive: true });

const rooms = new Map();

function createRoom() {
  let code;
  do {
    code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  } while (rooms.has(code));

  const room = {
    code,
    createdAt: Date.now(),
    messages: [],
    files: [],
    clients: new Map()
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  if (!/^\d{6}$/.test(String(code || ""))) return null;
  return rooms.get(String(code)) || null;
}

function publicHost(req) {
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = req.socket.encrypted ? "https" : "http";
  return `${proto}://${host}`;
}

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      addresses.push(entry.address);
    }
  }

  return addresses;
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function parseBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(Object.assign(error, { status: 400 }));
      }
    });

    req.on("error", reject);
  });
}

function sanitizeFileName(name) {
  const cleaned = String(name || "file")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return cleaned || "file";
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon"
  }[ext] || "application/octet-stream";
}

function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, normalized);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    text(res, 403, "Forbidden");
    return;
  }

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      text(res, 404, "Not found");
      return;
    }

    res.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      "content-length": stat.size,
      "cache-control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=3600"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function clientList(room) {
  return Array.from(room.clients.values()).map((client) => ({
    id: client.id,
    name: client.name,
    device: client.device,
    joinedAt: client.joinedAt
  }));
}

function roomPayload(room) {
  return {
    type: "room-state",
    room: {
      code: room.code,
      createdAt: room.createdAt,
      peers: clientList(room),
      messages: room.messages.slice(-40),
      files: room.files.slice(-60).map(publicFile)
    }
  };
}

function broadcast(room, payload, exceptId = null) {
  const raw = JSON.stringify(payload);
  for (const client of room.clients.values()) {
    if (client.id === exceptId) continue;
    sendFrame(client.socket, raw);
  }
}

function broadcastRoom(room) {
  broadcast(room, roomPayload(room));
}

async function handleCreateRoom(req, res) {
  const room = createRoom();
  json(res, 201, {
    code: room.code,
    joinUrl: `${publicHost(req)}/?room=${room.code}`
  });
}

async function handleRoomInfo(req, res, url) {
  const code = url.pathname.split("/").pop();
  const room = getRoom(code);
  if (!room) {
    json(res, 404, { error: "room_not_found", message: "没有找到这个配对码" });
    return;
  }
  json(res, 200, roomPayload(room).room);
}

async function handleMeta(req, res) {
  json(res, 200, {
    name: os.hostname(),
    port: PORT,
    localUrl: `http://localhost:${PORT}`,
    lanUrls: getLanAddresses().map((address) => `http://${address}:${PORT}`),
    maxUploadBytes: MAX_UPLOAD_BYTES
  });
}

async function handleText(req, res) {
  const body = await parseBody(req, 1024 * 1024);
  const room = getRoom(body.room);
  if (!room) {
    json(res, 404, { error: "room_not_found", message: "配对房间不存在" });
    return;
  }

  const value = String(body.text || "").trim();
  if (!value) {
    json(res, 400, { error: "empty_text", message: "请输入要发送的文字" });
    return;
  }

  const item = {
    id: crypto.randomUUID(),
    type: "text",
    text: value.slice(0, 20000),
    sender: String(body.sender || "匿名设备").slice(0, 80),
    senderId: String(body.senderId || ""),
    createdAt: Date.now()
  };
  room.messages.push(item);
  room.messages = room.messages.slice(-80);

  broadcast(room, { type: "text", item });
  json(res, 201, item);
}

async function handleUpload(req, res, url) {
  const room = getRoom(url.searchParams.get("room"));
  if (!room) {
    json(res, 404, { error: "room_not_found", message: "配对房间不存在" });
    return;
  }

  const originalName = sanitizeFileName(url.searchParams.get("name"));
  const sender = String(url.searchParams.get("sender") || "匿名设备").slice(0, 80);
  const senderId = String(url.searchParams.get("senderId") || "");
  const sizeHeader = Number(req.headers["content-length"] || 0);

  if (sizeHeader > MAX_UPLOAD_BYTES) {
    json(res, 413, { error: "file_too_large", message: "文件超过大小限制" });
    return;
  }

  const id = crypto.randomUUID();
  const storedName = `${Date.now()}-${id}-${originalName}`;
  const storedPath = path.join(STORAGE_DIR, storedName);
  let received = 0;

  try {
    await new Promise((resolve, reject) => {
      const write = fs.createWriteStream(storedPath, { flags: "wx" });

      req.on("data", (chunk) => {
        received += chunk.length;
        if (received > MAX_UPLOAD_BYTES) {
          write.destroy();
          reject(Object.assign(new Error("File too large"), { status: 413 }));
          req.destroy();
        }
      });

      req.on("error", reject);
      write.on("error", reject);
      write.on("finish", resolve);
      req.pipe(write);
    });
  } catch (error) {
    fs.rm(storedPath, { force: true }, () => {});
    json(res, error.status || 500, {
      error: error.status === 413 ? "file_too_large" : "upload_failed",
      message: error.status === 413 ? "文件超过大小限制" : "上传失败"
    });
    return;
  }

  const file = {
    id,
    type: "file",
    name: originalName,
    storedName,
    size: received,
    mime: req.headers["content-type"] || "application/octet-stream",
    sender,
    senderId,
    createdAt: Date.now(),
    url: `/api/files/${id}`
  };
  room.files.push(file);
  room.files = room.files.slice(-120);

  broadcast(room, { type: "file", item: publicFile(file) });
  json(res, 201, publicFile(file));
}

function publicFile(file) {
  return {
    id: file.id,
    type: "file",
    name: file.name,
    size: file.size,
    mime: file.mime,
    sender: file.sender,
    senderId: file.senderId,
    createdAt: file.createdAt,
    url: file.url
  };
}

async function handleDownload(req, res, url) {
  const id = url.pathname.split("/").pop();
  let file = null;

  for (const room of rooms.values()) {
    file = room.files.find((item) => item.id === id);
    if (file) break;
  }

  if (!file) {
    text(res, 404, "File not found");
    return;
  }

  const filePath = path.join(STORAGE_DIR, file.storedName);
  if (!filePath.startsWith(STORAGE_DIR)) {
    text(res, 403, "Forbidden");
    return;
  }

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      text(res, 404, "File not found");
      return;
    }

    const encoded = encodeURIComponent(file.name).replace(/['()]/g, escape).replace(/\*/g, "%2A");
    res.writeHead(200, {
      "content-type": file.mime || "application/octet-stream",
      "content-length": stat.size,
      "content-disposition": `attachment; filename*=UTF-8''${encoded}`,
      "cache-control": "no-store"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, publicHost(req));

  try {
    if (req.method === "GET" && url.pathname === "/api/meta") return await handleMeta(req, res);
    if (req.method === "POST" && url.pathname === "/api/rooms") return await handleCreateRoom(req, res);
    if (req.method === "GET" && /^\/api\/rooms\/\d{6}$/.test(url.pathname)) return await handleRoomInfo(req, res, url);
    if (req.method === "POST" && url.pathname === "/api/text") return await handleText(req, res);
    if (req.method === "POST" && url.pathname === "/api/upload") return await handleUpload(req, res, url);
    if (req.method === "GET" && /^\/api\/files\/[-0-9a-f]+$/.test(url.pathname)) return await handleDownload(req, res, url);

    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res, url);
      return;
    }

    text(res, 405, "Method not allowed");
  } catch (error) {
    json(res, error.status || 500, {
      error: "server_error",
      message: error.status === 400 ? "请求格式不正确" : "服务器处理失败"
    });
  }
}

function acceptKey(key) {
  return crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function sendFrame(socket, data) {
  if (socket.destroyed) return;
  const payload = Buffer.from(data);
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x81;
  socket.write(Buffer.concat([header, payload]));
}

function closeFrame(socket) {
  if (!socket.destroyed) socket.end(Buffer.from([0x88, 0x00]));
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Frame too large");
      length = Number(bigLength);
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameEnd = offset + headerLength + maskLength + length;
    if (frameEnd > buffer.length) break;

    let payload = buffer.subarray(offset + headerLength + maskLength, frameEnd);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }

    frames.push({ opcode, payload });
    offset = frameEnd;
  }

  return { frames, rest: buffer.subarray(offset) };
}

function handleWsMessage(client, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.type === "hello") {
    const room = getRoom(message.room);
    if (!room) {
      sendFrame(client.socket, JSON.stringify({ type: "error", message: "配对房间不存在" }));
      closeFrame(client.socket);
      return;
    }

    client.room = room;
    client.name = String(message.name || "匿名设备").slice(0, 80);
    client.device = String(message.device || "device").slice(0, 40);
    room.clients.set(client.id, client);
    sendFrame(client.socket, JSON.stringify({
      type: "hello",
      clientId: client.id,
      room: roomPayload(room).room
    }));
    broadcastRoom(room);
    return;
  }

  if (!client.room) return;

  if (message.type === "rename") {
    client.name = String(message.name || client.name).slice(0, 80);
    broadcastRoom(client.room);
  }
}

function handleUpgrade(req, socket) {
  if (req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    "",
    ""
  ].join("\r\n"));

  const client = {
    id: crypto.randomUUID(),
    name: "匿名设备",
    device: "device",
    joinedAt: Date.now(),
    socket,
    room: null
  };
  let frameBuffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);
    let decoded;
    try {
      decoded = decodeFrames(frameBuffer);
    } catch {
      socket.destroy();
      return;
    }

    frameBuffer = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(Buffer.from([0x8a, 0x00]));
        continue;
      }
      if (frame.opcode === 0x1) {
        handleWsMessage(client, frame.payload.toString("utf8"));
      }
    }
  });

  socket.on("close", () => {
    if (client.room) {
      client.room.clients.delete(client.id);
      broadcastRoom(client.room);
    }
  });

  socket.on("error", () => {});
}

const server = http.createServer(handleRequest);
server.on("upgrade", handleUpgrade);

server.listen(PORT, HOST, () => {
  const localUrl = `http://localhost:${PORT}`;
  const lanUrls = getLanAddresses().map((address) => `http://${address}:${PORT}`);

  console.log("LanDrop 局域快传已启动");
  console.log(`本机访问: ${localUrl}`);
  if (lanUrls.length) {
    console.log("局域网访问:");
    for (const url of lanUrls) console.log(`  ${url}`);
  } else {
    console.log("未检测到局域网 IPv4 地址，请确认网络连接。");
  }
  console.log("按 Ctrl+C 停止服务");
});
