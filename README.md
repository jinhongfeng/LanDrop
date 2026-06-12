# LanDrop 局域快传

不用登录、不用网盘。启动后，同一 Wi-Fi 下的手机、电脑、平板都可以打开局域网地址，扫码或输入 6 位配对码加入同一个房间，互传文件、文字和剪贴板内容。

## 启动

Windows 可以直接双击 `start-landrop.cmd`。

或者在终端运行：

```bash
npm start
```

如果 PowerShell 提示 `npm.ps1` 被禁止运行，可以改用：

```bash
npm.cmd start
```

启动后终端会显示本机访问地址和局域网访问地址。其他设备打开局域网地址即可连接。

## EXE 打包

生成 Windows 可执行文件：

```bash
npm.cmd run build:exe
```

产物在 `dist/LanDrop.exe`。这个 EXE 内置 Node.js 和项目文件，目标电脑不需要另装 Node.js。双击后会解压运行文件到 `%LOCALAPPDATA%\LanDrop\app`，收到的文件保存在 `%LOCALAPPDATA%\LanDrop\storage`。

需要便携目录时，可以先设置 `LANDROP_APP_ROOT`，EXE 会把运行文件和收到的文件放到该目录下。

## Windows 使用条件检查

在 Win10 或 Win11 上可以先运行：

```bash
npm.cmd run check:windows
```

检查项包括 Node.js 版本、项目文件、文件保存目录、默认端口和局域网 IPv4 地址。

## 功能

- 手机和电脑互传
- 电脑和电脑互传
- 文字与剪贴板发送
- 文件上传、广播、下载
- 二维码加入和 6 位配对码加入
- 数据保存在本机 `storage/`，不会上传到云端

## 注意

需要设备处在同一个局域网或同一 Wi-Fi 下。若其他设备无法访问，请检查 Windows 防火墙是否允许 Node.js 在专用网络通信。

浏览器请使用新版 Microsoft Edge、Chrome 或 Firefox。IE 和旧版 Edge 不支持此工具。
