import { createServer } from 'http';
import { json } from 'micro';
import { exec } from 'child_process';
import fs from 'fs';
import { parse } from 'url';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const PORT = process.env.PORT || 3006;
const PM2_LOG_DIR = process.env.HOME ? `${process.env.HOME}/.pm2/logs` : '/root/.pm2/logs';

const logFile = '/var/www/pm2/logs/pm2-service.log';
const MAX_LOG_LINES = 5000;

// Create logs dir if not exist
if (!fs.existsSync('/var/www/pm2/logs')) {
  fs.mkdirSync('/var/www/pm2/logs', { recursive: true });
  fs.writeFileSync(logFile, '');
}

// Rotate logs if they exceed MAX_LOG_LINES
const rotateLogs = () => {
  try {
    if (!fs.existsSync(logFile)) return;
    
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    
    if (lines.length > MAX_LOG_LINES) {
      const keepLines = lines.slice(-MAX_LOG_LINES);
      fs.writeFileSync(logFile, keepLines.join('\n') + '\n');
      console.log(`[${new Date().toISOString()}] Log rotated: kept last ${MAX_LOG_LINES} lines`);
    }
  } catch (error) {
    console.error(`Error rotating logs: ${error.message}`);
  }
};

const log = (msg) => {
  const now = new Date().toISOString();
  const full = `[${now}] ${msg}`;
  console.log(full);
  
  rotateLogs();
  fs.appendFileSync(logFile, full + '\n');
};

const sendJSON = (res, statusCode, data) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
};

// Get all PM2 processes
const getPM2Processes = async () => {
  try {
    const { stdout } = await execAsync('pm2 jlist');
    const processes = JSON.parse(stdout);
    return processes.map(proc => ({
      name: proc.name,
      status: proc.pm2_env?.status || 'unknown',
      uptime: proc.pm2_env?.pm_uptime || 0,
      memory: proc.monit?.memory || 0,
      cpu: proc.monit?.cpu || 0,
      pid: proc.pid,
      restarts: proc.pm2_env?.restart_time || 0,
      mode: proc.pm2_env?.exec_mode || 'unknown'
    }));
  } catch (error) {
    log(`Error getting PM2 processes: ${error.message}`);
    return [];
  }
};

// Get specific PM2 process
const getPM2Process = async (name) => {
  try {
    const { stdout } = await execAsync(`pm2 jlist`);
    const processes = JSON.parse(stdout);
    const process = processes.find(p => p.name === name);
    
    if (!process) {
      return null;
    }
    
    return {
      name: process.name,
      status: process.pm2_env?.status || 'unknown',
      uptime: process.pm2_env?.pm_uptime || 0,
      memory: process.monit?.memory || 0,
      cpu: process.monit?.cpu || 0,
      pid: process.pid,
      restarts: process.pm2_env?.restart_time || 0,
      mode: process.pm2_env?.exec_mode || 'unknown',
      script: process.pm2_env?.pm_exec_path || '',
      error_log: `${PM2_LOG_DIR}/${name}-error.log`,
      out_log: `${PM2_LOG_DIR}/${name}-out.log`
    };
  } catch (error) {
    log(`Error getting PM2 process ${name}: ${error.message}`);
    return null;
  }
};

// Restart PM2 process
const restartPM2Process = async (name) => {
  try {
    // Check if process exists
    const process = await getPM2Process(name);
    if (!process) {
      return { success: false, message: `Process ${name} not found` };
    }
    
    log(`Restarting PM2 process: ${name}`);
    const { stdout, stderr } = await execAsync(`pm2 restart ${name}`);
    
    log(`PM2 restart output for ${name}: ${stdout}`);
    if (stderr) {
      log(`PM2 restart stderr for ${name}: ${stderr}`);
    }
    
    return { success: true, message: `Process ${name} restarted successfully` };
  } catch (error) {
    log(`Error restarting PM2 process ${name}: ${error.message}`);
    return { success: false, message: `Failed to restart ${name}: ${error.message}` };
  }
};

// Stop PM2 process
const stopPM2Process = async (name) => {
  try {
    const process = await getPM2Process(name);
    if (!process) {
      return { success: false, message: `Process ${name} not found` };
    }
    
    log(`Stopping PM2 process: ${name}`);
    const { stdout, stderr } = await execAsync(`pm2 stop ${name}`);
    
    log(`PM2 stop output for ${name}: ${stdout}`);
    if (stderr) {
      log(`PM2 stop stderr for ${name}: ${stderr}`);
    }
    
    return { success: true, message: `Process ${name} stopped successfully` };
  } catch (error) {
    log(`Error stopping PM2 process ${name}: ${error.message}`);
    return { success: false, message: `Failed to stop ${name}: ${error.message}` };
  }
};

