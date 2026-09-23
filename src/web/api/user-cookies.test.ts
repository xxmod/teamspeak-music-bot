import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import type { MusicProvider } from "../../music/provider.js";
import type { BotDatabase } from "../../data/database.js";
import { createUserCookiesRouter } from "./user-cookies.js";

function fakeProvider(platform: MusicProvider["platform"]): MusicProvider {
  return {
    platform,
    getQrCode: vi.fn().mockResolvedValue({ key: "k-1", qrUrl: "https://qr.test" }),
    checkQrCodeForCookie: vi.fn().mockResolvedValue({ status: "confirmed", cookie: "TEST_COOKIE=1" }),
    checkQrCodeStatus: vi.fn().mockResolvedValue("waiting"),
  } as unknown as MusicProvider;
}

function fakeDatabase(): BotDatabase {
  const store: Record<string, Record<string, string>> = {};
  return {
    setUserCookie: vi.fn((userId: string, platform: string, cookie: string) => {
      store[userId] = store[userId] || {};
      store[userId][platform] = cookie;
    }),
    getUserCookie: vi.fn((userId: string, platform: string) => {
      return store[userId]?.[platform] ?? null;
    }),
    getUserCookies: vi.fn((userId: string) => {
      const userStore = store[userId] || {};
      const res: Record<string, { configured: boolean; updatedAt: number }> = {};
      for (const [p] of Object.entries(userStore)) {
        res[p] = { configured: true, updatedAt: 12345 };
      }
      return res;
    }),
    deleteUserCookie: vi.fn((userId: string, platform: string) => {
      if (store[userId]?.[platform]) {
        delete store[userId][platform];
        return true;
      }
      return false;
    }),
  } as unknown as BotDatabase;
}

describe("user cookies router", () => {
  function mount(
    user: unknown = { id: "u-1", role: "member" },
    db = fakeDatabase(),
    config?: Parameters<typeof createUserCookiesRouter>[3]
  ) {
    const netease = fakeProvider("netease");
    const qq = fakeProvider("qq");
    const bilibili = fakeProvider("bilibili");
    const kugou = fakeProvider("kugou");

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { user?: unknown }).user = user;
      next();
    });
    app.use(
      "/api/user/cookies",
      createUserCookiesRouter(db, { netease, qq, bilibili, kugou }, pino({ level: "silent" }), config)
    );
    return { app, db, netease, qq, bilibili, kugou };
  }

  it("rejects guest users", async () => {
    const { app } = mount({ id: "guest", role: "guest" });
    const res = await request(app).get("/api/user/cookies");
    expect(res.status).toBe(403);
  });

  it("lists, sets and deletes user cookies", async () => {
    const { app, db } = mount({ id: "u-1", role: "member" });

    // Initial status
    let res = await request(app).get("/api/user/cookies");
    expect(res.status).toBe(200);
    expect(res.body.netease.configured).toBe(false);
    expect(res.body.enabledPlatforms).toEqual(["netease", "qq", "kugou", "bilibili"]);

    // Save cookie
    res = await request(app)
      .post("/api/user/cookies")
      .send({ platform: "netease", cookie: "MUSIC_U=mytoken" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(db.setUserCookie).toHaveBeenCalledWith("u-1", "netease", "MUSIC_U=mytoken");

    // List after save
    res = await request(app).get("/api/user/cookies");
    expect(res.status).toBe(200);
    expect(res.body.netease.configured).toBe(true);

    // Delete cookie
    res = await request(app).delete("/api/user/cookies/netease");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(db.deleteUserCookie).toHaveBeenCalledWith("u-1", "netease");
  });

  it("supports personal QR code generation and auto-save on confirmed", async () => {
    const { app, db, netease } = mount({ id: "u-1", role: "member" });

    // Request QR code
    let res = await request(app).post("/api/user/cookies/qrcode").send({ platform: "netease" });
    expect(res.status).toBe(200);
    expect(res.body.key).toBe("k-1");

    // Poll status (confirmed)
    res = await request(app)
      .get("/api/user/cookies/qrcode/status")
      .query({ platform: "netease", key: "k-1" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("confirmed");
    expect(netease.checkQrCodeForCookie).toHaveBeenCalledWith("k-1");
    expect(db.setUserCookie).toHaveBeenCalledWith("u-1", "netease", "TEST_COOKIE=1");
  });

  it("respects enabledProviders gating and blocks disabled platforms like qq", async () => {
    const fakeConfig = {
      enabledProviders: ["netease", "bilibili"],
    } as any;

    const { app, qq, netease } = mount({ id: "u-1", role: "member" }, fakeDatabase(), fakeConfig);

    // 1. GET / lists enabledPlatforms only for enabled ones
    const listRes = await request(app).get("/api/user/cookies");
    expect(listRes.status).toBe(200);
    expect(listRes.body.enabledPlatforms).toEqual(["netease", "bilibili"]);
    expect(listRes.body.enabledPlatforms).not.toContain("qq");
    expect(listRes.body.enabledPlatforms).not.toContain("kugou");

    // 2. POST /qrcode for disabled platform (qq) is blocked with 400 and never invokes qqProvider
    const qrRes = await request(app).post("/api/user/cookies/qrcode").send({ platform: "qq" });
    expect(qrRes.status).toBe(400);
    expect(qrRes.body.error).toMatch(/disabled/i);
    expect(qq.getQrCode).not.toHaveBeenCalled();

    // 3. POST / (save cookie) for disabled platform is blocked
    const saveRes = await request(app).post("/api/user/cookies").send({ platform: "qq", cookie: "test" });
    expect(saveRes.status).toBe(400);
    expect(saveRes.body.error).toMatch(/disabled/i);

    // 4. GET /qrcode/status for disabled platform is blocked
    const statusRes = await request(app).get("/api/user/cookies/qrcode/status").query({ platform: "qq", key: "k-1" });
    expect(statusRes.status).toBe(400);
    expect(statusRes.body.error).toMatch(/disabled/i);

    // 5. Allowed platform (netease) still works
    const okQrRes = await request(app).post("/api/user/cookies/qrcode").send({ platform: "netease" });
    expect(okQrRes.status).toBe(200);
    expect(netease.getQrCode).toHaveBeenCalled();
  });
});
