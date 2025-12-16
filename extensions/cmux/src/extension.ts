import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

// =============================================================================
// Types
// =============================================================================

// Unique client ID for this VSCode instance
const CLIENT_ID = randomUUID();

interface TerminalInfo {
  id: string;
  name: string;
  index: number;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  created_at: number;
  alive: boolean;
  pid: number;
}

interface PTYMessage {
  type: 'output' | 'exit' | 'error';
  data?: string;
  exitCode?: number;
}

interface StateSyncEvent {
  type: 'state_sync';
  terminals: TerminalInfo[];
}

interface PTYCreatedEvent {
  type: 'pty_created';
  terminal: TerminalInfo;
  creator_client_id?: string;
}

interface PTYUpdatedEvent {
  type: 'pty_updated';
  terminal: TerminalInfo;
  changes: { name?: string; index?: number };
}

interface PTYDeletedEvent {
  type: 'pty_deleted';
  pty_id: string;
}

type PTYEvent = StateSyncEvent | PTYCreatedEvent | PTYUpdatedEvent | PTYDeletedEvent;

function getConfig() {
  const config = vscode.workspace.getConfiguration('cmux');
  return {
    serverUrl: config.get<string>('ptyServerUrl', 'http://localhost:9998'),
    defaultShell: config.get<string>('defaultShell', '/bin/bash'),
  };
}

// =============================================================================
// CmuxPseudoterminal - Connects to a single PTY session
// =============================================================================

class CmuxPseudoterminal implements vscode.Pseudoterminal {
  private readonly _onDidWrite = new vscode.EventEmitter<string>();
  private readonly _onDidClose = new vscode.EventEmitter<number | void>();

  private _ws: WebSocket | null = null;
  private _isDisposed = false;
  private _initialDataSent = false;
  private _outputBuffer = '';
  private _dimensions: { cols: number; rows: number } = { cols: 80, rows: 24 };
  private _previousDimensions: { cols: number; rows: number } | null = null;

  public readonly onDidWrite: vscode.Event<string> = this._onDidWrite.event;
  public readonly onDidClose: vscode.Event<number | void> = this._onDidClose.event;

  constructor(
    private readonly serverUrl: string,
    public readonly ptyId: string
  ) {
    console.log(`[cmux] CmuxPseudoterminal constructor for PTY ${ptyId}`);
    this._connectWebSocket();
  }

  private _connectWebSocket(): void {
    if (this._isDisposed) return;

    const wsUrl = this.serverUrl.replace(/^http/, 'ws');
    const fullUrl = `${wsUrl}/sessions/${this.ptyId}/ws`;
    console.log(`[cmux] CmuxPseudoterminal connecting to: ${fullUrl}`);
    this._ws = new WebSocket(fullUrl);

    this._ws.onopen = () => {
      console.log(`[cmux] WebSocket connected for PTY ${this.ptyId}`);
      this._ws?.send(JSON.stringify({
        type: 'resize',
        cols: this._dimensions.cols,
        rows: this._dimensions.rows,
      }));
    };

    this._ws.onmessage = (event) => {
      if (this._isDisposed) return;

      try {
        const msg: PTYMessage = JSON.parse(event.data);

        if (msg.type === 'output' && msg.data) {
          if (!this._initialDataSent) {
            this._outputBuffer += msg.data;
          } else {
            this._onDidWrite.fire(msg.data);
          }
        } else if (msg.type === 'exit') {
          this._onDidClose.fire(msg.exitCode ?? 0);
          this.dispose();
        }
      } catch (e) {
        console.error('[cmux] Failed to parse PTY message:', e);
      }
    };

    this._ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      if (!this._initialDataSent) {
        this._outputBuffer += '\r\nWebSocket connection error\r\n';
      } else {
        this._onDidWrite.fire('\r\nWebSocket connection error\r\n');
      }
    };

    this._ws.onclose = () => {
      if (!this._isDisposed) {
        this._onDidClose.fire();
      }
    };
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    console.log(`[cmux] PTY ${this.ptyId} open() called, buffer size: ${this._outputBuffer.length}`);

    // Flush buffered output
    if (this._outputBuffer.length > 0) {
      this._onDidWrite.fire(this._outputBuffer);
      this._outputBuffer = '';
    }
    this._initialDataSent = true;

