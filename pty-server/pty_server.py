#!/usr/bin/env python3
"""
WebSocket PTY Server for VSCode Terminal Backend

Server-authoritative model: The server is the source of truth for all terminal state.
Clients subscribe to state changes and mirror the server state.
"""

import asyncio
import json
import os
import signal
import sys
import time
from dataclasses import dataclass, field
from typing import Optional
from uuid import uuid4
from pydantic import BaseModel

import ptyprocess
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
import uvicorn

app = FastAPI(title="PTY Server")


# =============================================================================
# Models
# =============================================================================

class CreateSessionRequest(BaseModel):
    shell: str = "/bin/bash"
    cwd: str = "/home/vscode"
    cols: int = 80
    rows: int = 24
    env: Optional[dict] = None
    name: Optional[str] = None  # Display name (auto-generated if not provided)
    client_id: Optional[str] = None  # ID of the client that created this PTY


class UpdateSessionRequest(BaseModel):
    name: Optional[str] = None  # New display name
    index: Optional[int] = None  # New position in order


MAX_SCROLLBACK = 100000  # Max chars to keep in scrollback


@dataclass
class PTYSession:
    """Represents a single PTY session."""
    id: str
    pty: ptyprocess.PtyProcess
    shell: str
    cwd: str
    name: str  # Display name (can be renamed)
    index: int  # Order position (0-based)
    created_at: float  # Unix timestamp
    cols: int = 80
    rows: int = 24
    websockets: list[WebSocket] = field(default_factory=list)
    read_task: Optional[asyncio.Task] = None
    scrollback: str = ""  # Accumulated output for replay


# =============================================================================
# Global State
# =============================================================================

# Session storage (unordered - use get_ordered_sessions() for ordered list)
sessions: dict[str, PTYSession] = {}

# Counter for generating terminal names
terminal_counter: int = 0

# Event subscribers (WebSockets listening for state changes)
event_subscribers: list[WebSocket] = []


def get_next_terminal_name() -> str:
    """Generate the next terminal name."""
    global terminal_counter
    terminal_counter += 1
    return f"cmux {terminal_counter}"


def get_ordered_sessions() -> list[PTYSession]:
    """Get sessions ordered by index."""
    return sorted(sessions.values(), key=lambda s: s.index)


def reindex_sessions():
    """Reindex all sessions to ensure contiguous indices starting from 0."""
    for i, session in enumerate(get_ordered_sessions()):
        session.index = i


def session_to_dict(session: PTYSession) -> dict:
    """Convert a session to a dictionary for JSON serialization."""
    return {
        "id": session.id,
        "name": session.name,
        "index": session.index,
        "shell": session.shell,
        "cwd": session.cwd,
        "cols": session.cols,
        "rows": session.rows,
        "created_at": session.created_at,
        "alive": session.pty.isalive(),
        "pid": session.pty.pid,
    }


def get_full_state() -> dict:
    """Get full state for sync."""
    return {
        "type": "state_sync",
        "terminals": [session_to_dict(s) for s in get_ordered_sessions() if s.pty.isalive()],
    }


# =============================================================================
# Event Broadcasting
# =============================================================================

async def broadcast_event(event: dict):
    """Broadcast an event to all subscribers."""
    message = json.dumps(event)
    dead_sockets = []
    for ws in event_subscribers:
        try:
            await ws.send_text(message)
        except Exception:
            dead_sockets.append(ws)
    for ws in dead_sockets:
        event_subscribers.remove(ws)


async def broadcast_state_sync():
    """Broadcast full state to all subscribers."""
    await broadcast_event(get_full_state())


# =============================================================================
# PTY Output Reader
# =============================================================================

async def read_pty_output(session: PTYSession):
    """Read from PTY and broadcast to all connected WebSockets."""
    loop = asyncio.get_event_loop()
    try:
        while session.pty.isalive():
            try:
                # Read from PTY in executor to avoid blocking
                data_bytes = await loop.run_in_executor(
                    None, lambda: session.pty.read(4096)
                )
                if data_bytes:
                    # Decode bytes to string
                    data = data_bytes.decode('utf-8', errors='replace')
                    # Store in scrollback buffer
                    session.scrollback += data
                    # Trim if too large
                    if len(session.scrollback) > MAX_SCROLLBACK:
                        session.scrollback = session.scrollback[-MAX_SCROLLBACK:]

                    # Broadcast to all connected websockets
                    message = json.dumps({"type": "output", "data": data})
                    dead_sockets = []
                    for ws in session.websockets:
                        try:
                            await ws.send_text(message)
                        except Exception:
                            dead_sockets.append(ws)
                    # Remove dead sockets
                    for ws in dead_sockets:
                        session.websockets.remove(ws)
            except EOFError:
                break
            except Exception as e:
                print(f"Error reading from PTY {session.id}: {e}", file=sys.stderr)
                break
    finally:
        # Notify all clients that the session ended
        message = json.dumps({"type": "exit", "exitCode": session.pty.exitstatus})
        for ws in session.websockets:
            try:
                await ws.send_text(message)
            except Exception:
                pass


