const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const net = require("net");
const crypto = require("crypto");

const root = path.join(__dirname, "..");
const port = 4791;
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

main()
  .then(() => {
    child.kill();
    console.log("Smoke test passed");
  })
  .catch((error) => {
    child.kill();
    console.error(output);
    console.error(error);
    process.exit(1);
  });

async function main() {
  await waitForServer();

  const meta = await requestJson("/api/meta");
  assert.equal(meta.port, port);

  const html = await fetch(`${base}/`).then((res) => res.text());
  assert.match(html, /局域快传/);

  const room = await requestJson("/api/rooms", { method: "POST" });
  assert.match(room.code, /^\d{6}$/);

  const info = await requestJson(`/api/rooms/${room.code}`);
  assert.equal(info.code, room.code);

  await websocketProbe(room.code);

  const text = await requestJson("/api/text", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      room: room.code,
      text: "hello from smoke test",
      sender: "test-computer",
      senderId: "test-id"
    })
  });
  assert.equal(text.text, "hello from smoke test");

  const file = await fetch(`${base}/api/upload?${new URLSearchParams({
    room: room.code,
    name: "smoke.txt",
    sender: "test-computer",
    senderId: "test-id"
  })}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "smoke file"
  }).then(async (res) => {
    assert.equal(res.status, 201);
    return res.json();
  });

  assert.equal(file.name, "smoke.txt");
  const downloaded = await fetch(`${base}${file.url}`).then((res) => res.text());
  assert.equal(downloaded, "smoke file");

  const storageFiles = fs
    .readdirSync(path.join(root, "storage"))
    .filter((name) => name.includes(file.id));
  for (const fileName of storageFiles) {
    fs.rmSync(path.join(root, "storage", fileName), { force: true });
  }
}

async function waitForServer() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      const res = await fetch(`${base}/api/meta`);
      if (res.ok) return;
    } catch {
      await delay(120);
    }
  }
  throw new Error("Server did not start");
}

async function requestJson(pathname, options) {
  const response = await fetch(`${base}${pathname}`, options);
  const data = await response.json();
  assert.ok(response.ok, `${pathname} returned ${response.status}`);
  return data;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function websocketProbe(code) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const key = crypto.randomBytes(16).toString("base64");
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let done = false;

    const timer = setTimeout(() => fail(new Error("WebSocket probe timed out")), 2500);

    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.end();
      resolve();
    }

    function fail(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    }

    socket.on("connect", () => {
      socket.write([
        "GET /ws HTTP/1.1",
        "Host: 127.0.0.1",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        ""
      ].join("\r\n"));
    });

    socket.on("data", (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);

        if (!upgraded) {
          const split = buffer.indexOf("\r\n\r\n");
          if (split === -1) return;
          const header = buffer.subarray(0, split).toString("utf8");
          assert.match(header, /101 Switching Protocols/);
          upgraded = true;
          buffer = buffer.subarray(split + 4);
          socket.write(maskedTextFrame(JSON.stringify({
            type: "hello",
            room: code,
            name: "ws-test",
            device: "电脑"
          })));
        }

        const decoded = decodeServerFrames(buffer);
        buffer = decoded.rest;
        for (const frame of decoded.frames) {
          if (frame.opcode !== 1) continue;
          const message = JSON.parse(frame.payload.toString("utf8"));
          if (message.type === "hello") {
            assert.equal(message.room.code, code);
            assert.ok(message.clientId);
            finish();
          }
        }
      } catch (error) {
        fail(error);
      }
    });

    socket.on("error", fail);
  });
}

function maskedTextFrame(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  let header;

  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = payload[i] ^ mask[i % 4];
  }

  return Buffer.concat([header, mask, masked]);
}

function decodeServerFrames(buffer) {
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
      length = Number(buffer.readBigUInt64BE(offset + 2));
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
