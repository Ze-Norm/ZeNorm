import type { InstanceConfig, RequestRefusalCode } from "@zenorm/contracts";
import type { Context, MiddlewareHandler } from "hono";

import type { Log } from "./app.ts";

const FORBIDDEN = 403;
const UNSUPPORTED_MEDIA_TYPE = 415;
const JSON_MEDIA_TYPE = "application/json";

/** The address the server listens on: the instance config's `server` section. */
export type ServerAddress = InstanceConfig["server"];

/** A host as a Host header spells it: an IPv6 literal is bracketed. */
function hostForm(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Every `host:port` ZeNorm answers to, lower case: the configured host, `localhost`, `127.0.0.1`
 * and `[::1]`, each on the configured port. A name with no port is not among them.
 */
export function allowedHosts(server: ServerAddress): ReadonlySet<string> {
  const port = String(server.port);
  return new Set(
    [hostForm(server.host), "localhost", "127.0.0.1", "[::1]"].map(
      (name) => `${name.toLowerCase()}:${port}`,
    ),
  );
}

/** Whether `origin` is `http://` and then one of `hosts`, the name compared case-insensitively. */
function ownOrigin(origin: string, hosts: ReadonlySet<string>): boolean {
  const scheme = "http://";
  const lower = origin.toLowerCase();
  return lower.startsWith(scheme) && hosts.has(lower.slice(scheme.length));
}

/** Whether `/rpc` or anything under it. */
function isRpcPath(path: string): boolean {
  return path === "/rpc" || path.startsWith("/rpc/");
}

/** A header's value as a log line reads it. */
function received(value: string | undefined): string {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}

/**
 * The guard `createApp` registers before every route. Every route refuses a Host that is not
 * ZeNorm's own with 403 `host_not_allowed`. `/rpc` also refuses an Origin that is not ZeNorm's own
 * (`null` included) with 403 `origin_not_allowed`, and a POST not declared `application/json`
 * (parameters allowed) with 415 `content_type_not_json`; a request with no Origin passes. Each
 * refusal answers its code as the plain-text body and is logged with the route and the header
 * value received.
 */
export function requestGuard(server: ServerAddress, log: Log): MiddlewareHandler {
  const hosts = allowedHosts(server);

  function refuse(
    c: Context,
    code: RequestRefusalCode,
    status: typeof FORBIDDEN | typeof UNSUPPORTED_MEDIA_TYPE,
    header: string,
    value: string | undefined,
  ): Response {
    log(`Refused ${c.req.method} ${c.req.path} (${code}): ${header} ${received(value)}`, null);
    return c.text(code, status);
  }

  return async (c, next) => {
    const host = c.req.header("host");
    if (host === undefined || !hosts.has(host.toLowerCase())) {
      return refuse(c, "host_not_allowed", FORBIDDEN, "Host", host);
    }
    if (isRpcPath(c.req.path)) {
      const origin = c.req.header("origin");
      if (origin !== undefined && !ownOrigin(origin, hosts)) {
        return refuse(c, "origin_not_allowed", FORBIDDEN, "Origin", origin);
      }
      if (c.req.method === "POST") {
        const contentType = c.req.header("content-type");
        const mediaType = contentType?.split(";")[0];
        if (mediaType?.trim().toLowerCase() !== JSON_MEDIA_TYPE) {
          return refuse(
            c,
            "content_type_not_json",
            UNSUPPORTED_MEDIA_TYPE,
            "Content-Type",
            contentType,
          );
        }
      }
    }
    await next();
  };
}
