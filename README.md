# mcp-serial

MCP Serial Terminal Server — persistent serial port communication with Web real-time monitor.

Part of the [MoterSoc](https://github.com/yuanchilin/MoterSoc) RISC-V SoC project. Used for communicating with the FPGA board's UART (instruction loading, debug output, interactive shell, etc.).

## Features

- **Persistent serial connection** — open once, keep buffering data in a ring buffer
- **Web real-time monitor** — live terminal at `http://localhost:9721` (configurable via `WEB_PORT`)
- **Incremental reads** — Agent (Cline/Claude) can read only new data since last read via `serial_read`
- **Command send with response** — `serial_send` sends a command, waits for response with configurable timeout
- **Auto-connect** — if `SERIAL_AUTO_CONNECT=true`, opens serial port on server startup
- **Port scanning** — `list_ports` enumerates available serial ports

## Installation

```bash
npm install
npm run build
```

## MCP Configuration

For **Cline** (VS Code): add to `cline_mcp_settings.json` or VS Code settings `cline.mcpServers`:

```json
{
  "mcpServers": {
    "mcp-serial": {
      "command": "node",
      "args": ["path/to/mcp-serial/build/index.js"],
      "env": {
        "SERIAL_PORT": "COM3",
        "SERIAL_BAUDRATE": "115200",
        "SERIAL_AUTO_CONNECT": "true",
        "WEB_PORT": "9721"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

For **Claude Desktop**: add to `claude_desktop_config.json`.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SERIAL_PORT` | `COM3` | Serial port name |
| `SERIAL_BAUDRATE` | `115200` | Baud rate |
| `SERIAL_AUTO_CONNECT` | `false` | Auto-connect on startup |
| `WEB_PORT` | `9721` | Web monitor port |

## Available MCP Tools

| Tool | Description |
|---|---|
| `list_ports` | List all available serial ports |
| `serial_start` | Open a serial port and start persistent buffering |
| `serial_stop` | Close the serial port |
| `serial_status` | Query connection status and statistics |
| `serial_read` | Read new data from ring buffer (incremental) |
| `serial_send` | Send command and wait for response |
| `serial_clear_buffer` | Clear the ring buffer |

## Usage with Cline (AI Agent)

Once configured, Cline can use these tools to interact with your FPGA's UART:

1. `serial_start` — open the serial port
2. `serial_send` — send commands to the SoC (e.g., monitor memory, check registers)
3. `serial_read` — read device output incrementally
4. `serial_stop` — close when done

The Web monitor at `http://localhost:9721` shows all traffic in real time.

## License

MIT