    if (initialDimensions) {
      this._dimensions = { cols: initialDimensions.columns, rows: initialDimensions.rows };
      this._previousDimensions = { ...this._dimensions };
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({
          type: 'resize',
          cols: initialDimensions.columns,
          rows: initialDimensions.rows,
        }));
      }
    }
  }

  close(): void {
    // Notify server to delete the PTY session
    this._deletePtySession();
    this.dispose();
  }

  private async _deletePtySession(): Promise<void> {
    try {
      const config = getConfig();
      await fetch(`${config.serverUrl}/sessions/${this.ptyId}`, {
        method: 'DELETE',
      });
      console.log(`[cmux] Deleted PTY session ${this.ptyId}`);
    } catch (err) {
      console.error(`[cmux] Failed to delete PTY session ${this.ptyId}:`, err);
    }
  }

  handleInput(data: string): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN && !this._isDisposed) {
      this._ws.send(JSON.stringify({ type: 'input', data }));
    }
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    const newDimensions = { cols: dimensions.columns, rows: dimensions.rows };

    // Check if we're shrinking - need to clear outside content
    if (this._previousDimensions && this._initialDataSent) {
      const shrinkingCols = newDimensions.cols < this._previousDimensions.cols;
      const shrinkingRows = newDimensions.rows < this._previousDimensions.rows;

      if (shrinkingCols || shrinkingRows) {
        // Send ANSI sequence to clear screen and reset cursor
        // This prevents artifacts when terminal shrinks
        // ESC[2J = clear entire screen, ESC[H = move cursor to home
        this._onDidWrite.fire('\x1b[2J\x1b[H');
      }
    }

    this._previousDimensions = { ...this._dimensions };
    this._dimensions = newDimensions;

    if (this._ws && this._ws.readyState === WebSocket.OPEN && !this._isDisposed) {
      this._ws.send(JSON.stringify({
        type: 'resize',
        cols: dimensions.columns,
        rows: dimensions.rows,
      }));
    }
  }

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;

    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }

    this._onDidWrite.dispose();
    this._onDidClose.dispose();
  }
}

// =============================================================================
// PtyClient - WebSocket connection for events
// =============================================================================

class PtyClient {
  private _ws: WebSocket | null = null;
  private _eventHandlers = new Map<string, ((data: any) => void)[]>();
  private _connected = false;
  private _reconnectAttempts = 0;
  private _maxReconnectAttempts = 10;
  private _reconnectDelay = 1000;

