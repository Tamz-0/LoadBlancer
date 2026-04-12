const express = require("express");
const cors = require("cors");
const url = require("url");
const http = require("http");
const https = require("https");
// const fetch = require("node-fetch");
const { MinPriorityQueue } = require("@datastructures-js/priority-queue");
const cluster = require("cluster");
const os = require("os");
const winston = require("winston");
const promClient = require("prom-client");

// ---------------------- Configuration ----------------------
const config = {
  port: process.env.PORT || 8000,
  workers: process.env.WORKERS || 1, // Single worker to avoid connection conflicts
  healthCheckInterval: process.env.HEALTH_CHECK_INTERVAL || 10000, // Check every 10 seconds instead of 5
  requestTimeout: process.env.REQUEST_TIMEOUT || 30000,
  retryAttempts: process.env.RETRY_ATTEMPTS || 3,
  retryDelay: process.env.RETRY_DELAY || 1000,
  logLevel: process.env.LOG_LEVEL || "info",
  gracefulShutdownTimeout: process.env.GRACEFUL_SHUTDOWN_TIMEOUT || 30000,
  rateLimitWindow: process.env.RATE_LIMIT_WINDOW || 60000,
  rateLimitMax: process.env.RATE_LIMIT_MAX || 100,
  servers: process.env.SERVERS
    ? JSON.parse(process.env.SERVERS)
    : [
        { url: "http://localhost:3001", weight: 1, maxConnections: 100 },
        { url: "http://localhost:3002", weight: 1, maxConnections: 100 },
      ],
};

// ---------------------- Logger Setup ----------------------
const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});

// ---------------------- Metrics Setup ----------------------
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const requestDuration = new promClient.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code", "target_server"],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

const requestCount = new promClient.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code", "target_server"],
});

const activeConnections = new promClient.Gauge({
  name: "active_connections",
  help: "Number of active connections per server",
  labelNames: ["server"],
});

const serverHealth = new promClient.Gauge({
  name: "server_health",
  help: "Health status of backend servers (1 = healthy, 0 = unhealthy)",
  labelNames: ["server"],
});

register.registerMetric(requestDuration);
register.registerMetric(requestCount);
register.registerMetric(activeConnections);
register.registerMetric(serverHealth);

// ---------------------- Server Class ----------------------
class BackendServer {
  constructor(config) {
    this.url = config.url;
    this.weight = config.weight || 1;
    this.maxConnections = config.maxConnections || 100;
    this.connections = 0;
    this.active = true;
    this.totalRequests = 0;
    this.totalResponseTime = 0;
    this.failureCount = 0;
    this.lastHealthCheck = Date.now();
    this.healthHistory = [];
    this.circuitBreakerState = "closed"; // closed, open, half-open
    this.circuitBreakerFailures = 0;
    this.circuitBreakerLastFailure = 0;

    // New fields for better load balancing
    this.recentResponseTimes = []; // Track recent response times
    this.lastRequestTime = 0;
    this.requestCount = 0;
    this.warmupPeriod = 30000; // 30 seconds warmup period
    this.startTime = Date.now();
  }

  get avgResponseTime() {
    // Use recent response times for better accuracy
    if (this.recentResponseTimes.length > 0) {
      const sum = this.recentResponseTimes.reduce((a, b) => a + b, 0);
      return sum / this.recentResponseTimes.length;
    }
    return this.totalRequests > 0
      ? this.totalResponseTime / this.totalRequests
      : 100; // Default reasonable response time
  }

  get load() {
    return this.connections / this.maxConnections;
  }

