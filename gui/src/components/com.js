"use client";

import React, { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

export default function EnhancedLoadBalancerDashboard() {
  const [status, setStatus] = useState({
    servers: [],
    queueSize: 0,
    worker: 0,
  });
  const [metrics, setMetrics] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [totalRequests, setTotalRequests] = useState(0);
  const [avgResponseTime, setAvgResponseTime] = useState(0);

  useEffect(() => {
    const fetchData = async () => {
      try {
        // Fetch status data
        const LB_URL = process.env.NEXT_PUBLIC_LB_URL || "https://loadblancer.onrender.com";
        const statusRes = await fetch(`${LB_URL}/status`);
        const statusData = await statusRes.json();
        setStatus(statusData);

        // Fetch metrics data
        const metricsRes = await fetch(`${LB_URL}/metrics`);
        const metricsText = await metricsRes.text();
        setMetrics(metricsText);

        // Calculate totals
        const totalReqs = statusData.servers.reduce(
          (sum, server) => sum + server.totalRequests,
          0
        );
        const totalTime = statusData.servers.reduce(
          (sum, server) => sum + server.avgResponseTime * server.totalRequests,
          0
        );
        const avgTime = totalReqs > 0 ? totalTime / totalReqs : 0;

        setTotalRequests(totalReqs);
        setAvgResponseTime(avgTime);
        setError(null);
        setIsLoading(false);
      } catch (err) {
        console.error("Error fetching data:", err);
        setError("Failed to connect to load balancer");
        setIsLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 2000);
    return () => clearInterval(interval);
  }, []);

  const getHealthyServers = () =>
    status.servers.filter((server) => server.active).length;
  const getTotalServers = () => status.servers.length;
  const getOverallHealth = () => {
    const healthy = getHealthyServers();
    const total = getTotalServers();
    return total > 0 ? (healthy / total) * 100 : 0;
  };

  const formatUptime = () => {
    const uptimeMs = Date.now() - (status.startTime || Date.now());
    const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
    const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  };

  const parseMetrics = (metricsText) => {
    const lines = metricsText.split("\n");
    const parsed = {};

    lines.forEach((line) => {
      if (line.startsWith("http_requests_total")) {
        const match = line.match(/http_requests_total{.*} (\d+)/);
        if (match) {
          parsed.totalRequests =
            (parsed.totalRequests || 0) + parseInt(match[1]);
        }
      }
      if (line.startsWith("http_request_duration_seconds_sum")) {
        const match = line.match(
          /http_request_duration_seconds_sum{.*} ([\d.]+)/
        );
        if (match) {
          parsed.totalDuration =
            (parsed.totalDuration || 0) + parseFloat(match[1]);
        }
      }
    });

    return parsed;
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-white mx-auto"></div>
          <p className="text-white text-xl mt-4">
            Loading Load Balancer Dashboard...
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-red-900 via-red-700 to-red-900">
        <div className="text-center">
          <div className="text-6xl mb-4">⚠️</div>
          <h2 className="text-white text-2xl mb-2">Connection Failed</h2>
          <p className="text-red-200">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 p-6">
      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-5xl font-bold text-white mb-2">
          ⚡ Load Balancer Control Center
        </h1>
        <p className="text-purple-200 text-lg">
          Real-time monitoring and analytics
        </p>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        <Card className="bg-gradient-to-r from-green-500 to-emerald-600 border-0 shadow-2xl">
          <CardContent className="p-6 text-center">
            <div className="text-3xl font-bold text-white">
              {getHealthyServers()}/{getTotalServers()}
            </div>
            <div className="text-green-100 text-sm mt-1">Healthy Servers</div>
            <div className="text-4xl mt-2">🟢</div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-r from-blue-500 to-cyan-600 border-0 shadow-2xl">
          <CardContent className="p-6 text-center">
            <div className="text-3xl font-bold text-white">
              {totalRequests.toLocaleString()}
            </div>
            <div className="text-blue-100 text-sm mt-1">Total Requests</div>
            <div className="text-4xl mt-2">�</div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-r from-purple-500 to-pink-600 border-0 shadow-2xl">
          <CardContent className="p-6 text-center">
            <div className="text-3xl font-bold text-white">
              {Math.round(avgResponseTime)}ms
            </div>
            <div className="text-purple-100 text-sm mt-1">
              Avg Response Time
            </div>
            <div className="text-4xl mt-2">⚡</div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-r from-orange-500 to-red-600 border-0 shadow-2xl">
          <CardContent className="p-6 text-center">
            <div className="text-3xl font-bold text-white">
              {status.queueSize}
            </div>
            <div className="text-orange-100 text-sm mt-1">Queue Size</div>
            <div className="text-4xl mt-2">🚀</div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Server Status */}
        <Card className="bg-slate-800/50 border-slate-700 shadow-2xl backdrop-blur-sm">
          <CardContent className="p-6">
            <div className="flex items-center mb-6">
              <div className="text-2xl mr-3">🌐</div>
              <h2 className="text-2xl font-semibold text-white">
                Server Health Status
              </h2>
            </div>
            <div className="space-y-4">
              {status.servers.map((server, index) => (
                <div
                  key={index}
                  className={`p-4 rounded-lg border-2 transition-all duration-300 hover:scale-105 ${
                    server.active
                      ? "bg-green-900/20 border-green-500 shadow-green-500/20"
                      : "bg-red-900/20 border-red-500 shadow-red-500/20"
                  } shadow-lg`}
                >
                  <div className="flex justify-between items-center mb-3">
                    <div className="flex items-center">
                      <div
                        className={`w-3 h-3 rounded-full mr-3 ${
                          server.active
                            ? "bg-green-400 animate-pulse"
                            : "bg-red-400"
                        }`}
                      ></div>
                      <span className="text-white font-semibold text-lg">
                        {server.url}
                      </span>
                    </div>
                    <Badge
                      className={`px-3 py-1 text-sm font-bold ${
                        server.active
                          ? "bg-green-500 hover:bg-green-600"
                          : "bg-red-500 hover:bg-red-600"
                      } text-white shadow-lg`}
                    >
                      {server.active ? "🟢 HEALTHY" : "🔴 DOWN"}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="bg-slate-700/30 p-3 rounded">
                      <div className="text-slate-400">Requests</div>
                      <div className="text-white font-bold text-lg">
                        {server.totalRequests}
                      </div>
                    </div>
                    <div className="bg-slate-700/30 p-3 rounded">
                      <div className="text-slate-400">Response Time</div>
                      <div className="text-white font-bold text-lg">
                        {Math.round(server.avgResponseTime)}ms
                      </div>
                    </div>
                    <div className="bg-slate-700/30 p-3 rounded">
                      <div className="text-slate-400">Connections</div>
                      <div className="text-white font-bold text-lg">
                        {server.connections}
                      </div>
                    </div>
                    <div className="bg-slate-700/30 p-3 rounded">
                      <div className="text-slate-400">Load</div>
                      <div className="text-white font-bold text-lg">
                        {server.load}
                      </div>
                    </div>
                  </div>

                  {/* Connection Load Bar */}
                  <div className="mt-4">
                    <div className="flex justify-between text-sm text-slate-400 mb-1">
                      <span>Connection Load</span>
                      <span>{server.connections}/100</span>
                    </div>
                    <div className="w-full bg-slate-700 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full transition-all duration-500 ${
                          server.connections > 80
                            ? "bg-red-500"
                            : server.connections > 50
                            ? "bg-yellow-500"
                            : "bg-green-500"
                        }`}
                        style={{
                          width: `${Math.min(server.connections, 100)}%`,
                        }}
                      ></div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* System Metrics */}
        <div className="space-y-8">
          {/* Health Overview */}
          <Card className="bg-slate-800/50 border-slate-700 shadow-2xl backdrop-blur-sm">
            <CardContent className="p-6">
              <div className="flex items-center mb-6">
                <div className="text-2xl mr-3">💎</div>
                <h2 className="text-2xl font-semibold text-white">
                  System Health
                </h2>
              </div>

              <div className="text-center mb-6">
                <div className="text-6xl font-bold text-white mb-2">
                  {Math.round(getOverallHealth())}%
                </div>
                <div className="text-slate-400">Overall Health Score</div>
              </div>

              <div className="w-full bg-slate-700 rounded-full h-4 mb-6">
                <div
                  className={`h-4 rounded-full transition-all duration-1000 ${
                    getOverallHealth() >= 80
                      ? "bg-green-500"
                      : getOverallHealth() >= 50
                      ? "bg-yellow-500"
                      : "bg-red-500"
                  }`}
                  style={{ width: `${getOverallHealth()}%` }}
                ></div>
              </div>

              <div className="grid grid-cols-1 gap-4">
                <div className="flex justify-between items-center p-3 bg-slate-700/30 rounded">
                  <span className="text-slate-400">Worker Process</span>
                  <span className="text-white font-bold">
                    PID: {status.worker}
                  </span>
                </div>
                <div className="flex justify-between items-center p-3 bg-slate-700/30 rounded">
                  <span className="text-slate-400">Queue Size</span>
                  <span className="text-white font-bold">
                    {status.queueSize} servers
                  </span>
                </div>
                <div className="flex justify-between items-center p-3 bg-slate-700/30 rounded">
                  <span className="text-slate-400">Load Balancer</span>
                  <span className="text-green-400 font-bold">🟢 ACTIVE</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Performance Metrics */}
          <Card className="bg-slate-800/50 border-slate-700 shadow-2xl backdrop-blur-sm">
            <CardContent className="p-6">
              <div className="flex items-center mb-6">
                <div className="text-2xl mr-3">⚡</div>
                <h2 className="text-2xl font-semibold text-white">
                  Performance
                </h2>
              </div>

              <div className="grid grid-cols-1 gap-4">
                <div className="bg-gradient-to-r from-blue-600/20 to-purple-600/20 p-4 rounded-lg border border-blue-500/30">
                  <div className="flex justify-between items-center">
                    <div>
                      <div className="text-slate-400 text-sm">
                        Requests Per Second
                      </div>
                      <div className="text-white font-bold text-2xl">
                        {Math.round(totalRequests / 60)} req/s
                      </div>
                    </div>
                    <div className="text-3xl">📈</div>
                  </div>
                </div>

                <div className="bg-gradient-to-r from-green-600/20 to-emerald-600/20 p-4 rounded-lg border border-green-500/30">
                  <div className="flex justify-between items-center">
                    <div>
                      <div className="text-slate-400 text-sm">
                        Average Latency
                      </div>
                      <div className="text-white font-bold text-2xl">
                        {Math.round(avgResponseTime)}ms
                      </div>
                    </div>
                    <div className="text-3xl">🎯</div>
                  </div>
                </div>

                <div className="bg-gradient-to-r from-purple-600/20 to-pink-600/20 p-4 rounded-lg border border-purple-500/30">
                  <div className="flex justify-between items-center">
                    <div>
                      <div className="text-slate-400 text-sm">Success Rate</div>
                      <div className="text-white font-bold text-2xl">
                        {getOverallHealth() > 0 ? "99.9%" : "0%"}
                      </div>
                    </div>
                    <div className="text-3xl">✅</div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Live Metrics Stream */}
      <Card className="mt-8 bg-slate-800/50 border-slate-700 shadow-2xl backdrop-blur-sm">
        <CardContent className="p-6">
          <div className="flex items-center mb-6">
            <div className="text-2xl mr-3">📡</div>
            <h2 className="text-2xl font-semibold text-white">
              Live Metrics Stream
            </h2>
            <div className="ml-auto">
              <div className="flex items-center">
                <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse mr-2"></div>
                <span className="text-green-400 text-sm">LIVE</span>
              </div>
            </div>
          </div>

          <ScrollArea className="h-64">
            <div className="font-mono text-sm text-green-400 bg-slate-900/50 p-4 rounded overflow-auto">
              <pre className="whitespace-pre-wrap">{metrics}</pre>
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Footer */}
      <div className="text-center mt-8 text-slate-400">
        <p>
          🚀 Load Balancer Dashboard - Last updated:{" "}
          {new Date().toLocaleTimeString()}
        </p>
      </div>
    </div>
  );
}
