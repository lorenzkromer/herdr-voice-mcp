import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";

export function tokensEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface AuthResult {
  ok: boolean;
  /** The endpoint path with any trailing token segment removed. */
  path: string;
  via: "header" | "path" | "none";
}

/**
 * Accepts `Authorization: Bearer <token>` or, when allowed, a trailing path
 * segment `<endpoint>/<token>` for clients that cannot set headers.
 */
export function authenticate(req: IncomingMessage, pathname: string, opts: { token: string; endpoint: string; allowTokenInPath: boolean }): AuthResult {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m && tokensEqual(m[1].trim(), opts.token)) return { ok: true, path: pathname.replace(/\/+$/, "") || "/", via: "header" };
    return { ok: false, path: pathname, via: "header" };
  }
  if (opts.allowTokenInPath) {
    const prefix = opts.endpoint.replace(/\/+$/, "") + "/";
    if (pathname.startsWith(prefix)) {
      const candidate = decodeURIComponent(pathname.slice(prefix.length).replace(/\/+$/, ""));
      if (candidate && !candidate.includes("/") && tokensEqual(candidate, opts.token)) {
        return { ok: true, path: opts.endpoint, via: "path" };
      }
    }
  }
  return { ok: false, path: pathname, via: "none" };
}

/** Sliding-window rate limiter for the whole process (one caller, one Mac). */
export class RateLimiter {
  private hits: number[] = [];
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  allow(now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    while (this.hits.length && this.hits[0] < cutoff) this.hits.shift();
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

export function killSwitchOn(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}