  constructor(private readonly serverUrl: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.serverUrl.replace(/^http/, 'ws');
      const fullUrl = `${wsUrl}/ws`;
      console.log('[cmux] PtyClient connecting to:', fullUrl);
      this._ws = new WebSocket(fullUrl);

      const timeout = setTimeout(() => {
        if (!this._connected) {
          console.error('[cmux] PtyClient connection timeout');
          reject(new Error('Connection timeout'));
        }
      }, 5000);

      this._ws.onopen = () => {
        clearTimeout(timeout);
        this._connected = true;
        this._reconnectAttempts = 0;
        console.log('[cmux] PtyClient connected to event WebSocket');
        this._triggerEvent('connected', {});
        resolve();
      };

      this._ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          console.log('[cmux] PtyClient received message:', message.type, message);
          this._triggerEvent(message.type, message);
        } catch (err) {
          console.error('[cmux] Failed to parse message:', err);
        }
      };

      this._ws.onclose = () => {
        this._connected = false;
        console.log('PtyClient disconnected');
        this._triggerEvent('disconnected', {});
        this._tryReconnect();
      };

      this._ws.onerror = (err) => {
        clearTimeout(timeout);
        console.error('PtyClient WebSocket error:', err);
        if (!this._connected) {
          reject(err);
        }
      };
    });
  }

  private _tryReconnect(): void {
    if (this._reconnectAttempts < this._maxReconnectAttempts) {
      this._reconnectAttempts++;
      const delay = this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1);
      console.log(`Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);
      setTimeout(() => this.connect().catch(() => {}), delay);
    }
  }

  on(event: string, handler: (data: any) => void): { dispose: () => void } {
    if (!this._eventHandlers.has(event)) {
      this._eventHandlers.set(event, []);
    }
    this._eventHandlers.get(event)!.push(handler);
    return {
      dispose: () => this.off(event, handler)
    };
  }

  off(event: string, handler: (data: any) => void): void {
    const handlers = this._eventHandlers.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    }
  }

  private _triggerEvent(event: string, data: any): void {
    const handlers = this._eventHandlers.get(event) || [];
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        console.error(`Error in event handler for ${event}:`, err);
      }
    }
  }

  requestState(): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'get_state' }));
    }
  }

  createPty(shell?: string, cwd?: string, name?: string): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      console.error('Cannot create PTY: not connected');
      return;
    }
    this._ws.send(JSON.stringify({
      type: 'create_pty',
      shell: shell || '/bin/bash',
      cwd: cwd || '/home/vscode',
      name,
      client_id: CLIENT_ID,
    }));
  }

  renamePty(ptyId: string, name: string): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      console.error('Cannot rename PTY: not connected');
      return;
    }
    this._ws.send(JSON.stringify({
      type: 'rename_pty',
      pty_id: ptyId,
      name,
    }));
  }

  dispose(): void {
    this._eventHandlers.clear();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }
}

// =============================================================================
// CmuxTerminalManager - Manages all terminals
// =============================================================================

interface ManagedTerminal {
  terminal: vscode.Terminal;
  pty: CmuxPseudoterminal;
  info: TerminalInfo;
}

class CmuxTerminalManager {
  // Map from ptyId to managed terminal
  private _terminals = new Map<string, ManagedTerminal>();

  // Set of ptyIds we're currently creating (to prevent duplicates)
  private _pendingCreations = new Set<string>();

  private _ptyClient: PtyClient;
  private _disposables: { dispose: () => void }[] = [];
  private _initialized = false;

  constructor() {
    const config = getConfig();
    this._ptyClient = new PtyClient(config.serverUrl);
  }

  async initialize(): Promise<void> {
    const config = getConfig();
    console.log('[cmux] CmuxTerminalManager initializing with config:', config);

    // Register handlers BEFORE connecting so we don't miss the initial state_sync
    this._registerEventHandlers();

    try {
      console.log('[cmux] Connecting to PTY server...');
      await this._ptyClient.connect();
      console.log('[cmux] Connected to PTY server');
    } catch (err) {
      console.error('[cmux] Failed to connect to PTY server:', err);
      this._retryConnect();
      return;
    }

    this._initialized = true;
  }

  private _registerEventHandlers(): void {
    // Handle full state sync (received on connect and on request)
    this._disposables.push(
      this._ptyClient.on('state_sync', (data: StateSyncEvent) => {
        console.log('[cmux] state_sync received:', data.terminals.length, 'terminals');
        this._handleStateSync(data.terminals);
      })
    );

    // Handle new terminal created
    this._disposables.push(
      this._ptyClient.on('pty_created', (data: PTYCreatedEvent) => {
        console.log('[cmux] pty_created received:', data.terminal.id, data.terminal.name);
        this._handlePtyCreated(data.terminal, data.creator_client_id);
      })
    );

    // Handle terminal updated (rename, reorder)
    this._disposables.push(
      this._ptyClient.on('pty_updated', (data: PTYUpdatedEvent) => {
        console.log('[cmux] pty_updated received:', data.terminal.id, data.changes);
        this._handlePtyUpdated(data.terminal, data.changes);
      })
    );

    // Handle terminal deleted
    this._disposables.push(
      this._ptyClient.on('pty_deleted', (data: PTYDeletedEvent) => {
        console.log('[cmux] pty_deleted received:', data.pty_id);
        this._handlePtyDeleted(data.pty_id);
      })
    );

    // Handle reconnection
    this._disposables.push(
      this._ptyClient.on('connected', () => {
        if (this._initialized) {
          console.log('[cmux] Reconnected, requesting state sync');
          this._ptyClient.requestState();
        }
      })
    );
  }

  private async _retryConnect(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        await this._ptyClient.connect();
        // Handlers already registered in initialize(), just mark as initialized
        this._initialized = true;
        return;
      } catch {
        console.log(`Retry ${i + 1} failed`);
      }
    }
  }

  private _handleStateSync(terminals: TerminalInfo[]): void {
    // Sort by index to ensure correct order
    const sorted = [...terminals].sort((a, b) => a.index - b.index);

    // Track which terminals we've seen
    const seenIds = new Set<string>();

    for (const info of sorted) {
      seenIds.add(info.id);

      // Skip if we already have this terminal
      if (this._terminals.has(info.id) || this._pendingCreations.has(info.id)) {
        // Update info if terminal exists
        const managed = this._terminals.get(info.id);
        if (managed) {
          managed.info = info;
        }
        continue;
      }

      // Create terminal for this PTY
      this._createTerminalForPty(info, false); // Don't focus on sync
    }

    // Remove terminals that no longer exist on server
    for (const [ptyId, managed] of this._terminals) {
      if (!seenIds.has(ptyId)) {
        console.log(`[cmux] Removing stale terminal ${ptyId}`);
        managed.terminal.dispose();
        this._terminals.delete(ptyId);
      }
    }
  }

  private _handlePtyCreated(info: TerminalInfo, creatorClientId?: string): void {
    // Skip if we already have this terminal or are creating it
    if (this._terminals.has(info.id) || this._pendingCreations.has(info.id)) {
      console.log(`[cmux] Terminal for PTY ${info.id} already exists or pending, skipping`);
      // Update info if terminal exists
      const managed = this._terminals.get(info.id);
      if (managed) {
        managed.info = info;
      }
      return;
    }

    // Always focus new terminals
    this._createTerminalForPty(info, true);
  }

  private async _handlePtyUpdated(info: TerminalInfo, changes: { name?: string; index?: number }): Promise<void> {
    const managed = this._terminals.get(info.id);
    if (!managed) return;

    // Update stored info
    managed.info = info;

    // Try to rename using VSCode's internal command
    if (changes.name) {
      console.log(`[cmux] Terminal ${info.id} renamed to "${info.name}", attempting VSCode rename`);

      // The rename command works on the active terminal, so we need to:
      // 1. Remember current active terminal
      // 2. Make our terminal active
      // 3. Run rename command
      // 4. Restore previous active terminal
      const previousActive = vscode.window.activeTerminal;
      const isOurTerminalActive = previousActive === managed.terminal;

      try {
        // Make our terminal active (but don't steal focus from editor)
        if (!isOurTerminalActive) {
          managed.terminal.show(false); // preserveFocus = false to make it active
          // Small delay to ensure terminal is active
          await new Promise(r => setTimeout(r, 50));
        }

        // Execute rename command
        await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: info.name });
        console.log(`[cmux] VSCode rename command executed for "${info.name}"`);

        // Restore previous active terminal if different
        if (!isOurTerminalActive && previousActive) {
          previousActive.show(false);
        }
      } catch (err) {
        console.log(`[cmux] VSCode rename command failed:`, err);
      }
    }

    // VSCode doesn't allow reordering tabs programmatically
    if (changes.index !== undefined) {
      console.log(`[cmux] Terminal ${info.id} reordered to index ${info.index} (VSCode tab unchanged)`);
    }
  }

  private _handlePtyDeleted(ptyId: string): void {
    const managed = this._terminals.get(ptyId);
    if (managed) {
      console.log(`[cmux] Disposing terminal for deleted PTY ${ptyId}`);
      managed.terminal.dispose();
    }
    this._terminals.delete(ptyId);
    this._pendingCreations.delete(ptyId);
  }

  private _createTerminalForPty(info: TerminalInfo, shouldFocus: boolean): void {
    const config = getConfig();

    console.log(`[cmux] Creating terminal for PTY ${info.id} (${info.name}), focus: ${shouldFocus}`);

    const pty = new CmuxPseudoterminal(config.serverUrl, info.id);

    const terminal = vscode.window.createTerminal({
      name: info.name,
      pty,
    });

    const managed: ManagedTerminal = { terminal, pty, info };
    this._terminals.set(info.id, managed);

    // Show terminal with appropriate focus
    terminal.show(!shouldFocus); // preserveFocus = true means don't steal focus

    // Listen for terminal close
    const closeListener = vscode.window.onDidCloseTerminal((closedTerminal) => {
      if (closedTerminal === terminal) {
        console.log(`[cmux] Terminal for PTY ${info.id} closed`);
        this._terminals.delete(info.id);
        closeListener.dispose();
        pty.dispose();
      }
    });
    this._disposables.push(closeListener);
  }

  /**
   * Create a PTY via HTTP and return a Pseudoterminal for it.
   * Used by TerminalProfileProvider for synchronous terminal creation.
   */
  async createPtyAndGetTerminal(): Promise<{ pty: vscode.Pseudoterminal; name: string } | null> {
    const config = getConfig();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '/home/vscode';

    try {
      // Create PTY via HTTP POST with our client ID
      const response = await fetch(`${config.serverUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shell: config.defaultShell,
          cwd: cwd,
          client_id: CLIENT_ID,
        }),
      });

      if (!response.ok) {
        console.error('[cmux] Failed to create PTY:', response.statusText);
        return null;
      }

      const data = await response.json() as TerminalInfo;
      console.log('[cmux] Created PTY via HTTP:', data.id, data.name);

      // Mark as pending to prevent duplicate from pty_created event
      this._pendingCreations.add(data.id);

      // Create pseudoterminal for this PTY
      const pty = new CmuxPseudoterminal(config.serverUrl, data.id);

      // Store a placeholder - will be replaced when pty_created event arrives
      // or when the terminal is actually created by VSCode
      setTimeout(() => {
        // Clean up pending after a short delay
        this._pendingCreations.delete(data.id);
      }, 1000);

      return { pty, name: data.name };
    } catch (err) {
      console.error('[cmux] Error creating PTY:', err);
      return null;
    }
  }

  createTerminal(): void {
    const config = getConfig();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '/home/vscode';
    this._ptyClient.createPty(config.defaultShell, cwd);
  }

  renamePty(ptyId: string, name: string): void {
    this._ptyClient.renamePty(ptyId, name);
  }

  getTerminals(): ManagedTerminal[] {
    return Array.from(this._terminals.values())
      .sort((a, b) => a.info.index - b.info.index);
  }

  dispose(): void {
    for (const d of this._disposables) {
      d.dispose();
    }
    this._ptyClient.dispose();
  }
}

