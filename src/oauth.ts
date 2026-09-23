// OAuth 2.1 resource-server side: validates Keycloak-issued access tokens
// (JWT, RS256/ES256) against the realm's JWKS and enforces user/group rules.
//
// Discovery for clients (claude.ai, Claude Code) follows RFC 9728:
//   GET /.well-known/oauth-protected-resource  → { resource, authorization_servers, ... }
// and the 401 carries  WWW-Authenticate: Bearer resource_metadata="<url>".

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface OAuthOptions {
  issuer: string;
  audience?: string;
  allowedUsers: string[];
  requiredGroup?: string;
}

export interface OAuthIdentity {
  subject: string;
  username: string | null;
  groups: string[];
  expiresAt: number | null;
}

export class OAuthVerifier {
  private jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly opts: OAuthOptions) {
    const issuer = opts.issuer.replace(/\/+$/, "");
    this.jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`), {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
  }

  /** Returns the identity or throws an Error with a short reason. */
  async verify(token: string): Promise<OAuthIdentity> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.opts.issuer.replace(/\/+$/, ""),
      audience: this.opts.audience || undefined,
      clockTolerance: 30,
    });
    const identity = toIdentity(payload);
    if (this.opts.allowedUsers.length) {
      const ok = identity.username && this.opts.allowedUsers.map((u) => u.toLowerCase()).includes(identity.username.toLowerCase());
      if (!ok) throw new Error(`user "${identity.username ?? identity.subject}" is not on the allow list`);
    }
    if (this.opts.requiredGroup) {
      const want = this.opts.requiredGroup.replace(/^\/+/, "").toLowerCase();
      const ok = identity.groups.some((g) => g.replace(/^\/+/, "").toLowerCase() === want);
      if (!ok) throw new Error(`user "${identity.username ?? identity.subject}" is not in group "${this.opts.requiredGroup}"`);
    }
    return identity;
  }
}

export function toIdentity(payload: JWTPayload): OAuthIdentity {
  const groupsRaw = (payload as Record<string, unknown>).groups;
  const groups = Array.isArray(groupsRaw) ? groupsRaw.filter((g): g is string => typeof g === "string") : [];
  const username = (payload as Record<string, unknown>).preferred_username;
  return {
    subject: payload.sub ?? "",
    username: typeof username === "string" ? username : null,
    groups,
    expiresAt: payload.exp ?? null,
  };
}

/** RFC 9728 document served at /.well-known/oauth-protected-resource. */
export function protectedResourceMetadata(publicUrl: string, endpointPath: string, issuer: string, scopes: string[]) {
  return {
    resource: `${publicUrl}${endpointPath}`,
    authorization_servers: [issuer.replace(/\/+$/, "")],
    scopes_supported: scopes,
    bearer_methods_supported: ["header"],
    resource_name: "agency",
  };
}
