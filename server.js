// server.js - MCP Only Version (Claude API removed)
import "dotenv/config";
import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname } from "path";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(",") || [
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ],
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));

// Static files (Dashboard serve etmek için)
app.use(
  express.static(".", {
    index: ["index.html"],
  })
);

// MCP Client state
let mcpProcess = null;
let mcpInitialized = false;
let mcpError = null;
let availableTools = [];

// Initialize MCP Process
async function initializeMcpProcess() {
  try {
    console.log("🔄 Starting CoinGecko MCP server process...");

    const isWindows = process.platform === "win32";
    const command = isWindows ? "npx.cmd" : "npx";

    const args = [
      "-y",
      "@coingecko/coingecko-mcp@latest",
      "--client=claude",
      "--tools=dynamic",
    ];

    const mcpEnv = {
      ...process.env,
      COINGECKO_DEMO_API_KEY: process.env.COINGECKO_DEMO_API_KEY,
      COINGECKO_ENVIRONMENT: process.env.COINGECKO_ENVIRONMENT,
      PATH: process.env.PATH,
      NODE_PATH: process.env.NODE_PATH,
    };

    console.log("🔧 MCP Server Config:");
    console.log(`   Command: ${command}`);
    console.log(`   Args: ${args.join(" ")}`);
    console.log(`   Environment: ${mcpEnv.COINGECKO_ENVIRONMENT}`);

    mcpProcess = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: mcpEnv,
      shell: isWindows,
      cwd: process.cwd(),
    });

    mcpProcess.on("error", (error) => {
      console.error("❌ MCP Process spawn error:", error.message);

      if (error.code === "ENOENT") {
        console.log("\n💡 Çözüm Önerileri:");
        console.log("1. Node.js kurulu mu: node --version");
        console.log("2. npm kurulu mu: npm --version");
        console.log("3. npx kurulu mu: npx --version");
        console.log(
          "4. Manuel test: npx -y @coingecko/coingecko-mcp@latest --help"
        );

        mcpError = "npx command not found. Please install Node.js properly.";
      } else {
        mcpError = `Process error: ${error.message}`;
      }
      mcpInitialized = false;
    });

    let dataBuffer = "";
    let initTimeout;

    mcpProcess.stdout.on("data", (data) => {
      const output = data.toString();
      console.log("MCP stdout:", output.trim());

      dataBuffer += output;
      const lines = dataBuffer.split("\n");
      dataBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            handleMcpMessage(message);

            if (initTimeout) {
              clearTimeout(initTimeout);
              initTimeout = null;
            }
          } catch (e) {
            if (line.includes("error") || line.includes("Error")) {
              console.error("MCP Error Output:", line);
            } else {
              console.log("MCP Non-JSON Output:", line);
            }
          }
        }
      }
    });

    mcpProcess.stderr.on("data", (data) => {
      const errorOutput = data.toString();
      console.error("MCP stderr:", errorOutput.trim());

      if (
        errorOutput.includes("ENOENT") ||
        errorOutput.includes("command not found")
      ) {
        mcpError = "Command execution failed. Check Node.js installation.";
        mcpInitialized = false;
      }
    });

    mcpProcess.on("close", (code) => {
      console.log(`MCP process exited with code ${code}`);
      if (code !== 0) {
        console.error(`❌ MCP process failed with exit code ${code}`);
        mcpError = `Process exited with code ${code}`;
      }
      mcpInitialized = false;
    });

    initTimeout = setTimeout(() => {
      console.log(
        "⏱️  MCP process başlatma timeout'u, initialization mesajı gönderiliyor..."
      );
      sendInitializationMessage();
    }, 5000);

    await new Promise((resolve) => setTimeout(resolve, 3000));

    console.log("✅ MCP process spawn başarılı, initialization bekleniyor...");
    return true;
  } catch (error) {
    console.error("❌ Failed to start MCP process:", error.message);
    mcpError = error.message;
    mcpInitialized = false;
    return false;
  }
}

// Handle MCP messages
function handleMcpMessage(message) {
  if (message.result && message.id === 1) {
    console.log("✅ MCP initialized:", message.result);
    mcpInitialized = true;
    requestAvailableTools();
  } else if (message.result && message.id === 2) {
    if (message.result.tools) {
      availableTools = message.result.tools;
      console.log(
        `🔧 Loaded ${availableTools.length} tools:`,
        availableTools.map((t) => t.name).join(", ")
      );
    }
  }
}

// Send message to MCP process
function sendMcpMessage(message) {
  if (mcpProcess && mcpProcess.stdin.writable) {
    mcpProcess.stdin.write(JSON.stringify(message) + "\n");
  }
}

// Request available tools
function requestAvailableTools() {
  sendMcpMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
}

