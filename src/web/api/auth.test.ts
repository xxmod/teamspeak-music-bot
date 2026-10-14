import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import type { MusicProvider } from "../../music/provider.js";
import { getDefaultConfig, type JellyfinConfig } from "../../data/config.js";
import { createAuthRouter } from "./auth.js";

function fakeProvider(platform: MusicProvider["platform"]): MusicProvider {
  return { platform } as unknown as MusicProvider;
}

describe("auth router POST /jellyfin/test", () => {
  function mount(
    stored: Partial<JellyfinConfig>,
    user: unknown = { role: "admin" },
  ) {
    const config = getDefaultConfig();
    Object.assign(config.jellyfin, stored);
    const testConnection = vi.fn().mockResolvedValue({ ok: true, serverName: "JF" });
    const jellyfin = { platform: "jellyfin", testConnection } as unknown as MusicProvider;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as { user?: unknown }).user = user; next(); });
    app.use(
      "/api/auth",
      createAuthRouter(
        fakeProvider("netease"), fakeProvider("qq"), fakeProvider("bilibili"),
        pino({ level: "silent" }), undefined, undefined, undefined, jellyfin, config,
      ),
    );
    return { app, testConnection };
  }

  it("fills empty credential fields from the stored config (masked password case)", async () => {
    const { app, testConnection } = mount({
      serverUrl: "https://old.example.com",
      username: "bob",
      password: "stored-pw",
    });
    const res = await request(app)
      .post("/api/auth/jellyfin/test")
      .send({ serverUrl: "https://new.example.com", username: "bob", password: "" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: "https://new.example.com",
        username: "bob",
        password: "stored-pw",
      }),
    );
  });

  it("passes freshly entered credentials through", async () => {
    const { app, testConnection } = mount({});
    await request(app).post("/api/auth/jellyfin/test").send({
      serverUrl: "https://jf.example.com",
      authMode: "apikey",
      apiKey: "key123",
      userId: "u1",
    });
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: "apikey", apiKey: "key123", userId: "u1" }),
    );
  });

  it("is 403 for a member lacking platform.auth", async () => {
    const { app, testConnection } = mount({}, { role: "member", capabilities: new Set([]) });
    const res = await request(app).post("/api/auth/jellyfin/test").send({});
    expect(res.status).toBe(403);
    expect(testConnection).not.toHaveBeenCalled();
  });
});

describe("auth router /cookie endpoints", () => {
  function mountCookie(user: unknown = { role: "admin" }) {
    const netease = {
      platform: "netease",
      setCookie: vi.fn(),
      getCookie: vi.fn(() => ""),
    } as unknown as MusicProvider;
    const qq = {
      platform: "qq",
      setCookie: vi.fn(),
      getCookie: vi.fn(() => ""),
    } as unknown as MusicProvider;
    const bilibili = {
      platform: "bilibili",
      setCookie: vi.fn(),
      getCookie: vi.fn(() => ""),
    } as unknown as MusicProvider;
    const cookieStore = {
      save: vi.fn(),
      load: vi.fn(() => ""),
      delete: vi.fn(),
    };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as { user?: unknown }).user = user; next(); });
    app.use(
      "/api/auth",
      createAuthRouter(
        netease, qq, bilibili,
        pino({ level: "silent" }), cookieStore as any,
      ),
    );
    return { app, netease, qq, bilibili, cookieStore };
  }

  it("saves a valid cookie via POST /api/auth/cookie", async () => {
    const { app, netease, cookieStore } = mountCookie();
    const res = await request(app)
      .post("/api/auth/cookie")
      .send({ platform: "netease", cookie: "MUSIC_U=valid_cookie" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(netease.setCookie).toHaveBeenCalledWith("MUSIC_U=valid_cookie");
    expect(cookieStore.save).toHaveBeenCalledWith("netease", "MUSIC_U=valid_cookie");
  });

  it("clears cookie via POST /api/auth/cookie with empty string", async () => {
    const { app, netease, cookieStore } = mountCookie();
    const res = await request(app)
      .post("/api/auth/cookie")
      .send({ platform: "netease", cookie: "   " });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.cleared).toBe(true);
    expect(netease.setCookie).toHaveBeenCalledWith("");
    expect(cookieStore.delete).toHaveBeenCalledWith("netease");
  });

  it("clears cookie via DELETE /api/auth/cookie/:platform", async () => {
    const { app, qq, cookieStore } = mountCookie();
    const res = await request(app).delete("/api/auth/cookie/qq");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.cleared).toBe(true);
    expect(qq.setCookie).toHaveBeenCalledWith("");
    expect(cookieStore.delete).toHaveBeenCalledWith("qq");
  });

  it("clears cookie via DELETE /api/auth/cookie with body", async () => {
    const { app, bilibili, cookieStore } = mountCookie();
    const res = await request(app)
      .delete("/api/auth/cookie")
      .send({ platform: "bilibili" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.cleared).toBe(true);
    expect(bilibili.setCookie).toHaveBeenCalledWith("");
    expect(cookieStore.delete).toHaveBeenCalledWith("bilibili");
  });

  it("rejects unauthorized user with 403 on DELETE /api/auth/cookie/:platform", async () => {
    const { app, cookieStore } = mountCookie({ role: "member", capabilities: new Set([]) });
    const res = await request(app).delete("/api/auth/cookie/netease");
    expect(res.status).toBe(403);
    expect(cookieStore.delete).not.toHaveBeenCalled();
  });
});
