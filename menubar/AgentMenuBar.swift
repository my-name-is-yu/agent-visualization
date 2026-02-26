import Cocoa
import Foundation
import UserNotifications

// MARK: - Config

let kMenuWidth: CGFloat = 480
let kPadding: CGFloat = 16
let kContentWidth: CGFloat = kMenuWidth - kPadding * 2

// MARK: - Data Models

struct AgentInfo {
    let id: String
    let description: String
    let subagentType: String
    let status: String
    let parentId: String?
    let durationMs: Int?
    let sessionId: String
    let outputPreview: String?
    let outputFile: String?
    let prompt: String?
    let background: Bool
    let startedAt: String
    let totalTokens: Int?
    let toolUses: Int?
}

struct SessionUsage {
    var totalTokens: Int = 0
    var toolUses: Int = 0
    var durationMs: Int = 0
    var agentCount: Int = 0
    var estimatedCostUsd: Double = 0
}

struct SessionInfo {
    let sessionId: String
    let agentCount: Int
    let running: Int
    let completed: Int
    let errored: Int
}

struct AgentState {
    var total: Int = 0
    var running: Int = 0
    var completed: Int = 0
    var errored: Int = 0
    var bossStatus: String = "idle"
    var bossModel: String = "opus"
    var agents: [AgentInfo] = []
    var usage = SessionUsage()
    var sessions: [SessionInfo] = []
}

// MARK: - Clickable Views

class ClickableAgentRow: NSView {
    var agent: AgentInfo?
    var onSelect: (() -> Void)?

    override func mouseUp(with event: NSEvent) {
        onSelect?()
    }
}

class ClickableRow: NSView {
    var onClick: (() -> Void)?

    override func mouseUp(with event: NSEvent) {
        onClick?()
    }
}

class CopyButtonView: NSView {
    let contentToCopy: String
    var label: NSTextField!
    var originalTitle: String

    init(title: String, content: String, menuWidth: CGFloat) {
        self.contentToCopy = content
        self.originalTitle = title
        super.init(frame: NSRect(x: 0, y: 0, width: menuWidth, height: 28))

        let icon = NSTextField(labelWithAttributedString: NSAttributedString(
            string: "\u{2398}",
            attributes: [
                .font: NSFont.systemFont(ofSize: 12, weight: .regular),
                .foregroundColor: NSColor.systemBlue
            ]
        ))
        icon.sizeToFit()
        icon.frame.origin = CGPoint(x: kPadding, y: (28 - icon.frame.height) / 2)
        addSubview(icon)

        label = NSTextField(labelWithAttributedString: NSAttributedString(
            string: title,
            attributes: [
                .font: NSFont.systemFont(ofSize: 12, weight: .medium),
                .foregroundColor: NSColor.systemBlue
            ]
        ))
        label.sizeToFit()
        label.frame.origin = CGPoint(x: kPadding + 20, y: (28 - label.frame.height) / 2)
        addSubview(label)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func mouseUp(with event: NSEvent) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(contentToCopy, forType: .string)
        label.attributedStringValue = NSAttributedString(
            string: "Copied!",
            attributes: [
                .font: NSFont.systemFont(ofSize: 12, weight: .medium),
                .foregroundColor: NSColor.systemGreen
            ]
        )
        label.sizeToFit()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self = self else { return }
            self.label.attributedStringValue = NSAttributedString(
                string: self.originalTitle,
                attributes: [
                    .font: NSFont.systemFont(ofSize: 12, weight: .medium),
                    .foregroundColor: NSColor.systemBlue
                ]
            )
            self.label.sizeToFit()
        }
    }
}

// MARK: - SSE Delegate

class SSEDelegate: NSObject, URLSessionDataDelegate {
    let onEvent: () -> Void
    let onDisconnect: () -> Void

    init(onEvent: @escaping () -> Void, onDisconnect: @escaping () -> Void) {
        self.onEvent = onEvent
        self.onDisconnect = onDisconnect
        super.init()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if let str = String(data: data, encoding: .utf8), str.contains("state-changed") {
            onEvent()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        onDisconnect()
    }
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    var statusItem: NSStatusItem!
    var timer: Timer?
    var currentState = AgentState()
    var connected = false
    let serverPort: Int
    var previousAgentStatuses: [String: String] = [:]
    var currentPollInterval: TimeInterval = 30.0
    var selectedAgent: AgentInfo?
    var menuIsOpen = false
    var iconImage: NSImage?
    var sseTask: URLSessionDataTask?
    var sseSession: URLSession?
    var sseReconnectTimer: Timer?
    var elapsedRefreshTimer: Timer?
    var lastMenuBuildTime: Date = .distantPast

    override init() {
        if let envPort = ProcessInfo.processInfo.environment["AGENT_VIZ_PORT"],
           let p = Int(envPort) {
            serverPort = p
        } else {
            serverPort = 1217
        }
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.autosaveName = "AgentMenuBarStatusItem"
        statusItem.behavior = []

        // Load icon images: try bundle Resources first, then relative to binary
        let execPath = (ProcessInfo.processInfo.arguments[0] as NSString).standardizingPath
        let execDir = (execPath as NSString).deletingLastPathComponent
        let candidates = [
            Bundle.main.path(forResource: "Icon", ofType: "png"),
            ((execDir as NSString).appendingPathComponent("../Icon.png") as NSString).standardizingPath,
        ]
        let iconPath = candidates.compactMap({ $0 }).first(where: { FileManager.default.fileExists(atPath: $0) })
        NSLog("[AgentMenuBar] Icon path: %@, exists: %d", iconPath ?? "nil", iconPath != nil ? 1 : 0)
        if let path = iconPath, let img = NSImage(contentsOfFile: path) {
            img.size = NSSize(width: 18, height: 18)
            img.isTemplate = false
            iconImage = img
        }

        if let button = statusItem.button {
            if let img = iconImage {
                button.image = img
                button.imagePosition = .imageLeading
            } else {
                button.title = "🤖"
            }
            button.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .medium)
        }

        if let window = statusItem.button?.window {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(statusItemOcclusionChanged(_:)),
                name: NSWindow.didChangeOcclusionStateNotification,
                object: window
            )
        }

