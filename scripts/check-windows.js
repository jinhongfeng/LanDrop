const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const storageDir = path.join(root, "storage");
const defaultPort = Number(process.env.PORT || 3789);
const results = [];

main().catch((error) => {
  fail("兼容性检查脚本异常", error.message);
  printResults();
  process.exit(1);
});

async function main() {
  checkWindows();
  checkNode();
  checkFiles();
  checkStorageWrite();
  checkLanAddress();
  await checkPort(defaultPort);
  note("浏览器要求", "Win10/Win11 请使用新版 Edge、Chrome 或 Firefox；IE 和旧版 Edge 不支持。");
  note("启动方式", "推荐双击 start-landrop.cmd，或在终端运行 npm.cmd start。");
  printResults();

  const failed = results.some((item) => item.level === "fail");
  process.exit(failed ? 1 : 0);
}

function checkWindows() {
  if (process.platform === "win32") {
    pass("Windows 系统", `${os.type()} ${os.release()} ${os.arch()}`);
  } else {
    warn("Windows 系统", `当前是 ${process.platform}，项目可运行，但此检查主要面向 Win10/Win11。`);
  }
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 18) {
    pass("Node.js 版本", process.version);
  } else {
    fail("Node.js 版本", `当前 ${process.version}，需要 Node.js 18 或更高版本。`);
  }
}

function checkFiles() {
  for (const file of ["server.js", "public/index.html", "public/app.js", "public/styles.css"]) {
    const fullPath = path.join(root, file);
    if (fs.existsSync(fullPath)) {
      pass("项目文件", file);
    } else {
      fail("项目文件", `缺少 ${file}`);
    }
  }
}

function checkStorageWrite() {
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    const probe = path.join(storageDir, ".windows-check.tmp");
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    pass("文件保存目录", "storage 可写");
  } catch (error) {
    fail("文件保存目录", `storage 不可写：${error.message}`);
  }
}

function checkLanAddress() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }

  if (addresses.length) {
    pass("局域网地址", addresses.join(", "));
  } else {
    warn("局域网地址", "未检测到局域网 IPv4。只能本机访问，或需要连接 Wi-Fi/网线后再启动。");
  }
}

function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        warn("默认端口", `${port} 已被占用。可先关闭占用程序，或用 set PORT=其他端口 后启动。`);
      } else {
        warn("默认端口", `无法检查 ${port}：${error.message}`);
      }
      resolve();
    });
    server.once("listening", () => {
      server.close(() => {
        pass("默认端口", `${port} 可用`);
        resolve();
      });
    });
    server.listen(port, "0.0.0.0");
  });
}

function pass(title, detail) {
  results.push({ level: "pass", title, detail });
}

function warn(title, detail) {
  results.push({ level: "warn", title, detail });
}

function fail(title, detail) {
  results.push({ level: "fail", title, detail });
}

function note(title, detail) {
  results.push({ level: "note", title, detail });
}

function printResults() {
  const icons = { pass: "[OK]", warn: "[WARN]", fail: "[FAIL]", note: "[INFO]" };
  console.log("LanDrop Windows 使用条件检查");
  for (const item of results) {
    console.log(`${icons[item.level]} ${item.title}: ${item.detail}`);
  }
}
