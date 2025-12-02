# PM2 Management Service

A Node.js service that provides HTTP API and WebSocket endpoints for managing PM2 processes and streaming logs in real-time.

## Overview

This service allows you to:
- List all PM2 processes and their status
- Get detailed information about specific processes
- Restart, stop, and start PM2 processes
- Stream logs in real-time via WebSocket
- View combined logs (stdout + stderr) via HTTP

## Features

- ✅ **HTTP REST API** - Manage PM2 processes via REST endpoints
- ✅ **WebSocket Log Streaming** - Real-time log streaming for any PM2 process
- ✅ **CORS Support** - Accessible from any origin
- ✅ **Process Management** - Restart, stop, and start services
- ✅ **Combined Logs** - View both stdout and stderr logs together
- ✅ **Auto-log Rotation** - Logs are automatically rotated to prevent disk space issues

## Installation

### Prerequisites

- Node.js 18+ 
- PM2 installed globally
- pnpm (or npm/yarn)

### Setup

1. **Install dependencies:**
```bash
cd /var/www/pm2
pnpm install
```

2. **Start the service with PM2:**
```bash
pm2 start index.js --name pm2-service
pm2 save
```

3. **Configure Nginx** (if using reverse proxy):
```nginx
# PM2 management API
location /pm2 {
    proxy_pass http://localhost:3006;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300;
    proxy_send_timeout 300;
}

# PM2 WebSocket for log streaming
location /pm2/ {
    proxy_pass http://localhost:3006/pm2/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
}
```

## Configuration

The service runs on port **3006** by default. You can change this by setting the `PORT` environment variable:

```bash
PORT=3007 pm2 start index.js --name pm2-service
```

## API Endpoints

**Base URL**: `https://tajma.net/pm2` (or `http://localhost:3006`)

### 1. GET `/pm2` - List All Services

Returns a list of all PM2 processes with their status.

**Response:**
```json
{
  "status": "success",
  "message": "PM2 management service is running",
  "services": [
    {
      "name": "tajma",
      "status": "online",
      "uptime": 1764361499273,
      "memory": 112254976,
      "cpu": 0.3,
      "pid": 1145295,
      "restarts": 1083,
      "mode": "fork_mode"
    }
  ],
  "endpoints": { ... }
}
```

### 2. GET `/pm2/[name]` - Get Service Details

Get detailed information about a specific PM2 process.

**Example:** `GET /pm2/tajma`

**Response:**
```json
{
  "status": "success",
  "service": {
    "name": "tajma",
    "status": "online",
    "uptime": 1764361499273,
    "memory": 112254976,
    "cpu": 0.4,
    "pid": 1145295,
    "restarts": 1083,
    "mode": "fork_mode",
    "script": "/home/user/.nvm/versions/node/v22.20.0/bin/pnpm",
    "error_log": "/home/user/.pm2/logs/tajma-error.log",
    "out_log": "/home/user/.pm2/logs/tajma-out.log"
  }
}
```

### 3. GET `/pm2/[name]/logs` - Get Combined Logs

Get both stdout and stderr logs combined (last 1000 lines).

**Example:** `GET /pm2/tajma/logs`

**Response:**
```json
{
  "status": "success",
  "service": "tajma",
  "logs": [
    {
      "type": "out",
      "message": "Server started on port 3000",
      "timestamp": null
    },
    {
      "type": "error",
      "message": "Error: Connection timeout",
      "timestamp": null
    }
  ],
  "totalLines": 8951,
  "outLogLines": 7688,
  "errorLogLines": 1263
}
```

### 4. POST `/pm2/[name]/restart` - Restart Service

Restart a specific PM2 process.

**Example:** `POST /pm2/tajma/restart`

**Response:**
```json
{
  "status": "success",
  "message": "Process tajma restarted successfully",
  "service": "tajma"
}
```

### 5. POST `/pm2/[name]/stop` - Stop Service

Stop a specific PM2 process.

**Example:** `POST /pm2/tajma/stop`

**Response:**
```json
{
  "status": "success",
  "message": "Process tajma stopped successfully",
  "service": "tajma"
}
```

### 6. POST `/pm2/[name]/start` - Start Service

Start a specific PM2 process.

**Example:** `POST /pm2/tajma/start`

**Response:**
```json
{
  "status": "success",
  "message": "Process tajma started successfully",
  "service": "tajma"
}
```

## WebSocket API

### Connection

Connect to the WebSocket endpoint to stream logs in real-time:

```
wss://tajma.net/pm2/[service_name]?type=[logType]
```