  get priority() {
    // Improved priority calculation that prevents server starvation
    const now = Date.now();
    const timeSinceStart = now - this.startTime;
    const timeSinceLastRequest = now - this.lastRequestTime;

    // During warmup period, give all servers equal chance
    if (timeSinceStart < this.warmupPeriod) {
      return Math.random() * 100; // Random priority during warmup
    }

    // Base priority on current load (primary factor)
    let priority = this.connections * 10;

    // Add response time factor but limit its impact
    const responseTimeFactor = Math.min(this.avgResponseTime / 1000, 5); // Cap at 5 seconds impact
    priority += responseTimeFactor;

    // Boost priority for servers that haven't received requests recently
    if (timeSinceLastRequest > 10000) {
      // 10 seconds
      priority -= 20; // Boost servers that haven't been used
    }

    // Weight factor
    priority = priority / this.weight;

    // Add small random factor to prevent ties and ensure distribution
    priority += Math.random() * 2;

    return priority;
  }

  incrementConnections() {
    this.connections++;
    this.lastRequestTime = Date.now();
    this.requestCount++;
    activeConnections.set({ server: this.url }, this.connections);
  }

  decrementConnections() {
    this.connections = Math.max(0, this.connections - 1);
    activeConnections.set({ server: this.url }, this.connections);
  }

  updateMetrics(responseTime, success) {
    this.totalRequests++;
    this.totalResponseTime += responseTime;

    // Track recent response times (keep last 10)
    this.recentResponseTimes.push(responseTime);
    if (this.recentResponseTimes.length > 10) {
      this.recentResponseTimes.shift();
    }

    if (!success) {
      this.failureCount++;
      this.circuitBreakerFailures++;
      this.circuitBreakerLastFailure = Date.now();

      if (this.circuitBreakerFailures >= 5) {
        this.circuitBreakerState = "open";
        logger.warn(`Circuit breaker opened for ${this.url}`);
      }
    } else {
      this.circuitBreakerFailures = Math.max(
        0,
        this.circuitBreakerFailures - 1
      );
      if (this.circuitBreakerState === "half-open") {
        this.circuitBreakerState = "closed";
        logger.info(`Circuit breaker closed for ${this.url}`);
      }
    }
  }

  canAcceptRequest() {
    if (this.circuitBreakerState === "open") {
      // Try to transition to half-open after 60 seconds
      if (Date.now() - this.circuitBreakerLastFailure > 60000) {
        this.circuitBreakerState = "half-open";
        logger.info(`Circuit breaker half-open for ${this.url}`);
      } else {
        return false;
      }
    }

    return this.active && this.connections < this.maxConnections;
  }
}

// ---------------------- Advanced Rate Limiter ----------------------
class SlidingWindowRateLimiter {
  constructor(windowSize = 60000, maxRequests = 100) {
    this.windowSize = windowSize;
    this.maxRequests = maxRequests;
    this.windows = new Map();
  }

  isAllowed(identifier) {
    // return true; // Disable rate limiting for now
    const now = Date.now();
    const windowStart = now - this.windowSize;

    if (!this.windows.has(identifier)) {
      this.windows.set(identifier, []);
    }

    const requests = this.windows.get(identifier);

    // Remove old requests
    while (requests.length > 0 && requests[0] < windowStart) {
      requests.shift();
    }

    if (requests.length >= this.maxRequests) {
      return false;
    }

    requests.push(now);
    return true;
  }

  cleanup() {
    const now = Date.now();
    const windowStart = now - this.windowSize;

    for (const [identifier, requests] of this.windows.entries()) {
      while (requests.length > 0 && requests[0] < windowStart) {
        requests.shift();
      }

      if (requests.length === 0) {
        this.windows.delete(identifier);
      }
    }
  }
}

function customFetch(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = url.parse(targetUrl);
    const protocol = parsedUrl.protocol === "https:" ? https : http;
    const timeout = options.timeout || 30000;

    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.path,
      method: options.method || "GET",
      headers: options.headers || {},
      timeout: timeout,
    };

    const req = protocol.request(requestOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
          text: () => Promise.resolve(data),
          json: () => Promise.resolve(JSON.parse(data)),
        });
      });
    });

    req.on("error", reject);

    // Set timeout
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

