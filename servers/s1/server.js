// server.js
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3001;
const SERVER_NAME = `Server-${PORT}`;

// Increase server capacity and timeouts
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Middleware for logging requests
app.use((req, res, next) => {
  console.log(`[${SERVER_NAME}] ${req.method} ${req.url}`);
  next();
});

// Health check endpoint (prioritize this - put it before other routes)
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    port: PORT,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Root endpoint
app.get("/", (req, res) => {
  // Only add delay for regular requests, not health checks
  const randomDelay = Math.random() * 500;
  setTimeout(() => {
    res.send(`📦 Response from ${SERVER_NAME}`);
  }, randomDelay); // Reduced from 2 seconds to 1 second
});

// Simulate random failure (optional, for testing)
app.get("/simulate-failure", (req, res) => {
  const fail = Math.random() < 0.3;
  if (fail) {
    res.status(500).send("💥 Simulated failure");
  } else {
    res.send("✅ No failure this time");
  }
});

app.listen(PORT, () => {
  console.log(`${SERVER_NAME} running on http://localhost:${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
});