// Start PM2 process
const startPM2Process = async (name) => {
  try {
    log(`Starting PM2 process: ${name}`);
    const { stdout, stderr } = await execAsync(`pm2 start ${name}`);
    
    log(`PM2 start output for ${name}: ${stdout}`);
    if (stderr) {
      log(`PM2 start stderr for ${name}: ${stderr}`);
    }
    
    return { success: true, message: `Process ${name} started successfully` };
  } catch (error) {
    log(`Error starting PM2 process ${name}: ${error.message}`);
    return { success: false, message: `Failed to start ${name}: ${error.message}` };
  }
};

// WebSocket connections map
const wsConnections = new Map();

// Stream logs for a PM2 process
const streamLogs = (ws, processName, logType = 'both') => {
  const outLogPath = `${PM2_LOG_DIR}/${processName}-out.log`;
  const errorLogPath = `${PM2_LOG_DIR}/${processName}-error.log`;
  
  let tailProcess = null;
  let watchers = [];
  
  const sendLog = (line, type) => {
    if (ws.readyState === 1) { // WebSocket.OPEN
      try {
        ws.send(JSON.stringify({
          type: 'log',
          process: processName,
          logType: type,
          message: line,
          timestamp: new Date().toISOString()
        }));
      } catch (error) {
        log(`Error sending log to WebSocket: ${error.message}`);
      }
    }
  };
  
  // Read existing logs
  const readExistingLogs = (filePath, type) => {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(line => line.trim());
        // Send last 100 lines
        const recentLines = lines.slice(-100);
        recentLines.forEach(line => sendLog(line, type));
      }
    } catch (error) {
      log(`Error reading existing logs: ${error.message}`);
    }
  };
  
  // Start tailing logs
  const startTailing = () => {
    if (logType === 'both' || logType === 'out') {
      if (fs.existsSync(outLogPath)) {
        readExistingLogs(outLogPath, 'out');
        tailProcess = spawn('tail', ['-f', '-n', '0', outLogPath]);
        
        tailProcess.stdout.on('data', (data) => {
          const lines = data.toString().split('\n').filter(line => line.trim());
          lines.forEach(line => sendLog(line, 'out'));
        });
        
        tailProcess.stderr.on('data', (data) => {
          log(`Tail stderr for ${processName}: ${data.toString()}`);
        });
      }
    }
    
    if (logType === 'both' || logType === 'error') {
      if (fs.existsSync(errorLogPath)) {
        readExistingLogs(errorLogPath, 'error');
        const errorTailProcess = spawn('tail', ['-f', '-n', '0', errorLogPath]);
        
        errorTailProcess.stdout.on('data', (data) => {
          const lines = data.toString().split('\n').filter(line => line.trim());
          lines.forEach(line => sendLog(line, 'error'));
        });
        
        errorTailProcess.stderr.on('data', (data) => {
          log(`Tail stderr for ${processName}: ${data.toString()}`);
        });
      }
    }
  };
  
  startTailing();
  
  // Cleanup function
  const cleanup = () => {
    if (tailProcess) {
      tailProcess.kill();
    }
    watchers.forEach(watcher => {
      if (watcher) {
        fs.unwatchFile(watcher.path);
      }
    });
    watchers = [];
  };
  
  ws.on('close', cleanup);
  ws.on('error', cleanup);
  
  return cleanup;
};

