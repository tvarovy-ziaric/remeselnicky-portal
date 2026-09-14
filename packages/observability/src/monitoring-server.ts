import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import type { PortalMetrics } from "./metrics.js";

export interface MonitoringServer {
  close(): Promise<void>;
  listen(input: {
    readonly host: string;
    readonly port: number;
  }): Promise<number>;
}

export interface MonitoringServerOptions {
  readonly metrics: PortalMetrics;
  readonly ready?: () => boolean | Promise<boolean>;
}

/** Internal-only scrape and health server. It never emits diagnostic details. */
export function createMonitoringServer(
  options: MonitoringServerOptions,
): MonitoringServer {
  const server = createServer((request, response) => {
    void handleRequest(options, request, response).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { status: "unavailable" });
      } else {
        response.destroy();
      }
    });
  });

  return Object.freeze({
    close(): Promise<void> {
      if (!server.listening) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        server.close((error?: Error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    },
    listen(input: {
      readonly host: string;
      readonly port: number;
    }): Promise<number> {
      return listen(server, input);
    },
  });
}

async function handleRequest(
  options: MonitoringServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");

  if (request.method !== "GET") {
    sendJson(response, 405, { status: "method_not_allowed" });
    return;
  }
  const path = request.url?.split("?", 1)[0];
  if (path === "/health/live") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (path === "/health/ready") {
    try {
      const ready = (await options.ready?.()) ?? true;
      sendJson(response, ready ? 200 : 503, {
        status: ready ? "ready" : "not_ready",
      });
    } catch {
      sendJson(response, 503, { status: "not_ready" });
    }
    return;
  }
  if (path === "/metrics") {
    response.statusCode = 200;
    response.setHeader("content-type", options.metrics.contentType);
    response.end(options.metrics.render());
    return;
  }
  sendJson(response, 404, { status: "not_found" });
}

function listen(
  server: Server,
  input: { readonly host: string; readonly port: number },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(input.port, input.host);
  });
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Readonly<Record<string, string>>,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