# =============================================================================
# HTTP Endpoints
# =============================================================================

@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "sessions": len(sessions)}


@app.get("/sessions")
async def list_sessions():
    """List all active PTY sessions in order."""
    return {
        "sessions": [session_to_dict(s) for s in get_ordered_sessions() if s.pty.isalive()]
    }


@app.post("/sessions")
async def create_session(request: CreateSessionRequest = CreateSessionRequest()):
    """Create a new PTY session."""
    session_id = str(uuid4())

    # Prepare environment
    pty_env = os.environ.copy()
    pty_env["TERM"] = "xterm-256color"
    pty_env["COLORTERM"] = "truecolor"
    if request.env:
        pty_env.update(request.env)

    # Spawn PTY process
    try:
        pty = ptyprocess.PtyProcess.spawn(
            [request.shell],
            cwd=request.cwd,
            env=pty_env,
            dimensions=(request.rows, request.cols),
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Failed to spawn PTY: {e}"}
        )

    # Determine name and index
    name = request.name or get_next_terminal_name()
    index = len(sessions)  # Append to end

    session = PTYSession(
        id=session_id,
        pty=pty,
        shell=request.shell,
        cwd=request.cwd,
        name=name,
        index=index,
        created_at=time.time(),
        cols=request.cols,
        rows=request.rows,
    )
    sessions[session_id] = session

    # Start reading task
    session.read_task = asyncio.create_task(read_pty_output(session))

    # Broadcast pty_created event with full terminal state
    await broadcast_event({
        "type": "pty_created",
        "terminal": session_to_dict(session),
        "creator_client_id": request.client_id,
    })

    return session_to_dict(session)


