// server.js
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3003;
const SERVER_NAME = `Server-${PORT}`;

// Middleware for logging requests
app.use((req, res, next) => {
  console.log(`[${SERVER_NAME}] ${req.method} ${req.url}`);
  next();
});

// Root endpoint
app.get("/", (req, res) => {
  const randomDelay = Math.random() * 500;
  setTimeout(() => {
    res.send(`📦 Response from ${SERVER_NAME}`);
  }, randomDelay);
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    port: PORT,
    timestamp: new Date().toISOString(),
  });
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
});
