// Codex 合并台 macOS 桌面壳（系统 WebKit，不依赖 Electron）。
//
// 启动流程：拉起 server.py（端口 0 由系统分配）→ 从其 stdout 解析实际
// 监听地址 → WKWebView 加载该地址。退出时终止子进程。
//
// WKWebView 不提供默认的 JS 弹窗与文件选择器，以下四个 WKUIDelegate
// 回调分别把 alert / confirm / prompt / <input type=file> 桥接到原生面板，
// 前端（app.js）依赖它们实现确认框、重命名输入和导入文件/文件夹。
//
// 环境变量由 install_desktop_macos_app.sh 生成的启动脚本注入：
// - CODEX_SESSION_APP_DIR：前端资源与 server.py 所在目录；
// - CODEX_SESSION_PYTHON：用于运行服务的 python3。
import AppKit
import Foundation
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var serverProcess: Process?
    private var outputBuffer = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1380, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Codex Session Studio"
        window.minSize = NSSize(width: 980, height: 640)
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)

        startServer()
        NSApp.activate(ignoringOtherApps: true)
    }

    private func startServer() {
        guard let projectDirectory = ProcessInfo.processInfo.environment["CODEX_SESSION_APP_DIR"] else {
            showError("无法定位应用文件。请重新安装桌面版。")
            return
        }

        let pythonPath = ProcessInfo.processInfo.environment["CODEX_SESSION_PYTHON"]
            ?? "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: pythonPath)
        process.arguments = ["-u", "server.py", "--host", "127.0.0.1", "--port", "0"]
        process.currentDirectoryURL = URL(fileURLWithPath: projectDirectory)
        process.standardOutput = pipe
        process.standardError = pipe

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let chunk = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.consumeServerOutput(chunk) }
        }

        do {
            try process.run()
            serverProcess = process
        } catch {
            showError("本地服务启动失败：\(error.localizedDescription)")
        }
    }

    private func consumeServerOutput(_ chunk: String) {
        outputBuffer += chunk
        guard let range = outputBuffer.range(of: #"http://127\.0\.0\.1:\d+"#, options: .regularExpression),
              let url = URL(string: String(outputBuffer[range])) else { return }
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        outputBuffer = ""
    }

    private func showError(_ message: String) {
        let html = """
        <html><body style="font:14px -apple-system;padding:48px;color:#20272d">
        <h2>Codex Session Studio</h2><p>\(message)</p></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "Codex Session Studio"
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Codex Session Studio"
        alert.informativeText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Codex Session Studio"
        alert.informativeText = prompt
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        input.stringValue = defaultText ?? ""
        alert.accessoryView = input
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn ? input.stringValue : nil)
        }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = !parameters.allowsDirectories
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverProcess?.terminate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