@app.patch("/sessions/{session_id}")
async def update_session(session_id: str, request: UpdateSessionRequest):
    """Update a PTY session (rename, reorder)."""
    session = sessions.get(session_id)
    if not session:
        return JSONResponse(
            status_code=404,
            content={"error": "Session not found"}
        )

    changes = {}

    # Handle rename
    if request.name is not None and request.name != session.name:
        session.name = request.name
        changes["name"] = request.name

    # Handle reorder
    if request.index is not None and request.index != session.index:
        old_index = session.index
        new_index = max(0, min(request.index, len(sessions) - 1))

        # Shift other sessions
        if new_index < old_index:
            # Moving up: shift others down
            for s in sessions.values():
                if s.id != session_id and new_index <= s.index < old_index:
                    s.index += 1
        else:
            # Moving down: shift others up
            for s in sessions.values():
                if s.id != session_id and old_index < s.index <= new_index:
                    s.index -= 1

        session.index = new_index
        changes["index"] = new_index
        reindex_sessions()  # Ensure contiguous indices

    if changes:
        # Broadcast update event
        await broadcast_event({
            "type": "pty_updated",
            "terminal": session_to_dict(session),
            "changes": changes,
        })

    return session_to_dict(session)


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Terminate and remove a PTY session."""
    session = sessions.get(session_id)
    if not session:
        return JSONResponse(
            status_code=404,
            content={"error": "Session not found"}
        )

    # Cancel read task
    if session.read_task:
        session.read_task.cancel()

    # Terminate the PTY
    if session.pty.isalive():
        session.pty.terminate(force=True)

    # Remove from sessions
    del sessions[session_id]

    # Reindex remaining sessions
    reindex_sessions()

    # Broadcast pty_deleted event
    await broadcast_event({
        "type": "pty_deleted",
        "pty_id": session_id,
    })

    return {"status": "terminated", "id": session_id}


# =============================================================================
# WebSocket Endpoints
# =============================================================================

@app.websocket("/ws")
async def websocket_events(websocket: WebSocket):
    """WebSocket endpoint for subscribing to PTY events."""
    await websocket.accept()
    event_subscribers.append(websocket)
    print(f"Event subscriber connected, total: {len(event_subscribers)}")

    # Send full state on connect
    await websocket.send_text(json.dumps(get_full_state()))

    try:
        while True:
            message = await websocket.receive_text()
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "get_state":
                # Request full state sync
                await websocket.send_text(json.dumps(get_full_state()))

            elif msg_type == "create_pty":
                # Create a new PTY session
                shell = data.get("shell", "/bin/bash")
                cwd = data.get("cwd", "/home/vscode")
                cols = data.get("cols", 80)
                rows = data.get("rows", 24)
                name = data.get("name")  # Optional custom name
                client_id = data.get("client_id")

                session_id = str(uuid4())
                pty_env = os.environ.copy()
                pty_env["TERM"] = "xterm-256color"
                pty_env["COLORTERM"] = "truecolor"

                try:
                    pty = ptyprocess.PtyProcess.spawn(
                        [shell], cwd=cwd, env=pty_env, dimensions=(rows, cols)
                    )

                    terminal_name = name or get_next_terminal_name()
                    index = len(sessions)

                    session = PTYSession(
                        id=session_id,
                        pty=pty,
                        shell=shell,
                        cwd=cwd,
                        name=terminal_name,
                        index=index,
                        created_at=time.time(),
                        cols=cols,
                        rows=rows,
                    )
                    sessions[session_id] = session
                    session.read_task = asyncio.create_task(read_pty_output(session))

                    # Broadcast to ALL subscribers
                    await broadcast_event({
                        "type": "pty_created",
                        "terminal": session_to_dict(session),
                        "creator_client_id": client_id,
                    })
                except Exception as e:
                    await websocket.send_text(json.dumps({"type": "error", "error": str(e)}))

            elif msg_type == "rename_pty":
                # Rename a PTY
                pty_id = data.get("pty_id")
                new_name = data.get("name")

                if pty_id and new_name:
                    session = sessions.get(pty_id)
                    if session:
                        session.name = new_name
                        await broadcast_event({
                            "type": "pty_updated",
                            "terminal": session_to_dict(session),
                            "changes": {"name": new_name},
                        })

            elif msg_type == "reorder_pty":
                # Reorder a PTY
                pty_id = data.get("pty_id")
                new_index = data.get("index")

                if pty_id and new_index is not None:
                    session = sessions.get(pty_id)
                    if session:
                        old_index = session.index
                        new_index = max(0, min(new_index, len(sessions) - 1))

                        if new_index != old_index:
                            # Shift other sessions
                            if new_index < old_index:
                                for s in sessions.values():
                                    if s.id != pty_id and new_index <= s.index < old_index:
                                        s.index += 1
                            else:
                                for s in sessions.values():
                                    if s.id != pty_id and old_index < s.index <= new_index:
                                        s.index -= 1

                            session.index = new_index
                            reindex_sessions()

                            # Broadcast full state since multiple terminals changed
                            await broadcast_state_sync()

            elif msg_type == "delete_pty":
                # Delete a PTY
                pty_id = data.get("pty_id")
                if pty_id:
                    session = sessions.get(pty_id)
                    if session:
                        if session.read_task:
                            session.read_task.cancel()
                        if session.pty.isalive():
                            session.pty.terminate(force=True)
                        del sessions[pty_id]
                        reindex_sessions()

                        await broadcast_event({
                            "type": "pty_deleted",
                            "pty_id": pty_id,
                        })

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"Event WebSocket error: {e}", file=sys.stderr)
    finally:
        if websocket in event_subscribers:
            event_subscribers.remove(websocket)
        print(f"Event subscriber disconnected, total: {len(event_subscribers)}")


@app.websocket("/sessions/{session_id}/ws")
async def websocket_terminal(websocket: WebSocket, session_id: str):
    """WebSocket endpoint for terminal I/O."""
    session = sessions.get(session_id)
    if not session:
        await websocket.close(code=4004, reason="Session not found")
        return

    await websocket.accept()
    session.websockets.append(websocket)

    # Send scrollback history on connect
    if session.scrollback:
        await websocket.send_text(json.dumps({"type": "output", "data": session.scrollback}))

    try:
        while True:
            message = await websocket.receive_text()
            data = json.loads(message)

            msg_type = data.get("type")

            if msg_type == "input":
                # Write input to PTY (encode string to bytes)
                if session.pty.isalive():
                    input_data = data.get("data", "")
                    session.pty.write(input_data.encode('utf-8'))

            elif msg_type == "resize":
                # Resize the PTY
                cols = data.get("cols", session.cols)
                rows = data.get("rows", session.rows)
                session.cols = cols
                session.rows = rows
                if session.pty.isalive():
                    session.pty.setwinsize(rows, cols)

            elif msg_type == "signal":
                # Send signal to PTY
                sig = data.get("signal", "SIGINT")
                if session.pty.isalive():
                    sig_num = getattr(signal, sig, signal.SIGINT)
                    session.pty.kill(sig_num)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"WebSocket error for session {session_id}: {e}", file=sys.stderr)
    finally:
        if websocket in session.websockets:
            session.websockets.remove(websocket)


def main():
    """Run the PTY server."""
    host = os.environ.get("PTY_SERVER_HOST", "0.0.0.0")
    port = int(os.environ.get("PTY_SERVER_PORT", "9999"))

    print(f"Starting PTY server on {host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