// =============================================================================
// Terminal Profile Provider
// =============================================================================

let terminalManager: CmuxTerminalManager;

class CmuxTerminalProfileProvider implements vscode.TerminalProfileProvider {
  async provideTerminalProfile(
    _token: vscode.CancellationToken
  ): Promise<vscode.TerminalProfile | undefined> {
    console.log('[cmux] provideTerminalProfile called');

    const result = await terminalManager.createPtyAndGetTerminal();
    if (!result) {
      console.error('[cmux] Failed to create PTY for profile');
      return undefined;
    }

    return new vscode.TerminalProfile({
      name: result.name,
      pty: result.pty,
    });
  }
}

// =============================================================================
// Extension Activation
// =============================================================================

export function activate(context: vscode.ExtensionContext) {
  console.log('[cmux] Extension activating...');
  console.log('[cmux] Client ID:', CLIENT_ID);
  console.log('[cmux] Config:', JSON.stringify(getConfig()));

  terminalManager = new CmuxTerminalManager();

  // Initialize (connect to server, sync state)
  terminalManager.initialize().then(() => {
    console.log('[cmux] Initialization complete');
  }).catch((err) => {
    console.error('[cmux] Initialization failed:', err);
  });

  // Register terminal profile provider
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider('cmux.terminal', new CmuxTerminalProfileProvider())
  );

  // Focus all cmux terminals when they open (ensures both creator and other windows focus)
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((terminal) => {
      if (terminal.name.startsWith('cmux')) {
        console.log(`[cmux] onDidOpenTerminal: focusing ${terminal.name}`);
        terminal.show(false); // false = take focus
      }
    })
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('cmux.newTerminal', () => {
      terminalManager.createTerminal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cmux.listSessions', async () => {
      const terminals = terminalManager.getTerminals();
      if (terminals.length === 0) {
        vscode.window.showInformationMessage('No active PTY sessions');
        return;
      }

      const items = terminals.map(t => ({
        label: t.info.name,
        description: `Shell: ${t.info.shell}`,
        detail: `CWD: ${t.info.cwd} | Index: ${t.info.index}`,
        terminal: t,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a session',
      });

      if (selected) {
        selected.terminal.terminal.show();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cmux.renameTerminal', async () => {
      const terminals = terminalManager.getTerminals();
      if (terminals.length === 0) {
        vscode.window.showInformationMessage('No active PTY sessions');
        return;
      }

      const items = terminals.map(t => ({
        label: t.info.name,
        description: `PTY ID: ${t.info.id.slice(0, 8)}`,
        terminal: t,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select terminal to rename',
      });

      if (selected) {
        const newName = await vscode.window.showInputBox({
          prompt: 'Enter new name',
          value: selected.terminal.info.name,
        });

        if (newName && newName !== selected.terminal.info.name) {
          terminalManager.renamePty(selected.terminal.info.id, newName);
          vscode.window.showInformationMessage(
            `Renamed to "${newName}" (note: VSCode tab name cannot be updated after creation)`
          );
        }
      }
    })
  );

  context.subscriptions.push({
    dispose: () => terminalManager.dispose()
  });

  console.log('cmux extension activated');
}

export function deactivate() {
  console.log('cmux extension deactivated');
}