// Create HTTP server
const server = createServer(async (req, res) => {
  // Check if this is a WebSocket upgrade request
  if (req.headers.upgrade === 'websocket') {
    // Let WebSocket server handle it
    return;
  }
  
  const parsedUrl = parse(req.url || '', true);
  const path = parsedUrl.pathname;
  const query = parsedUrl.query || {};
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }
  
  // GET /pm2 - List all services
  if (req.method === 'GET' && path === '/pm2') {
    try {
      const services = await getPM2Processes();
      sendJSON(res, 200, {
        status: 'success',
        message: 'PM2 management service is running',
        services: services,
        endpoints: {
          'GET /pm2': 'List all PM2 services',
          'GET /pm2/[name]': 'Get specific service details',
          'POST /pm2/[name]/restart': 'Restart a service',
          'POST /pm2/[name]/stop': 'Stop a service',
          'POST /pm2/[name]/start': 'Start a service',
          'WebSocket /pm2/[name]': 'Stream logs in real-time'
        }
      });
    } catch (error) {
      log(`Error listing PM2 processes: ${error.message}`);
      sendJSON(res, 500, {
        status: 'error',
        message: 'Failed to list PM2 processes',
        error: error.message
      });
    }
    return;
  }
  
  // GET /pm2/[name] - Get specific service details
  // GET /pm2/[name]/logs - Get logs (both out and error combined)
  if (req.method === 'GET' && path.startsWith('/pm2/')) {
    const pathParts = path.split('/pm2/')[1];
    const parts = pathParts.split('/');
    const serviceName = parts[0];
    const action = parts[1]; // 'logs' or undefined
    
    if (!serviceName) {
      sendJSON(res, 400, {
        status: 'error',
        message: 'Service name is required'
      });
      return;
    }
    
    // GET /pm2/[name]/logs - Get both logs combined
    if (action === 'logs') {
      try {
        const process = await getPM2Process(serviceName);
        if (!process) {
          sendJSON(res, 404, {
            status: 'error',
            message: `Service ${serviceName} not found`
          });
          return;
        }
        
        const outLogPath = process.out_log;
        const errorLogPath = process.error_log;
        
        let outLogs = [];
        let errorLogs = [];
        
        // Read out log
        if (fs.existsSync(outLogPath)) {
          try {
            const outContent = fs.readFileSync(outLogPath, 'utf8');
            outLogs = outContent.split('\n').filter(line => line.trim()).map(line => ({
              type: 'out',
              message: line,
              timestamp: null // PM2 logs don't always have timestamps in the line
            }));
          } catch (error) {
            log(`Error reading out log: ${error.message}`);
          }
        }
        
        // Read error log
        if (fs.existsSync(errorLogPath)) {
          try {
            const errorContent = fs.readFileSync(errorLogPath, 'utf8');
            errorLogs = errorContent.split('\n').filter(line => line.trim()).map(line => ({
              type: 'error',
              message: line,
              timestamp: null
            }));
          } catch (error) {
            log(`Error reading error log: ${error.message}`);
          }
        }
        
        // Combine and sort by line number (approximate - last lines first)
        const allLogs = [...outLogs, ...errorLogs];
        // Reverse to show most recent first
        allLogs.reverse();
        
        sendJSON(res, 200, {
          status: 'success',
          service: serviceName,
          logs: allLogs.slice(0, 1000), // Limit to last 1000 lines
          totalLines: allLogs.length,
          outLogLines: outLogs.length,
          errorLogLines: errorLogs.length
        });
      } catch (error) {
        log(`Error getting logs for ${serviceName}: ${error.message}`);
        sendJSON(res, 500, {
          status: 'error',
          message: 'Failed to get logs',
          error: error.message
        });
      }
      return;
    }
    
    // GET /pm2/[name] - Get service details
    try {
      const process = await getPM2Process(serviceName);
      if (!process) {
        sendJSON(res, 404, {
          status: 'error',
          message: `Service ${serviceName} not found`
        });
        return;
      }
      
      sendJSON(res, 200, {
        status: 'success',
        service: process
      });
    } catch (error) {
      log(`Error getting PM2 process ${serviceName}: ${error.message}`);
      sendJSON(res, 500, {
        status: 'error',
        message: 'Failed to get service details',
        error: error.message
      });
    }
    return;
  }
  
  // POST /pm2/[name]/restart - Restart service
  if (req.method === 'POST' && path.includes('/restart')) {
    const serviceName = path.split('/pm2/')[1]?.split('/restart')[0];
    if (!serviceName) {
      sendJSON(res, 400, {
        status: 'error',
        message: 'Service name is required'
      });
      return;
    }
    
    try {
      const result = await restartPM2Process(serviceName);
      if (result.success) {
        sendJSON(res, 200, {
          status: 'success',
          message: result.message,
          service: serviceName
        });
      } else {
        sendJSON(res, 404, {
          status: 'error',
          message: result.message
        });
      }
    } catch (error) {
      log(`Error restarting PM2 process ${serviceName}: ${error.message}`);
      sendJSON(res, 500, {
        status: 'error',
        message: 'Failed to restart service',
        error: error.message
      });
    }
    return;
  }
  
  // POST /pm2/[name]/stop - Stop service
  if (req.method === 'POST' && path.includes('/stop')) {
    const serviceName = path.split('/pm2/')[1]?.split('/stop')[0];
    if (!serviceName) {
      sendJSON(res, 400, {
        status: 'error',
        message: 'Service name is required'
      });
      return;
    }
    
    try {
      const result = await stopPM2Process(serviceName);
      if (result.success) {
        sendJSON(res, 200, {
          status: 'success',
          message: result.message,
          service: serviceName
        });
      } else {
        sendJSON(res, 404, {
          status: 'error',
          message: result.message
        });
      }
    } catch (error) {
      log(`Error stopping PM2 process ${serviceName}: ${error.message}`);
      sendJSON(res, 500, {
        status: 'error',
        message: 'Failed to stop service',
        error: error.message
      });
    }
    return;
  }
  
  // POST /pm2/[name]/start - Start service
  if (req.method === 'POST' && path.includes('/start')) {
    const serviceName = path.split('/pm2/')[1]?.split('/start')[0];
    if (!serviceName) {
      sendJSON(res, 400, {
        status: 'error',
        message: 'Service name is required'
      });
      return;
    }
    
    try {
      const result = await startPM2Process(serviceName);
      if (result.success) {
        sendJSON(res, 200, {
          status: 'success',
          message: result.message,
          service: serviceName
        });
      } else {
        sendJSON(res, 500, {
          status: 'error',
          message: result.message
        });
      }
    } catch (error) {
      log(`Error starting PM2 process ${serviceName}: ${error.message}`);
      sendJSON(res, 500, {
        status: 'error',
        message: 'Failed to start service',
        error: error.message
      });
    }
    return;
  }
  
  // 404 for unknown routes
  sendJSON(res, 404, {
    status: 'error',
    message: 'Not found',
    availableEndpoints: [
      'GET /pm2',
      'GET /pm2/[name]',
      'POST /pm2/[name]/restart',
      'POST /pm2/[name]/stop',
      'POST /pm2/[name]/start',
      'WebSocket /pm2/[name]'
    ]
  });
});

