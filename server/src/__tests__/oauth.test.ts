import { describe, expect, it } from "vitest";

import {
  handleOAuthAuthorizationServerMetadata,
  handleOAuthProtectedResourceMetadata,
  handleOAuthRegister,
} from "../core/routes/oauth";
import type { Env } from "../core/types";

class MockSessions {
  private readonly values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }

  async delete(key: string) {
    this.values.delete(key);
  }
}

function testEnv(): Env {
  return {
    DB: {} as D1Database,
    DOCS: {} as R2Bucket,
    SESSIONS: new MockSessions() as unknown as KVNamespace,
    ENHANCE_QUEUE: { send: async () => {} } as unknown as Env["ENHANCE_QUEUE"],
    API_KEY: "test-key",
    OWNER_EMAIL: "owner@example.com",
    APNS_KEY_ID: "key",
    APNS_TEAM_ID: "team",
    APNS_PRIVATE_KEY: "private-key",
    WORKER_URL: "https://example.test",
    ENVIRONMENT: "test",
  };
}

describe("OAuth MCP metadata", () => {
  it("advertises the Pidgin MCP protected resource and authorization server", async () => {
    const env = testEnv();
    const resource = await handleOAuthProtectedResourceMetadata(
      new Request("https://example.test/.well-known/oauth-protected-resource/mcp"),
      env
    ).json() as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
    };

    const authServer = await handleOAuthAuthorizationServerMetadata(
      new Request("https://example.test/.well-known/oauth-authorization-server"),
      env
    ).json() as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
    };

    expect(resource.resource).toBe("https://example.test/mcp");
    expect(resource.authorization_servers).toEqual(["https://example.test"]);
    expect(resource.scopes_supported).toContain("mcp");
    expect(authServer.authorization_endpoint).toBe("https://example.test/oauth/authorize");
    expect(authServer.token_endpoint).toBe("https://example.test/oauth/token");
    expect(authServer.registration_endpoint).toBe("https://example.test/oauth/register");
    expect(authServer.code_challenge_methods_supported).toContain("S256");
  });

  it("allows unauthenticated dynamic client registration for remote MCP clients", async () => {
    const response = await handleOAuthRegister(
      new Request("https://example.test/oauth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.10",
        },
        body: JSON.stringify({
          client_name: "ChatGPT MCP",
          redirect_uris: ["https://chatgpt.com/mcp/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: "mcp",
        }),
      }),
      testEnv()
    );

    const body = await response.json() as {
      client_id: string;
      redirect_uris: string[];
      token_endpoint_auth_method: string;
      scope: string;
    };

    expect(response.status).toBe(201);
    expect(body.client_id).toMatch(/^cp_/);
    expect(body.redirect_uris).toEqual(["https://chatgpt.com/mcp/callback"]);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.scope).toBe("mcp");
  });
});