// ---------------------- Load Balancer Class ----------------------
class LoadBalancer {
  constructor() {
    this.servers = config.servers.map(
      (serverConfig) => new BackendServer(serverConfig)
    );
    this.queue = new MinPriorityQueue((server) => server.priority);
    this.rateLimiter = new SlidingWindowRateLimiter(
      config.rateLimitWindow,
      config.rateLimitMax
    );
    this.isShuttingDown = false;
    this.roundRobinIndex = 0; // For fallback round-robin
    this.lastQueueRebuild = Date.now();

    this.rebuildQueue();
    this.startHealthChecks();
    this.startCleanupTasks();
  }

  rebuildQueue() {
    this.queue = new MinPriorityQueue((server) => server.priority);
    const healthyServers = this.servers.filter(server => server.canAcceptRequest());
    
    // Ensure all healthy servers are added to queue
    healthyServers.forEach((server) => {
      this.queue.enqueue(server);
    });
    
    this.lastQueueRebuild = Date.now();
    
    logger.debug(`Queue rebuilt with ${healthyServers.length} healthy servers`);
  }

  async selectServer() {
    // Rebuild queue periodically or if empty
    const timeSinceRebuild = Date.now() - this.lastQueueRebuild;
    if (this.queue.isEmpty() || timeSinceRebuild > 5000) { // Rebuild every 5 seconds
      this.rebuildQueue();
    }

    if (this.queue.isEmpty()) {
      throw new Error("No healthy servers available");
    }

    // Use weighted round-robin approach for better distribution
    const healthyServers = this.servers.filter(server => server.canAcceptRequest());
    
    if (healthyServers.length === 0) {
      throw new Error("No healthy servers available");
    }

    // For the first 30 seconds, use round-robin to ensure all servers get requests
    const allServersWarmedUp = this.servers.every(server => 
      Date.now() - server.startTime > server.warmupPeriod
    );

    if (!allServersWarmedUp) {
      // Use round-robin during warmup
      const server = healthyServers[this.roundRobinIndex % healthyServers.length];
      this.roundRobinIndex++;
      logger.info(`Warmup: selecting server ${server.url} (round-robin)`);
      return server;
    }

    // After warmup, use priority-based selection but ensure minimum request distribution
    const selectedServer = this.queue.dequeue();
    
    // Check if any server is being starved (hasn't received requests in last 30 seconds)
    const starvedServers = healthyServers.filter(server => 
      Date.now() - server.lastRequestTime > 30000 && server.requestCount > 0
    );
    
    if (starvedServers.length > 0) {
      // Give priority to starved servers occasionally (20% chance)
      if (Math.random() < 0.2) {
        const starvedServer = starvedServers[Math.floor(Math.random() * starvedServers.length)];
        logger.info(`Anti-starvation: giving priority to server ${starvedServer.url}`);
        return starvedServer;
      }
    }
    
    return selectedServer;
  }

