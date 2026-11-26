// Marigona.app: a small native shell around the static export of the map.
//
// AppKit window + the system WebKit (WKWebView), so the binary is tiny and nothing like Electron is
// bundled. The site (out/, including public/data) ships inside Contents/Resources/site and is served
// through a custom `marigona://` scheme, which lets the page fetch() its tiles and JSON offline
// (fetch from file:// doesn't work in WebKit). Only the Open-Meteo weather needs the network.
//
// View > Map (Cmd-1) is the interactive page, View > Photo Frame (Cmd-2) the frame in full screen,
// which also keeps the display awake natively (the Wake Lock API isn't available here).

import AppKit
import IOKit.pwr_mgt
import UniformTypeIdentifiers
import WebKit

let scheme = "marigona"
let host = "app"

/// Serves files from the bundled static export, mapping Next's routes (/frame) to their .html files.
final class SiteSchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL

    init(root: URL) { self.root = root.standardizedFileURL }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path.removingPercentEncoding ?? url.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        // a route like /frame is frame.html (the export also has a frame/ folder of prefetch data)
        let fm = FileManager.default
        let base = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        var file = base
        var isDir: ObjCBool = false
        if !fm.fileExists(atPath: base.path, isDirectory: &isDir) || isDir.boolValue {
            let html = base.appendingPathExtension("html")
            file = fm.fileExists(atPath: html.path) ? html : base.appendingPathComponent("index.html")
        }

        // never serve anything outside the site folder
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            let notFound = (try? Data(contentsOf: root.appendingPathComponent("404.html"))) ?? Data()
            respond(task, url: url, status: 404, mime: "text/html", data: notFound)
            return
        }
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        respond(task, url: url, status: 200, mime: mime, data: data)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, mime: String, data: Data) {
        let headers = [
            "Content-Type": mime.hasPrefix("text/") || mime.hasSuffix("json") || mime.hasSuffix("javascript")
                ? "\(mime); charset=utf-8" : mime,
            "Content-Length": String(data.count),
            "Access-Control-Allow-Origin": "*",
        ]
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var frameMode = false
    var sleepAssertion: IOPMAssertionID = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let site = Bundle.main.resourceURL!.appendingPathComponent("site")
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(SiteSchemeHandler(root: site), forURLScheme: scheme)
        config.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.allowsMagnification = false
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground") // no white flash before the map paints
        webView.underPageBackgroundColor = NSColor(red: 0.13, green: 0.11, blue: 0.10, alpha: 1)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Marigona"
        // a slim dark title bar of its own, so the traffic lights don't sit on the map's panel
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = webView.underPageBackgroundColor
        window.collectionBehavior = [.fullScreenPrimary]
        window.contentView = webView
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("MarigonaMain")
        window.makeKeyAndOrderFront(nil)

        let args = CommandLine.arguments
        load(frame: args.contains("--frame"))
        NSApp.activate(ignoringOtherApps: true)
        if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count { snapshot(to: args[i + 1]) }
    }

    /// `--snapshot out.png [--frame]`: saves what the web view shows after the map has loaded, plus the
    /// page text, then quits. For checking a build without screen-recording permission.
    func snapshot(to path: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
            self.webView.evaluateJavaScript("document.body.innerText") { text, _ in
                print("page text: \((text as? String ?? "").replacingOccurrences(of: "\n", with: " | "))")
                self.webView.takeSnapshot(with: nil) { image, error in
                    if let tiff = image?.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?
                        .representation(using: .png, properties: [:]) {
                        try? png.write(to: URL(fileURLWithPath: path))
                        print("snapshot: \(path)")
                    } else {
                        print("snapshot failed: \(String(describing: error))")
                    }
                    NSApp.terminate(nil)
                }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: pages

    func load(frame: Bool) {
        frameMode = frame
        webView.load(URLRequest(url: URL(string: "\(scheme)://\(host)/\(frame ? "frame" : "")")!))
        keepDisplayAwake(frame)
        let full = window.styleMask.contains(.fullScreen)
        if frame != full { window.toggleFullScreen(nil) }
    }

    @objc func showMap(_ sender: Any?) { load(frame: false) }
    @objc func showFrame(_ sender: Any?) { load(frame: true) }
    @objc func reloadPage(_ sender: Any?) { webView.reload() }

    /// Links (landmark pages, OSM, credits) open in the default browser, not inside the app.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.scheme != scheme, action.targetFrame?.isMainFrame ?? true {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func keepDisplayAwake(_ on: Bool) {
        if on, sleepAssertion == 0 {
            IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
                                        IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                        "Marigona photo frame" as CFString, &sleepAssertion)
        } else if !on, sleepAssertion != 0 {
            IOPMAssertionRelease(sleepAssertion)
            sleepAssertion = 0
        }
    }

    // MARK: menu

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Marigona", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Marigona", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Marigona", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Map", action: #selector(showMap(_:)), keyEquivalent: "1")
        viewMenu.addItem(withTitle: "Photo Frame", action: #selector(showFrame(_:)), keyEquivalent: "2")
        viewMenu.addItem(.separator())
        viewMenu.addItem(withTitle: "Reload", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        let fs = viewMenu.addItem(withTitle: "Toggle Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