**Parameters:**
- `service_name` (required): Name of the PM2 process
- `type` (optional): `'both'` (default), `'out'`, or `'error'`
  - `both`: Stream both stdout and stderr
  - `out`: Stream only stdout
  - `error`: Stream only stderr

**Examples:**
- `wss://tajma.net/pm2/tajma` - Stream both logs (default)
- `wss://tajma.net/pm2/tajma?type=both` - Explicit both
- `wss://tajma.net/pm2/tajma?type=out` - Only stdout
- `wss://tajma.net/pm2/tajma?type=error` - Only stderr

### Messages Received

#### Connection Confirmation
```json
{
  "type": "connected",
  "message": "Connected to tajma logs",
  "process": "tajma",
  "logType": "both"
}
```

#### Log Messages
```json
{
  "type": "log",
  "process": "tajma",
  "logType": "out",
  "message": "Server started on port 3000",
  "timestamp": "2025-12-02T01:00:00.000Z"
}
```

#### Error Messages
```json
{
  "type": "error",
  "message": "Process tajma not found"
}
```

#### Pong Response
```json
{
  "type": "pong"
}
```

### Messages to Send

#### Ping (Keep Connection Alive)
```json
{
  "type": "ping"
}
```

### JavaScript Example

```javascript
const ws = new WebSocket('wss://tajma.net/pm2/tajma?type=both');

ws.on('open', () => {
  console.log('Connected to PM2 logs');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  
  if (msg.type === 'log') {
    if (msg.logType === 'error') {
      console.error(`[ERROR] ${msg.message}`);
    } else {
      console.log(`[OUT] ${msg.message}`);
    }
  }
});

// Send ping every 30 seconds to keep connection alive
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 30000);
```

### React/Next.js Example

```typescript
import { useEffect, useRef } from 'react';

function usePM2Logs(serviceName: string, logType: 'both' | 'out' | 'error' = 'both') {
  const wsRef = useRef<WebSocket | null>(null);
  
  useEffect(() => {
    const ws = new WebSocket(`wss://tajma.net/pm2/${serviceName}?type=${logType}`);
    wsRef.current = ws;
    
    ws.onopen = () => {
      console.log(`Connected to ${serviceName} logs`);
    };
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'log') {
        // Handle log message
        console.log(`[${data.logType.toUpperCase()}] ${data.message}`);
      }
    };
    
    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
    
    ws.onclose = () => {
      console.log('WebSocket closed');
    };
    
    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [serviceName, logType]);
  
  return wsRef.current;
}
```

## Usage Examples

### List All Services

```bash
curl https://tajma.net/pm2
```

### Get Service Details

```bash
curl https://tajma.net/pm2/tajma
```

### Get Combined Logs

```bash
curl https://tajma.net/pm2/tajma/logs
```

### Restart a Service

```bash
curl -X POST https://tajma.net/pm2/tajma/restart
```

### Stop a Service

```bash
curl -X POST https://tajma.net/pm2/tajma/stop
```

### Start a Service

```bash
curl -X POST https://tajma.net/pm2/tajma/start
```

## Logs

The service logs are stored in `/var/www/pm2/logs/pm2-service.log`. Logs are automatically rotated when they exceed 5000 lines.

## Error Handling

All endpoints return JSON responses with a `status` field:
- `"success"` - Operation completed successfully
- `"error"` - An error occurred

Error responses include an `error` or `message` field with details.

## CORS

The service supports CORS and allows requests from any origin. All responses include:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type`

## Security Considerations

⚠️ **Warning**: This service provides full control over PM2 processes. Consider:

1. **Authentication**: Add authentication/authorization if exposing publicly
2. **Rate Limiting**: Implement rate limiting to prevent abuse
3. **IP Whitelisting**: Restrict access to trusted IPs in production
4. **HTTPS Only**: Always use HTTPS in production
5. **Input Validation**: Service names are validated, but additional checks may be needed

## Troubleshooting

### WebSocket Connection Fails

1. Check if the service is running: `pm2 list | grep pm2-service`
2. Check service logs: `pm2 logs pm2-service`
3. Verify nginx configuration includes WebSocket upgrade headers
4. Test direct connection: `ws://localhost:3006/pm2/[name]`

### Service Not Responding

1. Check PM2 status: `pm2 status`
2. Check service logs: `pm2 logs pm2-service`
3. Verify port 3006 is not in use: `lsof -i :3006`
4. Restart the service: `pm2 restart pm2-service`

### Logs Not Streaming

1. Verify the PM2 process exists: `pm2 list`
2. Check log file paths: `GET /pm2/[name]` shows log paths
3. Verify log files exist: Check `~/.pm2/logs/` directory
4. Check WebSocket connection in browser console

## License

ISC

## Author

PM2 Management Service