  async forwardRequest(req, res) {
    const clientIp = req.ip || req.connection.remoteAddress;
    const startTime = Date.now();

    // Rate limiting
    if (!this.rateLimiter.isAllowed(clientIp)) {
      requestCount.inc({
        method: req.method,
        route: req.originalUrl,
        status_code: "429",
        target_server: "none",
      });
      return res.status(429).json({ error: "Rate limit exceeded" });
    }

    let server = null;
    let attempts = 0;
    const maxAttempts = Math.min(config.retryAttempts, this.servers.length);

    while (attempts < maxAttempts && !server) {
      try {
        server = await this.selectServer();
        if (server) {
          server.incrementConnections();
          break;
        }
      } catch (error) {
        logger.error("Failed to select server", {
          error: error.message,
          attempt: attempts + 1,
        });
      }
      attempts++;

      if (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, config.retryDelay));
      }
    }

    if (!server) {
      requestCount.inc({
        method: req.method,
        route: req.originalUrl,
        status_code: "503",
        target_server: "none",
      });
      return res.status(503).json({ error: "No healthy servers available" });
    }

    try {
      const targetUrl = `${server.url}${req.originalUrl}`;
      const requestOptions = {
        method: req.method,
        headers: { ...req.headers, "x-forwarded-for": clientIp },
        timeout: config.requestTimeout,
      };

      if (req.method !== "GET" && req.method !== "HEAD") {
        requestOptions.body = JSON.stringify(req.body);
        requestOptions.headers["content-type"] = "application/json";
      }

      const response = await customFetch(targetUrl, requestOptions);
      const body = await response.text();
      const duration = Date.now() - startTime;

      // Update metrics
      server.updateMetrics(duration, response.ok);

      const labels = {
        method: req.method,
        route: req.originalUrl,
        status_code: response.status.toString(),
        target_server: server.url,
      };

      requestDuration.observe(labels, duration / 1000);
      requestCount.inc(labels);

      // Forward response
      res.status(response.status);
      Object.entries(response.headers).forEach(([key, value]) => {
        if (key.toLowerCase() !== "content-encoding") {
          res.setHeader(key, value);
        }
      });
      res.send(body);

      logger.info("Request forwarded", {
        method: req.method,
        url: req.originalUrl,
        target: server.url,
        status: response.status,
        duration: `${duration}ms`,
        clientIp,
        serverLoad: `${Math.round(server.load * 100)}%`,
        avgResponseTime: `${Math.round(server.avgResponseTime)}ms`,
        priority: Math.round(server.priority * 100) / 100
      });

      // Re-add server to queue with updated priority
      this.queue.enqueue(server);
    } catch (error) {
      const duration = Date.now() - startTime;
      server.updateMetrics(duration, false);

      requestCount.inc({
        method: req.method,
        route: req.originalUrl,
        status_code: "500",
        target_server: server.url,
      });

      logger.error("Request failed", {
        method: req.method,
        url: req.originalUrl,
        target: server.url,
        error: error.message,
        duration: `${duration}ms`,
        clientIp,
      });

      res.status(500).json({ error: "Internal server error" });
    } finally {
      server.decrementConnections();
    }
  }

  async performHealthCheck(server) {
    try {
      const parsedUrl = url.parse(`${server.url}/health`);
      const protocol = parsedUrl.protocol === "https:" ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: parsedUrl.path,
        method: "GET",
        timeout: 5000,
      };

      const healthCheckPromise = new Promise((resolve, reject) => {
        const req = protocol.request(options, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
            });
          });
        });

        req.on("error", reject);
        req.setTimeout(5000, () => {
          req.destroy();
          reject(new Error("Health check timeout"));
        });

        req.end();
      });

      const response = await healthCheckPromise;
      const isHealthy = response.ok;

      server.healthHistory.push({ timestamp: Date.now(), healthy: isHealthy });

      // Keep only last 10 health checks
      if (server.healthHistory.length > 10) {
        server.healthHistory.shift();
      }

      // Calculate health based on recent history
      const recentHealthy = server.healthHistory
        .slice(-5)
        .filter((h) => h.healthy).length;
      server.active = recentHealthy >= 2; // At least 2 out of 5 recent checks must be healthy (more lenient)

      serverHealth.set({ server: server.url }, server.active ? 1 : 0);

      if (!server.active) {
        logger.warn(`Server ${server.url} marked as unhealthy`);
      } else {
        logger.info(`Server ${server.url} is healthy`);
      }
    } catch (error) {
      server.healthHistory.push({ timestamp: Date.now(), healthy: false });
      server.active = false;
      serverHealth.set({ server: server.url }, 0);
      logger.error(`Health check failed for ${server.url}`, {
        error: error.message,
      });
    }
  }

  startHealthChecks() {
    setInterval(async () => {
      if (this.isShuttingDown) return;

      const healthPromises = this.servers.map((server) =>
        this.performHealthCheck(server)
      );
      await Promise.allSettled(healthPromises);

      // Rebuild queue after health checks
      this.rebuildQueue();
    }, config.healthCheckInterval);
  }

  startCleanupTasks() {
    // Cleanup rate limiter every 5 minutes
    setInterval(() => {
      this.rateLimiter.cleanup();
    }, 300000);
  }

  async gracefulShutdown() {
    logger.info("Starting graceful shutdown...");
    this.isShuttingDown = true;

    // Wait for active connections to finish
    const shutdownTimeout = setTimeout(() => {
      logger.warn("Graceful shutdown timeout reached, forcing exit");
      process.exit(1);
    }, config.gracefulShutdownTimeout);

    // Wait for all connections to close
    const checkConnections = setInterval(() => {
      const totalConnections = this.servers.reduce(
        (sum, server) => sum + server.connections,
        0
      );
      if (totalConnections === 0) {
        clearInterval(checkConnections);
        clearTimeout(shutdownTimeout);
        logger.info("All connections closed, shutting down");
        process.exit(0);
      }
    }, 1000);
  }

  getDetailedStatus() {
    const serverStats = this.servers.map((server) => ({
      url: server.url,
      active: server.active,
      connections: server.connections,
      totalRequests: server.totalRequests,
      requestCount: server.requestCount,
      avgResponseTime: Math.round(server.avgResponseTime),
      recentAvgResponseTime: server.recentResponseTimes.length > 0 
        ? Math.round(server.recentResponseTimes.reduce((a, b) => a + b, 0) / server.recentResponseTimes.length)
        : 0,
      circuitBreakerState: server.circuitBreakerState,
      load: Math.round(server.load * 100) + "%",
      priority: Math.round(server.priority * 100) / 100,
      lastRequestTime: server.lastRequestTime,
      timeSinceLastRequest: Math.round((Date.now() - server.lastRequestTime) / 1000) + "s",
      warmupRemaining: Math.max(0, server.warmupPeriod - (Date.now() - server.startTime))
    }));

    return {
      servers: serverStats,
      queueSize: this.queue.size(),
      worker: process.pid,
      totalActiveServers: serverStats.filter(s => s.active).length,
      loadBalancingStrategy: "adaptive-priority-with-anti-starvation",
      allServersWarmedUp: this.servers.every(server => 
        Date.now() - server.startTime > server.warmupPeriod
      )
    };
  }
}