        statusItem.menu = NSMenu()
        statusItem.menu?.minimumWidth = kMenuWidth
        statusItem.menu?.delegate = self
        buildMenu()
        startPolling()
        connectSSE()

        // Request notification authorization (may fail for non-bundled binaries)
        if Bundle.main.bundleIdentifier != nil {
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        disconnectSSE()
    }

    @objc func statusItemOcclusionChanged(_ notification: Notification) {
        guard Bundle.main.bundleIdentifier != nil else { return }
        guard let window = statusItem.button?.window else { return }
        let isOccluded = !window.occlusionState.contains(.visible)
        if isOccluded && currentState.running > 0 {
            let content = UNMutableNotificationContent()
            content.title = "Agents Running"
            content.body = "\(currentState.running) agent(s) currently running (menu bar icon hidden)"
            content.sound = .default
            let request = UNNotificationRequest(identifier: "occlusion-warning", content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
        }
    }

    // MARK: - Polling

    func startPolling() {
        fetchState()
        timer = Timer.scheduledTimer(withTimeInterval: currentPollInterval, repeats: true) { [weak self] _ in
            self?.fetchState()
        }
        if let t = timer {
            RunLoop.current.add(t, forMode: .common)
        }
        NSLog("[AgentMenuBar] Polling started on port %d", serverPort)
    }

    func adjustPollingRate() {
        let newInterval: TimeInterval = currentState.running > 0 ? 5.0 : 30.0
        if newInterval != currentPollInterval {
            currentPollInterval = newInterval
            timer?.invalidate()
            timer = Timer.scheduledTimer(withTimeInterval: newInterval, repeats: true) { [weak self] _ in
                self?.fetchState()
            }
            if let t = timer { RunLoop.current.add(t, forMode: .common) }
        }
    }

    // MARK: - SSE

    func connectSSE() {
        disconnectSSE()

        guard let url = URL(string: "http://127.0.0.1:\(serverPort)/events") else { return }

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = .greatestFiniteMagnitude
        config.timeoutIntervalForResource = .greatestFiniteMagnitude

        let delegate = SSEDelegate(
            onEvent: { [weak self] in
                DispatchQueue.main.async {
                    self?.fetchState()
                }
            },
            onDisconnect: { [weak self] in
                DispatchQueue.main.async {
                    self?.scheduleSSEReconnect()
                }
            }
        )
        sseSession = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        sseTask = sseSession?.dataTask(with: URLRequest(url: url))
        sseTask?.resume()
        NSLog("[AgentMenuBar] SSE connected to port %d", serverPort)
    }

    func disconnectSSE() {
        sseReconnectTimer?.invalidate()
        sseReconnectTimer = nil
        sseTask?.cancel()
        sseTask = nil
        sseSession?.invalidateAndCancel()
        sseSession = nil
    }

    func scheduleSSEReconnect() {
        guard sseReconnectTimer == nil else { return }
        sseReconnectTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: false) { [weak self] _ in
            self?.sseReconnectTimer = nil
            self?.connectSSE()
        }
    }

    func fetchState() {
        guard let url = URL(string: "http://127.0.0.1:\(serverPort)/state") else { return }

        var request = URLRequest(url: url)
        request.timeoutInterval = 3

        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            guard let self = self else { return }

            if let error = error {
                NSLog("[AgentMenuBar] Fetch error: %@", error.localizedDescription)
                DispatchQueue.main.async {
                    self.connected = false
                    self.currentState = AgentState()
                    self.updateUI()
                }
                return
            }

            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                NSLog("[AgentMenuBar] Failed to parse response")
                DispatchQueue.main.async {
                    self.connected = false
                    self.updateUI()
                }
                return
            }