// Create WebSocket server - handle upgrade requests
const wss = new WebSocketServer({ 
  noServer: true
});

// Handle WebSocket upgrade requests
server.on('upgrade', (request, socket, head) => {
  const pathname = parse(request.url || '', true).pathname;
  
  // Check if this is a PM2 log streaming request
  if (pathname && pathname.startsWith('/pm2/')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const url = parse(req.url || '', true);
  const pathParts = url.pathname?.split('/pm2/')[1];
  const processName = pathParts?.split('?')[0];
  const query = url.query || {};
  const logType = query.type || 'both'; // 'out', 'error', or 'both'
  
  if (!processName) {
    ws.close(1008, 'Process name is required');
    return;
  }
  
  log(`WebSocket connection for PM2 process: ${processName}, logType: ${logType}`);
  
  // Verify process exists
  getPM2Process(processName).then(process => {
    if (!process) {
      ws.send(JSON.stringify({
        type: 'error',
        message: `Process ${processName} not found`
      }));
      ws.close(1008, 'Process not found');
      return;
    }
    
    // Send connection confirmation
    ws.send(JSON.stringify({
      type: 'connected',
      message: `Connected to ${processName} logs`,
      process: processName,
      logType: logType
    }));
    
    // Start streaming logs
    const cleanup = streamLogs(ws, processName, logType);
    wsConnections.set(ws, { processName, cleanup });
    
    // Handle ping/pong
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (error) {
        // Ignore invalid JSON
      }
    });
    
    // Cleanup on close
    ws.on('close', () => {
      log(`WebSocket disconnected for PM2 process: ${processName}`);
      const connection = wsConnections.get(ws);
      if (connection && connection.cleanup) {
        connection.cleanup();
      }
      wsConnections.delete(ws);
    });
    
    ws.on('error', (error) => {
      log(`WebSocket error for ${processName}: ${error.message}`);
      const connection = wsConnections.get(ws);
      if (connection && connection.cleanup) {
        connection.cleanup();
      }
      wsConnections.delete(ws);
    });
  }).catch(error => {
    log(`Error verifying process ${processName}: ${error.message}`);
    ws.send(JSON.stringify({
      type: 'error',
      message: `Error verifying process: ${error.message}`
    }));
    ws.close(1011, 'Internal error');
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  log(`PM2 management service listening on port ${PORT}`);
  log(`Available endpoints:`);
  log(`  GET  /pm2 - List all PM2 services`);
  log(`  GET  /pm2/[name] - Get specific service details`);
  log(`  POST /pm2/[name]/restart - Restart a service`);
  log(`  POST /pm2/[name]/stop - Stop a service`);
  log(`  POST /pm2/[name]/start - Start a service`);
  log(`  WebSocket /pm2/[name] - Stream logs in real-time`);
});

export default server;