// ---------------------- Application Setup ----------------------
if (cluster.isMaster) {
  logger.info(`Master ${process.pid} is running`);

  // Fork workers
  for (let i = 0; i < config.workers; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code, signal) => {
    logger.warn(`Worker ${worker.process.pid} died`);
    cluster.fork();
  });
} else {
  const app = express();
  const loadBalancer = new LoadBalancer();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // Trust proxy for accurate IP addresses
  app.set("trust proxy", true);

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      worker: process.pid,
    });
  });

  // Metrics endpoint
  app.get("/metrics", async (req, res) => {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  });

  // Status endpoint
  app.get("/status", (req, res) => {
    res.json(loadBalancer.getDetailedStatus());
  });

  // Main proxy route
  app.all("*", (req, res) => {
    loadBalancer.forwardRequest(req, res);
  });

  // Error handling
  app.use((err, req, res, next) => {
    logger.error("Unhandled error", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "Internal server error" });
  });

  const server = app.listen(config.port, () => {
    logger.info(
      `Load Balancer worker ${process.pid} running on port ${config.port}`
    );
  });

  // Graceful shutdown
  process.on("SIGTERM", () => loadBalancer.gracefulShutdown());
  process.on("SIGINT", () => loadBalancer.gracefulShutdown());

  server.on("error", (error) => {
    logger.error("Server error", { error: error.message });
  });
}