// Send initialization message
function sendInitializationMessage() {
  try {
    console.log("📤 Sending initialization message...");

    sendMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        clientInfo: {
          name: "crypto-chatbot",
          version: "1.0.0",
        },
      },
    });

    setTimeout(() => {
      console.log("📤 Requesting available tools...");
      requestAvailableTools();
    }, 2000);
  } catch (error) {
    console.error("❌ Failed to send initialization:", error.message);
  }
}

// Call MCP tool (Dashboard'dan API çağrıları için)
async function callMcpTool(toolName, args) {
  return new Promise((resolve, reject) => {
    const requestId = Date.now();

    const timeout = setTimeout(() => {
      reject(new Error("MCP tool call timeout"));
    }, 15000);

    let dataBuffer = "";
    const dataHandler = (data) => {
      dataBuffer += data.toString();
      const lines = dataBuffer.split("\n");
      dataBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            if (message.id === requestId) {
              clearTimeout(timeout);
              mcpProcess.stdout.removeListener("data", dataHandler);

              if (message.error) {
                reject(new Error(message.error.message || "MCP tool error"));
              } else {
                resolve(message.result);
              }
              return;
            }
          } catch (e) {
            // Ignore parse errors for non-JSON output
          }
        }
      }
    };

    mcpProcess.stdout.on("data", dataHandler);

    sendMcpMessage({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    });
  });
}

// Health check endpoint
app.get("/api/chat/health", async (req, res) => {
  const status = {
    status: "ok",
    timestamp: new Date().toISOString(),
    server: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: process.version,
    },
    services: {
      mcp: {
        initialized: mcpInitialized,
        status: mcpInitialized ? "connected" : "disconnected",
        error: mcpError,
        processRunning: mcpProcess && !mcpProcess.killed,
        availableTools: availableTools.length,
        tools: availableTools.map((t) => t.name),
      },
    },
  };

  res.json(status);
});

// MCP Direct API endpoint (Dashboard'dan direkt MCP çağrıları için)
app.post("/api/mcp/call", async (req, res) => {
  try {
    const { toolName, args } = req.body;

    if (!toolName) {
      return res.status(400).json({ error: "toolName is required" });
    }

    if (!mcpInitialized) {
      return res.status(503).json({
        error: "MCP server not initialized",
        details: mcpError || "MCP server is not ready",
      });
    }

    console.log(`🔧 MCP Tool Call: ${toolName}`, args);

    const result = await callMcpTool(toolName, args || {});

    console.log(`✅ MCP Tool Result received`);

    res.json({
      success: true,
      result: result,
      metadata: {
        toolName,
        timestamp: new Date().toISOString(),
        mcpAvailable: mcpInitialized,
      },
    });
  } catch (error) {
    console.error("❌ MCP call error:", error);
    res.status(500).json({
      error: "MCP tool call failed",
      details: error.message,
      toolName: req.body.toolName,
    });
  }
});

// Retry MCP connection
app.post("/api/admin/retry-mcp", async (req, res) => {
  console.log("🔄 Manual MCP reconnection requested...");

  if (mcpProcess) {
    mcpProcess.kill();
    mcpProcess = null;
  }

  mcpError = null;
  availableTools = [];
  mcpInitialized = false;

  const success = await initializeMcpProcess();
  res.json({
    success,
    status: mcpInitialized ? "connected" : "failed",
    error: mcpError,
    availableTools: availableTools.length,
  });
});

// Root endpoint - Dashboard'a yönlendir
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Error handling
app.use((error, req, res, next) => {
  console.error("🚨 Unhandled error:", error);
  res.status(500).json({
    error: "Internal server error",
    message: error.message,
  });
});

// Start server
async function startServer() {
  console.log("🚀 Starting CoinGecko MCP Dashboard Backend...");
  console.log(`📍 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log("🎯 Mode: MCP Only (No Claude API)");

  // Initialize MCP process
  initializeMcpProcess().then((success) => {
    if (success) {
      console.log("🎉 MCP process started successfully!");
    } else {
      console.log("⚠️  MCP process failed, retrying in 10 seconds...");
      setTimeout(initializeMcpProcess, 10000);
    }
  });

  // Start Express server
  const server = app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`🎨 Dashboard: http://localhost:${PORT}/`);
    console.log(`📡 MCP API: http://localhost:${PORT}/api/mcp/call`);
    console.log(`❤️  Health check: http://localhost:${PORT}/api/chat/health`);
    console.log("\n🎯 Ready to serve MCP queries!");
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`❌ Port ${PORT} is already in use.`);
      process.exit(1);
    } else {
      console.error("❌ Server error:", error);
    }
  });
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down gracefully...");

  if (mcpProcess) {
    mcpProcess.kill();
    console.log("✅ MCP process terminated");
  }

  process.exit(0);
});

// Start the application
startServer().catch(console.error);
