/**
 * Floating debug overlay built with Shadow DOM for style isolation.
 */
import { overlayStyles } from "./styles.js";

export interface OverlayOptions {
  position?: { x: number; y: number };
}

export class DebugOverlay {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private icon: HTMLDivElement;
  private panel: HTMLDivElement;
  private statusDot: HTMLSpanElement;
  private logContainer: HTMLDivElement;
  private infoBody: HTMLDivElement;
  private isOpen = false;
  private isDragging = false;
  private dragOffset = { x: 0, y: 0 };
  private maxLogEntries = 50;

  constructor(options?: OverlayOptions) {
    // Create host container
    this.host = document.createElement("div");
    this.host.id = "hypha-debugger-host";
    Object.assign(this.host.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "2147483647",
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-end",
    });

    if (options?.position) {
      this.host.style.bottom = "auto";
      this.host.style.right = "auto";
      this.host.style.left = options.position.x + "px";
      this.host.style.top = options.position.y + "px";
    }

    // Attach shadow DOM
    this.shadow = this.host.attachShadow({ mode: "open" });

    // Inject styles
    const style = document.createElement("style");
    style.textContent = overlayStyles;
    this.shadow.appendChild(style);

    // Build UI
    const wrapper = document.createElement("div");
    wrapper.style.position = "relative";
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.alignItems = "flex-end";

    // Panel (hidden by default)
    this.panel = document.createElement("div");
    this.panel.className = "debugger-panel";

    const header = document.createElement("div");
    header.className = "panel-header";
    const titleSpan = document.createElement("span");
    titleSpan.className = "title";
    this.statusDot = document.createElement("span");
    this.statusDot.className = "status-dot";
    titleSpan.appendChild(this.statusDot);
    titleSpan.appendChild(document.createTextNode(" Hypha Debugger"));
    const closeBtn = document.createElement("span");
    closeBtn.className = "close-btn";
    closeBtn.textContent = "\u00d7";
    closeBtn.addEventListener("click", () => this.toggle());
    header.appendChild(titleSpan);
    header.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "panel-body";

    this.infoBody = document.createElement("div");
    body.appendChild(this.infoBody);

    const logSection = document.createElement("div");
    logSection.className = "log-section";
    const logTitle = document.createElement("div");
    logTitle.className = "log-title";
    logTitle.textContent = "Remote Operations";
    this.logContainer = document.createElement("div");
    logSection.appendChild(logTitle);
    logSection.appendChild(this.logContainer);
    body.appendChild(logSection);

    this.panel.appendChild(header);
    this.panel.appendChild(body);

    // Floating icon
    this.icon = document.createElement("div");
    this.icon.className = "debugger-icon";
    this.icon.textContent = "\u{1f41b}";
    this.icon.addEventListener("click", (e) => {
      if (!this.isDragging) this.toggle();
    });

    wrapper.appendChild(this.panel);
    wrapper.appendChild(this.icon);
    this.shadow.appendChild(wrapper);

    // Mount to page
    document.documentElement.appendChild(this.host);

    // Dragging
    this.setupDrag();
  }

  private setupDrag(): void {
    let startX = 0;
    let startY = 0;
    let moved = false;

    this.icon.addEventListener("mousedown", (e: MouseEvent) => {
      startX = e.clientX;
      startY = e.clientY;
      moved = false;
      const rect = this.host.getBoundingClientRect();
      this.dragOffset.x = e.clientX - rect.left;
      this.dragOffset.y = e.clientY - rect.top;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e: MouseEvent) => {
      if (startX === 0 && startY === 0) return;
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      if (dx > 3 || dy > 3) {
        moved = true;
        this.isDragging = true;
        this.host.style.left = e.clientX - this.dragOffset.x + "px";
        this.host.style.top = e.clientY - this.dragOffset.y + "px";
        this.host.style.right = "auto";
        this.host.style.bottom = "auto";
      }
    });

    document.addEventListener("mouseup", () => {
      startX = 0;
      startY = 0;
      if (moved) {
        // Delay clearing isDragging so click handler doesn't fire
        setTimeout(() => {
          this.isDragging = false;
        }, 50);
      }
    });
  }

  toggle(): void {
    this.isOpen = !this.isOpen;
    this.panel.classList.toggle("open", this.isOpen);
  }

  setStatus(status: "connected" | "disconnected" | "error"): void {
    this.statusDot.className = "status-dot";
    this.icon.className = "debugger-icon";
    if (status === "connected") {
      this.statusDot.classList.add("connected");
      this.icon.classList.add("connected");
    } else if (status === "error") {
      this.statusDot.classList.add("error");
      this.icon.classList.add("error");
    }
  }

  setInfo(info: Record<string, string>): void {
    this.infoBody.innerHTML = "";
    for (const [label, value] of Object.entries(info)) {
      const row = document.createElement("div");
      row.className = "info-row";
      const labelSpan = document.createElement("span");
      labelSpan.className = "label";
      labelSpan.textContent = label;
      const valueSpan = document.createElement("span");
      valueSpan.className = "value";
      valueSpan.textContent = value;
      valueSpan.title = value;
      row.appendChild(labelSpan);
      row.appendChild(valueSpan);
      this.infoBody.appendChild(row);
    }
  }

  /** Show the service URL with a copy button. */
  setServiceUrl(url: string, token: string): void {
    const section = document.createElement("div");
    section.className = "url-section";

    const urlLabel = document.createElement("div");
    urlLabel.className = "url-label";
    urlLabel.textContent = "Service URL";
    section.appendChild(urlLabel);

    const urlRow = document.createElement("div");
    urlRow.className = "url-row";
    const urlText = document.createElement("span");
    urlText.className = "url-text";
    urlText.textContent = url;
    urlText.title = url;
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(url).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
      });
    });
    urlRow.appendChild(urlText);
    urlRow.appendChild(copyBtn);
    section.appendChild(urlRow);

    const tokenLabel = document.createElement("div");
    tokenLabel.className = "url-label";
    tokenLabel.textContent = "Token";
    tokenLabel.style.marginTop = "6px";
    section.appendChild(tokenLabel);

    const tokenRow = document.createElement("div");
    tokenRow.className = "url-row";
    const tokenText = document.createElement("span");
    tokenText.className = "url-text";
    tokenText.textContent = token.slice(0, 20) + "...";
    tokenText.title = token;
    const copyTokenBtn = document.createElement("button");
    copyTokenBtn.className = "copy-btn";
    copyTokenBtn.textContent = "Copy";
    copyTokenBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(token).then(() => {
        copyTokenBtn.textContent = "Copied!";
        setTimeout(() => { copyTokenBtn.textContent = "Copy"; }, 1500);
      });
    });
    tokenRow.appendChild(tokenText);
    tokenRow.appendChild(copyTokenBtn);
    section.appendChild(tokenRow);

    this.infoBody.appendChild(section);
  }

  addLog(
    message: string,
    type: "call" | "result" | "error" = "call"
  ): void {
    const entry = document.createElement("div");
    entry.className = `log-entry ${type}`;
    entry.textContent = message;
    this.logContainer.appendChild(entry);

    // Trim old entries
    while (this.logContainer.children.length > this.maxLogEntries) {
      this.logContainer.removeChild(this.logContainer.firstChild!);
    }

    // Auto-scroll
    const body = this.panel.querySelector(".panel-body");
    if (body) body.scrollTop = body.scrollHeight;
  }

  destroy(): void {
    this.host.remove();
  }
}