            let state = self.parseState(json)
            DispatchQueue.main.async {
                self.connected = true
                self.checkAndNotify(state)
                self.currentState = state
                self.updateUI()
                self.adjustPollingRate()
            }
        }.resume()
    }

    // MARK: - Notifications

    func checkAndNotify(_ newState: AgentState) {
        for agent in newState.agents {
            let prev = previousAgentStatuses[agent.id]
            if prev == "running" && (agent.status == "completed" || agent.status == "errored") {
                sendNotification(agent: agent)
            }
        }
        previousAgentStatuses = Dictionary(uniqueKeysWithValues: newState.agents.map { ($0.id, $0.status) })
    }

    func sendNotification(agent: AgentInfo) {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let content = UNMutableNotificationContent()
        content.title = agent.status == "errored" ? "Agent Error" : "Agent Complete"
        content.body = "\(agent.subagentType): \(agent.description)"
        content.sound = .default
        let request = UNNotificationRequest(identifier: agent.id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                NSLog("[AgentMenuBar] Notification error: %@", error.localizedDescription)
            }
        }
    }

    // MARK: - Parsing

    func parseState(_ json: [String: Any]) -> AgentState {
        var state = AgentState()

        if let summary = json["summary"] as? [String: Any] {
            state.total = summary["total"] as? Int ?? 0
            state.running = summary["running"] as? Int ?? 0
            state.completed = summary["completed"] as? Int ?? 0
            state.errored = summary["errored"] as? Int ?? 0
        }

        if let boss = json["boss"] as? [String: Any] {
            state.bossStatus = boss["status"] as? String ?? "idle"
            state.bossModel = boss["model"] as? String ?? "opus"
        }

        if let agents = json["agents"] as? [[String: Any]] {
            state.agents = agents.map { a in
                let agentUsage = a["usage"] as? [String: Any]
                return AgentInfo(
                    id: a["id"] as? String ?? "",
                    description: a["description"] as? String ?? "",
                    subagentType: a["subagent_type"] as? String ?? "unknown",
                    status: a["status"] as? String ?? "unknown",
                    parentId: a["parent_id"] as? String,
                    durationMs: a["duration_ms"] as? Int,
                    sessionId: a["session_id"] as? String ?? "unknown",
                    outputPreview: a["output_preview"] as? String,
                    outputFile: a["output_file"] as? String,
                    prompt: a["prompt"] as? String,
                    background: a["background"] as? Bool ?? false,
                    startedAt: a["started_at"] as? String ?? "",
                    totalTokens: agentUsage?["total_tokens"] as? Int,
                    toolUses: agentUsage?["tool_uses"] as? Int
                )
            }
        }

        if let usage = json["usage"] as? [String: Any] {
            state.usage.totalTokens = usage["total_tokens"] as? Int ?? 0
            state.usage.toolUses = usage["tool_uses"] as? Int ?? 0
            state.usage.durationMs = usage["duration_ms"] as? Int ?? 0
            state.usage.agentCount = usage["agent_count"] as? Int ?? 0
            state.usage.estimatedCostUsd = usage["estimated_cost_usd"] as? Double ?? 0
        }

        if let sessions = json["sessions"] as? [[String: Any]] {
            state.sessions = sessions.map { s in
                SessionInfo(
                    sessionId: s["session_id"] as? String ?? "unknown",
                    agentCount: s["agent_count"] as? Int ?? 0,
                    running: s["running"] as? Int ?? 0,
                    completed: s["completed"] as? Int ?? 0,
                    errored: s["errored"] as? Int ?? 0
                )
            }
        }

        return state
    }

    // MARK: - NSMenuDelegate

    func menuWillOpen(_ menu: NSMenu) {
        menuIsOpen = true
        buildMenu()
        if currentState.running > 0 {
            elapsedRefreshTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
                guard let self = self, self.menuIsOpen, self.currentState.running > 0 else {
                    self?.elapsedRefreshTimer?.invalidate()
                    self?.elapsedRefreshTimer = nil
                    return
                }
                self.buildMenu()
            }
        }
    }

    func menuDidClose(_ menu: NSMenu) {
        menuIsOpen = false
        selectedAgent = nil  // Reset navigation on close
        elapsedRefreshTimer?.invalidate()
        elapsedRefreshTimer = nil
    }

    // MARK: - UI

    func updateUI() {
        // Refresh selectedAgent from latest state
        if let selected = selectedAgent {
            selectedAgent = currentState.agents.first(where: { $0.id == selected.id })
        }
        updateMenuBarTitle()
        if menuIsOpen {
            buildMenu()
        }
    }

    func updateMenuBarTitle() {
        guard let button = statusItem.button else { return }

        button.image = iconImage

        if !connected {
            button.title = " idle"
            return
        }

        let s = currentState

        if s.bossStatus == "running" {
            button.title = " running"
        } else if s.bossStatus == "done" {
            button.title = " done"
        } else {
            button.title = " idle"
        }
    }

    func buildMenu() {
        let now = Date()
        if menuIsOpen && now.timeIntervalSince(lastMenuBuildTime) < 0.3 { return }
        lastMenuBuildTime = now

        guard let menu = statusItem.menu else { return }
        menu.removeAllItems()

        if !connected {
            let item = NSMenuItem()
            item.view = makeErrorView("Server not connected (port \(serverPort))")
            menu.addItem(item)
            menu.addItem(NSMenuItem.separator())
            menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
            return
        }

        if let agent = selectedAgent {
            buildDetailMenu(agent, menu: menu)
        } else {
            buildListMenu(menu: menu)
        }
    }

    // MARK: - List View (normal menu)

    func buildListMenu(menu: NSMenu) {
        let s = currentState

        // -- Boss Section --
        let bossItem = NSMenuItem()
        bossItem.view = makeBossView(s)
        menu.addItem(bossItem)
        menu.addItem(NSMenuItem.separator())

        // -- Summary Row --
        let summaryItem = NSMenuItem()
        summaryItem.view = makeSummaryView(s)
        menu.addItem(summaryItem)
        menu.addItem(NSMenuItem.separator())

        // -- Agent List --
        if s.agents.isEmpty {
            let emptyItem = NSMenuItem()
            emptyItem.view = makeEmptyAgentsView()
            menu.addItem(emptyItem)
        } else {
            let sessionIds = Set(s.agents.map { $0.sessionId })
            if sessionIds.count > 1 {
                // Group by session
                for session in s.sessions.sorted(by: { $0.running > $1.running }) {
                    let sessionAgents = s.agents.filter { $0.sessionId == session.sessionId }
                    if sessionAgents.isEmpty { continue }

                    let sessHeader = NSMenuItem()
                    let shortId = String(session.sessionId.prefix(8))
                    let runningText = session.running > 0 ? " (\(session.running) running)" : ""
                    let headerView = NSView(frame: NSRect(x: 0, y: 0, width: kMenuWidth, height: 24))
                    let headerLabel = makeSectionHeader("SESSION \(shortId)\(runningText)")
                    headerLabel.frame.origin = CGPoint(x: kPadding, y: 6)
                    headerView.addSubview(headerLabel)
                    sessHeader.view = headerView
                    menu.addItem(sessHeader)

                    let sorted = sessionAgents.sorted { a, b in
                        let order = ["running": 0, "errored": 1, "completed": 2]
                        return (order[a.status] ?? 3) < (order[b.status] ?? 3)
                    }
                    for agent in sorted {
                        let item = NSMenuItem()
                        item.view = makeAgentRowView(agent)
                        menu.addItem(item)
                    }
                }
            } else {
                // Single session - keep current behavior
                let headerItem = NSMenuItem()
                headerItem.view = makeAgentHeaderView()
                menu.addItem(headerItem)

                let sorted = s.agents.sorted { a, b in
                    let order = ["running": 0, "errored": 1, "completed": 2]
                    return (order[a.status] ?? 3) < (order[b.status] ?? 3)
                }

                for agent in sorted {
                    let item = NSMenuItem()
                    item.view = makeAgentRowView(agent)
                    menu.addItem(item)
                }
            }
        }

        menu.addItem(NSMenuItem.separator())
        if s.total > 0 {
            let resetItem = NSMenuItem(title: "⟲ Reset", action: #selector(resetServer), keyEquivalent: "r")
            resetItem.target = self
            menu.addItem(resetItem)
        }
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    @objc func resetServer() {
        guard let url = URL(string: "http://127.0.0.1:\(serverPort)/reset") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.async {
                self?.fetchState()
            }
        }.resume()
    }

    // MARK: - Detail View

    func buildDetailMenu(_ agent: AgentInfo, menu: NSMenu) {
        // -- Back Button --
        let backItem = NSMenuItem()
        backItem.view = makeBackButton()
        menu.addItem(backItem)
        menu.addItem(NSMenuItem.separator())

        // -- Agent Header: status dot + type + duration --
        let headerItem = NSMenuItem()
        headerItem.view = makeDetailHeader(agent)
        menu.addItem(headerItem)
        menu.addItem(NSMenuItem.separator())

        // -- Description Section --
        let descItem = NSMenuItem()
        descItem.view = makeDetailSection(title: "DESCRIPTION", content: agent.description)
        menu.addItem(descItem)
        menu.addItem(NSMenuItem.separator())

        // -- Prompt Section --
        if let prompt = agent.prompt, !prompt.isEmpty {
            let promptItem = NSMenuItem()
            promptItem.view = makeDetailSection(title: "PROMPT", content: prompt)
            menu.addItem(promptItem)
            let copyPromptItem = NSMenuItem()
            copyPromptItem.view = CopyButtonView(title: "Copy Prompt", content: prompt, menuWidth: kMenuWidth)
            menu.addItem(copyPromptItem)
            menu.addItem(NSMenuItem.separator())
        }

        // -- Output Section --
        if let output = agent.outputPreview, !output.isEmpty {
            let outputItem = NSMenuItem()
            outputItem.view = makeDetailSection(title: "OUTPUT", content: output)
            menu.addItem(outputItem)
            let copyOutputItem = NSMenuItem()
            copyOutputItem.view = CopyButtonView(title: "Copy Output", content: output, menuWidth: kMenuWidth)
            menu.addItem(copyOutputItem)
            menu.addItem(NSMenuItem.separator())
        }

        // -- Usage Section --
        if agent.totalTokens != nil || agent.toolUses != nil || agent.durationMs != nil {
            let usageItem = NSMenuItem()
            usageItem.view = makeUsageSection(agent)
            menu.addItem(usageItem)
            menu.addItem(NSMenuItem.separator())
        }

        // -- Session ID --
        let shortSession = String(agent.sessionId.prefix(8))
        let sessionItem = NSMenuItem()
        let sessionView = NSView(frame: NSRect(x: 0, y: 0, width: kMenuWidth, height: 28))
        let sessionLabel = makeSystemLabel("Session: \(shortSession)", size: 12, weight: .regular, color: .tertiaryLabelColor)
        sessionLabel.frame.origin = CGPoint(x: kPadding, y: 6)
        sessionView.addSubview(sessionLabel)
        sessionItem.view = sessionView
        menu.addItem(sessionItem)
        menu.addItem(NSMenuItem.separator())

        // -- Open Full Log Button --
        if let outputFile = agent.outputFile, FileManager.default.fileExists(atPath: outputFile) {
            let logItem = NSMenuItem()
            logItem.view = makeOpenLogButton(outputFile)
            menu.addItem(logItem)
            menu.addItem(NSMenuItem.separator())
        }

        // -- Quit --
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    func makeBackButton() -> NSView {
        let height: CGFloat = 32
        let view = ClickableRow(frame: NSRect(x: 0, y: 0, width: kMenuWidth, height: height))
        view.onClick = { [weak self] in
            self?.selectedAgent = nil
            self?.buildMenu()
        }

        let backLabel = makeSystemLabel("\u{2190} Back", size: 14, weight: .medium, color: .secondaryLabelColor)
        backLabel.frame.origin = CGPoint(x: kPadding, y: (height - backLabel.frame.height) / 2)
        view.addSubview(backLabel)

        return view
    }

    func makeDetailHeader(_ agent: AgentInfo) -> NSView {
        let hasUsage = agent.totalTokens != nil || agent.toolUses != nil
        let height: CGFloat = hasUsage ? 50 : 32
        let firstLineY: CGFloat = hasUsage ? height - 22 : (height - 16) / 2
        let view = NSView(frame: NSRect(x: 0, y: 0, width: kMenuWidth, height: height))

        let (icon, iconColor) = statusDisplay(agent.status)

        let dotLabel = makeSystemLabel(icon, size: 16, weight: .regular, color: iconColor)
        dotLabel.frame.origin = CGPoint(x: kPadding, y: firstLineY)
        view.addSubview(dotLabel)

        let typeLabel = makeSystemLabel(agent.subagentType, size: 16, weight: .semibold, color: .labelColor)
        typeLabel.frame.origin = CGPoint(x: kPadding + 22, y: firstLineY)
        view.addSubview(typeLabel)

        if let ms = agent.durationMs {
            let durLabel = makeMonoLabel(formatDuration(ms), size: 14, weight: .regular, color: .secondaryLabelColor)
            durLabel.sizeToFit()
            durLabel.frame.origin = CGPoint(x: kMenuWidth - kPadding - durLabel.frame.width, y: firstLineY)
            view.addSubview(durLabel)
        } else if let elapsed = elapsedString(for: agent) {
            let elapsedLabel = makeMonoLabel(elapsed, size: 14, weight: .regular, color: .systemBlue)
            elapsedLabel.sizeToFit()
            elapsedLabel.frame.origin = CGPoint(x: kMenuWidth - kPadding - elapsedLabel.frame.width, y: firstLineY)
            view.addSubview(elapsedLabel)
        } else if agent.status == "running" {
            let runLabel = makeSystemLabel("running", size: 14, weight: .regular, color: .systemBlue)
            runLabel.sizeToFit()
            runLabel.frame.origin = CGPoint(x: kMenuWidth - kPadding - runLabel.frame.width, y: firstLineY)
            view.addSubview(runLabel)
        }

        // Usage info on second line
        if hasUsage {
            var usageParts: [String] = []
            if let tokens = agent.totalTokens, tokens > 0 {
                usageParts.append("\(formatTokenCount(tokens)) tokens")
            }
            if let tools = agent.toolUses, tools > 0 {
                usageParts.append("\(tools) tool uses")
            }
            let usageText = usageParts.joined(separator: "  |  ")
            let usageLabel = makeSystemLabel(usageText, size: 12, weight: .regular, color: .tertiaryLabelColor)
            usageLabel.frame.origin = CGPoint(x: kPadding + 22, y: 6)
            view.addSubview(usageLabel)
        }

        return view
    }

    func makeDetailSection(title: String, content: String, maxHeight: CGFloat = 200) -> NSView {
        let titleFont = NSFont.systemFont(ofSize: 11, weight: .bold)
        let contentFont = NSFont.systemFont(ofSize: 13, weight: .regular)
        let titleHeight: CGFloat = 18
        let topPad: CGFloat = 8
        let midPad: CGFloat = 4
        let bottomPad: CGFloat = 8

        // Measure natural content height using a temporary text container
        let textStorage = NSTextStorage(string: content, attributes: [
            .font: contentFont,
            .foregroundColor: NSColor.labelColor
        ])
        let textContainer = NSTextContainer(containerSize: NSSize(width: kContentWidth - 10, height: .greatestFiniteMagnitude))
        textContainer.lineFragmentPadding = 5
        let layoutManager = NSLayoutManager()
        layoutManager.addTextContainer(textContainer)
        textStorage.addLayoutManager(layoutManager)
        layoutManager.ensureLayout(for: textContainer)
        let naturalHeight = max(layoutManager.usedRect(for: textContainer).height + 4, 18)

        let needsScroll = naturalHeight > maxHeight
        let contentHeight = needsScroll ? maxHeight : naturalHeight

        let totalHeight = topPad + titleHeight + midPad + contentHeight + bottomPad
        let view = NSView(frame: NSRect(x: 0, y: 0, width: kMenuWidth, height: totalHeight))

        // Title
        let titleLabel = NSTextField(labelWithAttributedString: NSAttributedString(
            string: title,
            attributes: [
                .font: titleFont,
                .foregroundColor: NSColor.secondaryLabelColor,
                .kern: 1.2 as NSNumber
            ]
        ))
        titleLabel.sizeToFit()
        titleLabel.frame.origin = CGPoint(x: kPadding, y: totalHeight - topPad - titleHeight)
        view.addSubview(titleLabel)

        // Scrollable, selectable text view
        let scrollView = NSScrollView(frame: NSRect(x: kPadding, y: bottomPad, width: kContentWidth, height: contentHeight))
        scrollView.hasVerticalScroller = needsScroll
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false
        scrollView.scrollerStyle = .overlay

        let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: kContentWidth, height: contentHeight))
        textView.string = content
        textView.font = contentFont
        textView.textColor = .labelColor
        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 0, height: 2)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: kContentWidth, height: .greatestFiniteMagnitude)
        textView.textContainer?.lineFragmentPadding = 5

        scrollView.documentView = textView
        view.addSubview(scrollView)

        return view
    }

    func makeUsageSection(_ agent: AgentInfo) -> NSView {
        let titleFont = NSFont.systemFont(ofSize: 11, weight: .bold)
        let titleHeight: CGFloat = 18
        let topPad: CGFloat = 8
        let bottomPad: CGFloat = 8

        // Build usage items
        struct UsageItem {
            let label: String
            let value: String
            let color: NSColor
        }

        var items: [UsageItem] = []
        if let tokens = agent.totalTokens, tokens > 0 {
            items.append(UsageItem(label: "Tokens", value: formatTokenCount(tokens), color: .labelColor))
        }
        if let tools = agent.toolUses, tools > 0 {
            items.append(UsageItem(label: "Tool uses", value: "\(tools)", color: .labelColor))
        }
        if let ms = agent.durationMs, ms > 0 {
            items.append(UsageItem(label: "Duration", value: formatDuration(ms), color: .labelColor))
        }


        let rowHeight: CGFloat = 22
        let contentHeight = CGFloat(items.count) * rowHeight
        let totalHeight = topPad + titleHeight + 4 + contentHeight + bottomPad
        let view = NSView(frame: NSRect(x: 0, y: 0, width: kMenuWidth, height: totalHeight))

        // Title
        let titleLabel = NSTextField(labelWithAttributedString: NSAttributedString(
            string: "USAGE",
            attributes: [
                .font: titleFont,
                .foregroundColor: NSColor.secondaryLabelColor,
                .kern: 1.2 as NSNumber
            ]
        ))
        titleLabel.sizeToFit()
        titleLabel.frame.origin = CGPoint(x: kPadding, y: totalHeight - topPad - titleHeight)
        view.addSubview(titleLabel)

        // Usage rows
        for (i, item) in items.enumerated() {
            let y = bottomPad + CGFloat(items.count - 1 - i) * rowHeight

            let labelField = makeSystemLabel(item.label, size: 12, weight: .regular, color: .secondaryLabelColor)
            labelField.frame.origin = CGPoint(x: kPadding + 4, y: y + 2)
            view.addSubview(labelField)

            let valueField = makeMonoLabel(item.value, size: 12, weight: .medium, color: item.color)
            valueField.sizeToFit()
            valueField.frame.origin = CGPoint(x: kPadding + 100, y: y + 2)
            view.addSubview(valueField)
        }

        return view
    }

    func makeOpenLogButton(_ path: String) -> NSView {
        let height: CGFloat = 32
        let view = ClickableRow(frame: NSRect(x: 0, y: 0, width: kMenuWidth, height: height))
        view.onClick = { [weak self] in
            self?.statusItem.menu?.cancelTracking()
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        }

        let label = makeSystemLabel("\u{1F4C4} Open Full Log", size: 13, weight: .medium, color: .systemBlue)
        label.frame.origin = CGPoint(x: kPadding, y: (height - label.frame.height) / 2)
        view.addSubview(label)

        return view
    }

    // MARK: - Summary View

    func makeSummaryView(_ s: AgentState) -> NSView {
        let height: CGFloat = 36
        let view = NSView(frame: NSRect(x: 0, y: 0, width: kMenuWidth, height: height))

        // Items: "N Agents", "N Tasks", "N Done", optionally "N Error", optionally "$X.XX Cost"
        struct CountItem {
            let number: String
            let label: String
            let numColor: NSColor
        }

        var items: [CountItem] = [
            CountItem(number: "\(s.total)",     label: "Agents",  numColor: .labelColor),
        ]
        if s.running > 0 {
            items.append(CountItem(number: "\(s.running)", label: "Running", numColor: .systemBlue))
        }
        items.append(CountItem(number: "\(s.completed)", label: "Done", numColor: .systemGreen))
        if s.errored > 0 {
            items.append(CountItem(number: "\(s.errored)", label: "Error", numColor: .systemRed))
        }
        if s.usage.estimatedCostUsd > 0.001 {
            items.append(CountItem(
                number: String(format: "$%.2f", s.usage.estimatedCostUsd),
                label: "Cost",
                numColor: .systemOrange
            ))
        }

        let font = NSFont.systemFont(ofSize: 14, weight: .bold)
        let labelFont = NSFont.systemFont(ofSize: 14, weight: .bold)

        // Measure total width so we can center the row
        let spacing: CGFloat = 20
        var totalWidth: CGFloat = 0
        var widths: [(CGFloat, CGFloat)] = [] // (numW, labelW) per item
        for (i, item) in items.enumerated() {
            let numW = (item.number as NSString).size(withAttributes: [.font: font]).width
            let lblW = (item.label as NSString).size(withAttributes: [.font: labelFont]).width
            widths.append((ceil(numW), ceil(lblW)))
            totalWidth += ceil(numW) + 4 + ceil(lblW)
            if i < items.count - 1 { totalWidth += spacing }
        }

        var x = (kMenuWidth - totalWidth) / 2
        let baseline: CGFloat = (height - 17) / 2  // vertically center the 14pt text

        for (i, item) in items.enumerated() {
            let (numW, lblW) = widths[i]

            let numLabel = NSTextField(labelWithAttributedString: NSAttributedString(
                string: item.number,
                attributes: [.font: font, .foregroundColor: item.numColor]
            ))
            numLabel.sizeToFit()
            numLabel.frame.origin = CGPoint(x: x, y: baseline)
            view.addSubview(numLabel)
            x += numW + 4

            let lblLabel = NSTextField(labelWithAttributedString: NSAttributedString(
                string: item.label,
                attributes: [.font: labelFont, .foregroundColor: NSColor.labelColor]
            ))
            lblLabel.sizeToFit()
            lblLabel.frame.origin = CGPoint(x: x, y: baseline)
            view.addSubview(lblLabel)
            x += lblW

            if i < items.count - 1 { x += spacing }
        }

        return view
    }

    // MARK: - Error View

    func makeErrorView(_ message: String) -> NSView {
        let view = NSView(frame: NSRect(x: 0, y: 0, width: kMenuWidth, height: 40))

        let icon = makeSystemLabel("\u{26A0}", size: 13, weight: .medium, color: .systemRed)
        icon.frame.origin = CGPoint(x: kPadding, y: 12)
        view.addSubview(icon)

        let label = makeSystemLabel(message, size: 13, weight: .medium, color: .labelColor)
        label.frame.origin = CGPoint(x: kPadding + 20, y: 12)
        view.addSubview(label)

        return view
    }

    // MARK: - Boss View

    func makeBossView(_ s: AgentState) -> NSView {
        let rowHeight: CGFloat = 48
        let view = NSView(frame: NSRect(x: 0, y: 0, width: kMenuWidth, height: rowHeight))

        let header = makeSectionHeader("BOSS")
        header.frame.origin = CGPoint(x: kPadding, y: rowHeight - 16)
        view.addSubview(header)

        let (statusText, statusColor): (String, NSColor)
        switch s.bossStatus {
        case "running":
            if s.running > 0 {
                statusText = "running (\(s.running) agent\(s.running == 1 ? "" : "s") active)"
            } else {
                statusText = "running"
            }
            statusColor = .systemBlue
        case "done":
            statusText = "done (\(s.completed) completed\(s.errored > 0 ? ", \(s.errored) errored" : ""))"
            statusColor = .systemGreen
        default:
            statusText = "idle"
            statusColor = .secondaryLabelColor
        }

        let textIndent: CGFloat = kPadding + 22

        let dotLabel = makeSystemLabel("\u{25CF}", size: 14, weight: .regular, color: statusColor)
        dotLabel.frame.origin = CGPoint(x: kPadding, y: 8)
        view.addSubview(dotLabel)

        let bossLabel = makeSystemLabel("Boss (\(s.bossModel))", size: 13, weight: .semibold, color: .labelColor)
        bossLabel.frame.origin = CGPoint(x: textIndent, y: 8)
        view.addSubview(bossLabel)

        let statusLabel = makeSystemLabel(statusText, size: 12, weight: .regular, color: statusColor)
        statusLabel.sizeToFit()
        statusLabel.frame.origin = CGPoint(x: kMenuWidth - kPadding - statusLabel.frame.width, y: 9)
        view.addSubview(statusLabel)

        return view
    }

    // MARK: - Agent Views

    func makeEmptyAgentsView() -> NSView {
        let view = NSView(frame: NSRect(x: 0, y: 0, width: kMenuWidth, height: 52))

        let header = makeSectionHeader("AGENTS")
        header.frame.origin = CGPoint(x: kPadding, y: 34)
        view.addSubview(header)

        let label = makeSystemLabel("No agents running", size: 13, weight: .regular, color: .secondaryLabelColor)
        label.frame.origin = CGPoint(x: kPadding, y: 10)
        view.addSubview(label)

        return view
    }

    func makeAgentHeaderView() -> NSView {
        let view = NSView(frame: NSRect(x: 0, y: 0, width: kMenuWidth, height: 28))

        let header = makeSectionHeader("AGENTS")
        header.frame.origin = CGPoint(x: kPadding, y: 10)
        view.addSubview(header)

        return view
    }

    func makeAgentRowView(_ agent: AgentInfo) -> NSView {
        // Row: icon (20) + type label bold + description line, duration right-aligned
        // Two lines: line1 = icon + type; line2 = description (indented)
        let rowHeight: CGFloat = 44
        let view = ClickableAgentRow(frame: NSRect(x: 0, y: 0, width: kMenuWidth, height: rowHeight))
        view.agent = agent
        view.onSelect = { [weak self] in
            self?.selectedAgent = agent
            self?.buildMenu()
        }

        let (icon, iconColor) = statusDisplay(agent.status)
        let iconLabel = makeSystemLabel(icon, size: 14, weight: .regular, color: iconColor)
        iconLabel.frame.origin = CGPoint(x: kPadding, y: rowHeight - 22)
        view.addSubview(iconLabel)

        let textIndent: CGFloat = kPadding + 22

        // Agent type: bold, labelColor
        let typeLabel = makeSystemLabel(agent.subagentType, size: 13, weight: .semibold, color: .labelColor)
        typeLabel.frame.origin = CGPoint(x: textIndent, y: rowHeight - 22)
        view.addSubview(typeLabel)

        // Background/foreground indicator
        let bgFgText = agent.background ? "bg" : "fg"
        let bgFgLabel = makeSystemLabel(bgFgText, size: 10, weight: .regular, color: .tertiaryLabelColor)
        bgFgLabel.frame.origin = CGPoint(x: textIndent + typeLabel.frame.width + 4, y: rowHeight - 21)
        view.addSubview(bgFgLabel)

        // Chevron indicator for drill-down
        let chevron = makeSystemLabel("\u{203A}", size: 14, weight: .regular, color: .tertiaryLabelColor)
        chevron.sizeToFit()
        chevron.frame.origin = CGPoint(x: textIndent + typeLabel.frame.width + 4 + bgFgLabel.frame.width + 4, y: rowHeight - 21)
        view.addSubview(chevron)

        // Elapsed time for running agents (right-aligned on first line)
        if let elapsed = elapsedString(for: agent) {
            let elapsedLabel = makeMonoLabel(elapsed, size: 12, weight: .regular, color: .systemBlue)
            elapsedLabel.sizeToFit()
            elapsedLabel.frame.origin = CGPoint(x: kMenuWidth - kPadding - elapsedLabel.frame.width, y: rowHeight - 22)
            view.addSubview(elapsedLabel)
        } else if let ms = agent.durationMs {
            let durLabel = makeMonoLabel(formatDuration(ms), size: 12, weight: .regular, color: .secondaryLabelColor)
            durLabel.sizeToFit()
            durLabel.frame.origin = CGPoint(x: kMenuWidth - kPadding - durLabel.frame.width, y: rowHeight - 22)
            view.addSubview(durLabel)
        }

        // Token count for completed agents (right-aligned on second line)
        var tokenLabelWidth: CGFloat = 0
        if agent.status != "running", let tokens = agent.totalTokens, tokens > 0 {
            let tokenText = formatTokenCount(tokens)
            let tokenLabel = makeMonoLabel(tokenText, size: 10, weight: .regular, color: .tertiaryLabelColor)
            tokenLabel.sizeToFit()
            tokenLabelWidth = tokenLabel.frame.width + 8  // 8px gap from description
            tokenLabel.frame.origin = CGPoint(x: kMenuWidth - kPadding - tokenLabel.frame.width, y: 7)
            view.addSubview(tokenLabel)
        }

        // Description on second line, truncated to available width
        let maxDescWidth = kMenuWidth - kPadding - textIndent - 4 - tokenLabelWidth
        let descText = truncateToWidth(agent.description, maxWidth: maxDescWidth, font: NSFont.systemFont(ofSize: 12))
        let descLabel = makeSystemLabel(descText, size: 12, weight: .regular, color: .secondaryLabelColor)
        descLabel.frame.origin = CGPoint(x: textIndent, y: 6)
        view.addSubview(descLabel)

        // Subtle separator line
        let border = NSView(frame: NSRect(x: textIndent, y: 0, width: kContentWidth - 22, height: 1))
        border.wantsLayer = true
        border.layer?.backgroundColor = NSColor.separatorColor.cgColor
        view.addSubview(border)

        return view
    }

    // MARK: - Reusable Components

    func makeSectionHeader(_ title: String) -> NSTextField {
        let label = NSTextField(labelWithAttributedString: NSAttributedString(
            string: title,
            attributes: [
                .font: NSFont.systemFont(ofSize: 11, weight: .bold),
                .foregroundColor: NSColor.secondaryLabelColor,
                .kern: 1.2 as NSNumber
            ]
        ))
        label.sizeToFit()
        return label
    }

    /// System font label (not monospaced) -- for all body text and labels.
    func makeSystemLabel(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
        let label = NSTextField(labelWithAttributedString: NSAttributedString(
            string: text,
            attributes: [
                .font: NSFont.systemFont(ofSize: size, weight: weight),
                .foregroundColor: color
            ]
        ))
        label.sizeToFit()
        return label
    }

    /// Monospaced label -- for numeric values only.
    func makeMonoLabel(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
        let label = NSTextField(labelWithAttributedString: NSAttributedString(
            string: text,
            attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: size, weight: weight),
                .foregroundColor: color
            ]
        ))
        label.sizeToFit()
        return label
    }

    // MARK: - Helpers

    func formatTokenCount(_ tokens: Int) -> String {
        if tokens >= 1000 {
            let k = Double(tokens) / 1000.0
            return String(format: "%.1fk tok", k)
        }
        return "\(tokens) tok"
    }

    func formatDuration(_ ms: Int) -> String {
        let s = ms / 1000
        if s == 0 { return "0s" }
        if s < 60 { return "\(s)s" }
        let m = s / 60
        let r = s % 60
        return r > 0 ? "\(m)m \(r)s" : "\(m)m"
    }

    func formatElapsed(_ seconds: Int) -> String {
        if seconds < 0 { return "0s" }
        if seconds < 60 { return "\(seconds)s" }
        let m = seconds / 60
        let r = seconds % 60
        return r > 0 ? "\(m)m \(r)s" : "\(m)m"
    }

    func elapsedString(for agent: AgentInfo) -> String? {
        guard agent.status == "running", !agent.startedAt.isEmpty,
              let start = AppDelegate.iso8601.date(from: agent.startedAt) else { return nil }
        let elapsed = Int(Date().timeIntervalSince(start))
        return formatElapsed(elapsed)
    }

    /// Truncates a string so it fits within maxWidth pixels using the given font.
    func truncateToWidth(_ str: String, maxWidth: CGFloat, font: NSFont) -> String {
        let attrs: [NSAttributedString.Key: Any] = [.font: font]
        let fullWidth = (str as NSString).size(withAttributes: attrs).width
        if fullWidth <= maxWidth { return str }

        // Binary search for the right length
        var lo = 0
        var hi = str.count
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            let candidate = String(str.prefix(mid)) + "…"
            let w = (candidate as NSString).size(withAttributes: attrs).width
            if w <= maxWidth {
                lo = mid
            } else {
                hi = mid - 1
            }
        }
        return lo > 0 ? String(str.prefix(lo)) + "…" : "…"
    }

    func statusDisplay(_ status: String) -> (String, NSColor) {
        switch status {
        case "running":   return ("\u{25CF}", .systemBlue)
        case "completed": return ("\u{25CF}", .systemGreen)
        case "errored":   return ("\u{25CF}", .systemRed)
        default:          return ("\u{25CF}", .secondaryLabelColor)
        }
    }
}

// MARK: - Main

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
