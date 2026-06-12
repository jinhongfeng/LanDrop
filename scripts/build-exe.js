const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const zlib = require("zlib");
const crypto = require("crypto");

const root = path.join(__dirname, "..");
const buildDir = path.join(root, "build", "exe");
const payloadDir = path.join(buildDir, "payload");
const distDir = path.join(root, "dist");
const exePath = path.join(distDir, "LanDrop.exe");
const payloadCompressedPath = path.join(buildDir, "payload.gz");
const launcherPath = path.join(buildDir, "LanDropLauncher.cs");
const nodePath = process.execPath;
const cscPath = findCsc();
let payloadHash = "";

main();

function main() {
  assertFile(nodePath, "node.exe");
  assertFile(cscPath, "csc.exe");

  recreateDir(buildDir);
  recreateDir(payloadDir);
  fs.mkdirSync(distDir, { recursive: true });

  copyFile(nodePath, path.join(payloadDir, "node.exe"));
  copyFile(path.join(root, "server.js"), path.join(payloadDir, "server.js"));
  copyDir(path.join(root, "public"), path.join(payloadDir, "public"));
  writePayload();
  writeLauncher();
  compileLauncher();

  assertFile(exePath, "LanDrop.exe");
  const sizeMb = fs.statSync(exePath).size / 1024 / 1024;
  console.log(`已生成 ${exePath}`);
  console.log(`大小 ${sizeMb.toFixed(1)} MB`);
}

function writePayload() {
  const files = listFiles(payloadDir).map((filePath) => ({
    path: path.relative(payloadDir, filePath).replace(/\\/g, "/"),
    content: fs.readFileSync(filePath)
  }));
  const chunks = [];
  const header = Buffer.alloc(8);
  header.write("LDP1", 0, "ascii");
  header.writeUInt32LE(files.length, 4);
  chunks.push(header);

  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const meta = Buffer.alloc(8);
    meta.writeUInt32LE(name.length, 0);
    meta.writeUInt32LE(file.content.length, 4);
    chunks.push(meta, name, file.content);
  }

  const compressed = zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
  payloadHash = crypto.createHash("sha256").update(compressed).digest("hex");
  fs.writeFileSync(payloadCompressedPath, compressed);
}

function writeLauncher() {
  const content = `using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Reflection;

public static class LanDropLauncher
{
    private const string PayloadHash = "${payloadHash}";
    private static readonly string BaseRoot = Environment.GetEnvironmentVariable("LANDROP_APP_ROOT") ?? Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "LanDrop");
    private static readonly string AppRoot = Path.Combine(BaseRoot, "app");

    public static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.Title = "LanDrop 局域快传";

        try
        {
            ExtractPayload();
            if (args.Length > 0 && args[0] == "--self-test")
            {
                string nodeExeTest = Path.Combine(AppRoot, "node.exe");
                string serverJsTest = Path.Combine(AppRoot, "server.js");
                string publicIndexTest = Path.Combine(AppRoot, "public", "index.html");
                if (!File.Exists(nodeExeTest) || !File.Exists(serverJsTest) || !File.Exists(publicIndexTest))
                {
                    throw new InvalidOperationException("EXE 解压自检失败");
                }
                Console.WriteLine("LanDrop EXE self-test passed");
                return 0;
            }

            Console.WriteLine("LanDrop 局域快传");
            Console.WriteLine();
            Console.WriteLine("程序目录: " + AppRoot);
            Console.WriteLine("文件保存目录: " + Path.Combine(BaseRoot, "storage"));
            Console.WriteLine("如果 Windows 防火墙弹出提示，请允许此程序在专用网络通信。");
            Console.WriteLine();

            string nodeExe = Path.Combine(AppRoot, "node.exe");
            string serverJs = Path.Combine(AppRoot, "server.js");
            string storageDir = Path.Combine(BaseRoot, "storage");
            Directory.CreateDirectory(storageDir);

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = nodeExe;
            startInfo.Arguments = Quote(serverJs);
            startInfo.WorkingDirectory = AppRoot;
            startInfo.UseShellExecute = false;
            startInfo.EnvironmentVariables["LANDROP_STORAGE_DIR"] = storageDir;

            using (Process process = Process.Start(startInfo))
            {
                process.WaitForExit();
                Console.WriteLine();
                Console.WriteLine("LanDrop 已停止，按任意键关闭窗口。");
                Console.ReadKey(true);
                return process.ExitCode;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("LanDrop 启动失败");
            Console.WriteLine(ex.Message);
            Console.WriteLine("按任意键关闭窗口。");
            Console.ReadKey(true);
            return 1;
        }
    }

    private static void ExtractPayload()
    {
        Directory.CreateDirectory(AppRoot);
        string marker = Path.Combine(AppRoot, ".payload-ready");
        if (File.Exists(marker) && File.ReadAllText(marker).Trim() == PayloadHash) return;

        foreach (string entry in Directory.GetFileSystemEntries(AppRoot))
        {
            try
            {
                if (Directory.Exists(entry)) Directory.Delete(entry, true);
                else File.Delete(entry);
            }
            catch
            {
            }
        }

        Assembly assembly = Assembly.GetExecutingAssembly();
        using (Stream compressed = assembly.GetManifestResourceStream("payload.gz"))
        {
            if (compressed == null) throw new InvalidOperationException("找不到内置资源 payload.gz");
            using (GZipStream gzip = new GZipStream(compressed, CompressionMode.Decompress))
            using (BinaryReader reader = new BinaryReader(gzip, Encoding.UTF8))
            {
                byte[] magic = reader.ReadBytes(4);
                if (magic.Length != 4 || magic[0] != 'L' || magic[1] != 'D' || magic[2] != 'P' || magic[3] != '1')
                {
                    throw new InvalidOperationException("内置资源格式不正确");
                }

                int count = reader.ReadInt32();
                for (int i = 0; i < count; i++)
                {
                    int nameLength = reader.ReadInt32();
                    int contentLength = reader.ReadInt32();
                    string relative = Encoding.UTF8.GetString(reader.ReadBytes(nameLength)).Replace('/', Path.DirectorySeparatorChar);
                    string target = Path.GetFullPath(Path.Combine(AppRoot, relative));
                    if (!target.StartsWith(AppRoot, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidOperationException("非法资源路径: " + relative);
                    }

                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    File.WriteAllBytes(target, reader.ReadBytes(contentLength));
                }
            }
        }

        File.WriteAllText(marker, PayloadHash, Encoding.UTF8);
    }

    private static string Quote(string value)
    {
        return "\\\"" + value.Replace("\\\"", "\\\\\\\"") + "\\\"";
    }
}
`;
  fs.writeFileSync(launcherPath, content, "utf8");
}

function compileLauncher() {
  const args = [
    "/nologo",
    "/target:exe",
    `/out:${exePath}`,
    "/reference:System.IO.Compression.dll",
    "/reference:System.IO.Compression.FileSystem.dll",
    `/resource:${payloadCompressedPath},payload.gz`,
    launcherPath
  ];
  const result = spawnSync(cscPath, args, {
    cwd: buildDir,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`C# 编译失败，退出码 ${result.status}`);
  }
}

function findCsc() {
  const candidates = [
    path.join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function listFiles(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(fullPath));
    else result.push(fullPath);
  }
  return result;
}

function recreateDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else copyFile(sourcePath, targetPath);
  }
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`找不到 ${label}: ${filePath}`);
  }
}
