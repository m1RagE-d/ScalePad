# 在 iPad 上安装 ScalePad

ScalePad 是本地 PWA。首次安装时 iPad 和电脑需要在同一个 Wi-Fi，完成缓存后可以断开网络使用。

## 在 Mac 上启动

1. 将整个 `ScalePad` 文件夹复制到 Mac。
2. 如果 Mac 没有 `python3`，在“终端”执行 `brew install python`（需要先安装 Homebrew）。
3. 在终端进入项目文件夹并启动：

   ```zsh
   chmod +x ./start-scalepad-mac.sh
   ./start-scalepad-mac.sh
   ```

4. 脚本会显示当前 Mac 的局域网地址。后续证书安装和“添加到主屏幕”步骤与下面相同。

如果 macOS 防火墙询问是否允许 Python 接收传入连接，请选择“允许”。安装完成并确认离线可用后，可以关闭终端窗口。

如果 iPad 无法打开地址，请在 Windows 设置中将当前 WLAN 网络类型改为“专用”，然后用“管理员身份”打开 PowerShell，在项目文件夹运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\allow-scalepad-firewall.ps1
```

## 首次安装

### Windows

1. 在电脑的 ScalePad 文件夹中打开 PowerShell，先启动普通 HTTP 服务：

   ```powershell
   python -m http.server 8000 --bind 0.0.0.0
   ```

2. 再打开一个 PowerShell 窗口，运行 HTTPS 启动脚本：

   ```powershell
   .\start-scalepad.ps1
   ```

   如果 PowerShell 阻止脚本运行，可改用：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\start-scalepad.ps1
   ```

3. 在 iPad Safari 打开脚本显示的证书地址，例如 `http://192.168.1.20:8000/certs/scalepad.crt`，下载并安装证书。

4. 到“设置 > 通用 > VPN 与设备管理”安装刚下载的证书，再到“设置 > 通用 > 关于本机 > 证书信任设置”开启对 `ScalePad local installation` 的完全信任。

5. 在 Safari 打开脚本显示的 HTTPS 地址，例如 `https://192.168.1.20:8443/`。等待页面完整显示后，点“分享 > 添加到主屏幕”。

6. 第一次打开主屏幕图标时保持 Wi-Fi 连接约 30 秒，让问卷和图片完成缓存。然后可开启飞行模式再次打开，确认离线可用。

### macOS

Mac 用户运行 `./start-scalepad-mac.sh` 后，直接使用脚本显示的证书地址和 HTTPS 地址完成上面的第 3–6 步即可。脚本会同时启动两个服务。

## 日常使用

以后直接从 iPad 主屏幕打开“BIP评估”即可，不需要电脑开机，也不需要局域网。开始测试前，系统会先检查本机持久化存储；每次选择会立即写入 IndexedDB，支持 OPFS 的浏览器还会同时写入 ScalePad 专用离线目录。记录包含年龄、每题反应时间、答题耗时、修改次数和题干播放次数。

在 iPad Safari 中，网页不能在没有用户确认的情况下直接指定“文件”App 的下载目录。因此完成测试后请点击“导出 JSON”或“导出 CSV”，在系统文件面板中选择“下载”或其他自定义位置；导出文件中包含完整事件日志。若浏览器支持文件夹权限，也可以在开始答题前选择并验证自定义文件夹，系统会逐题写入该文件夹。

如果电脑更换了局域网 IP，请重新运行启动脚本，并用新的地址访问；若 Safari 报证书名称不匹配，删除项目中的 `certs/scalepad.crt` 以及对应系统的私钥文件后重新生成，并在 iPad 重新信任证书。Windows 私钥位于 `C:\Users\<用户名>\AppData\Local\ScalePad\scalepad.key`，Mac 私钥位于 `~/Library/Application Support/ScalePad/scalepad.key`。
