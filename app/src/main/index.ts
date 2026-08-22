import { BrowserWindow, app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { registerIpc } from './ipc'
import { startDeviceWatch } from './devices'
import { loadLibrary } from './state'
import { isE2E, runE2E } from './e2e'
import { handlePodProtocol, registerPodScheme } from './media'
import { loadSettings } from './settings'

// 自定义协议注册必须在 app ready 前
registerPodScheme()

function createWindow(): void {
  // 窗口图标（mac 走 Dock/App 图标，此项主要对 win/linux 生效）
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'build', 'icon.png')

  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: 'Echo回响',
    show: !isE2E,
    autoHideMenuBar: true,
    // 隐藏系统标题栏（mac 保留红绿灯浮层），标题栏由渲染层自绘（TitleBar 组件）
    titleBarStyle: 'hidden',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => {
    if (!isE2E) win.show()
  })

  // DevTools：不自动弹出；任何时候用快捷键手动切换
  // macOS 惯例 ⌘⌥I，通用 ⌘/Ctrl+Shift+I，另有 F12
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    const toggleKeys =
      key === 'f12' ||
      (key === 'i' && (input.control || input.meta) && (input.shift || input.alt))
    if (toggleKeys) {
      win.webContents.toggleDevTools()
    }
  })

  // electron-vite 开发模式注入渲染层 dev server URL
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  loadSettings()
  loadLibrary()
  registerIpc()
  handlePodProtocol()
  startDeviceWatch()

  // Dock 图标（dev 模式无 app bundle，BrowserWindow.icon 管不到 Dock，需显式设置）
  const dockIcon = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'build', 'icon.png')
  if (process.platform === 'darwin' && fs.existsSync(dockIcon)) {
    app.dock?.setIcon(dockIcon)
  }

  createWindow()

  // 端到端自动跑批（无窗口，日志输出到 stdout）
  if (isE2E) void runE2E()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
