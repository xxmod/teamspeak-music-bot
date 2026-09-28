import { Router } from "express";
import type { MusicProvider } from "../../music/provider.js";
import type { BotDatabase } from "../../data/database.js";
import type { Logger } from "../../logger.js";
import type { BotConfig } from "../../data/config.js";
import { isProviderEnabled } from "../../data/config.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";

export const SUPPORTED_PLATFORMS = ["netease", "qq", "kugou", "bilibili"] as const;
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

export function createUserCookiesRouter(
  db: BotDatabase,
  providers: {
    netease: MusicProvider;
    qq: MusicProvider;
    bilibili: MusicProvider;
    kugou?: MusicProvider;
  },
  logger: Logger,
  config?: BotConfig
): Router {
  const router = Router();

  function isPlatformEnabled(platform: string): boolean {
    if (!config) return true;
    return isProviderEnabled(config, platform);
  }

  function getProvider(platform: string): MusicProvider | undefined {
    if (!isPlatformEnabled(platform)) return undefined;
    if (platform === "netease") return providers.netease;
    if (platform === "qq") return providers.qq;
    if (platform === "bilibili") return providers.bilibili;
    if (platform === "kugou") return providers.kugou;
    return undefined;
  }

  // All user-cookie routes require an authenticated non-guest user
  router.use(requireNotGuest);

  // GET / - List configured platforms and their updated timestamps
  router.get("/", (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const status = db.getUserCookies(userId);
    const result: Record<SupportedPlatform, { configured: boolean; updatedAt?: number }> = {
      netease: { configured: status.netease?.configured ?? false, updatedAt: status.netease?.updatedAt },
      qq: { configured: status.qq?.configured ?? false, updatedAt: status.qq?.updatedAt },
      kugou: { configured: status.kugou?.configured ?? false, updatedAt: status.kugou?.updatedAt },
      bilibili: { configured: status.bilibili?.configured ?? false, updatedAt: status.bilibili?.updatedAt },
    };
    const enabledPlatforms = SUPPORTED_PLATFORMS.filter((p) => isPlatformEnabled(p));
    res.json({ cookies: result, enabledPlatforms, ...result });
  });

  // POST / - Save or update user cookie for a platform
  router.post("/", (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const { platform, cookie } = req.body;
    if (!platform || !SUPPORTED_PLATFORMS.includes(platform as SupportedPlatform)) {
      res.status(400).json({ error: `Unsupported platform. Supported: ${SUPPORTED_PLATFORMS.join(", ")}` });
      return;
    }
    if (!isPlatformEnabled(platform)) {
      res.status(400).json({ error: `平台未在服务端配置中启用：${platform} (provider disabled)` });
      return;
    }
    if (!cookie || typeof cookie !== "string" || !cookie.trim()) {
      res.status(400).json({ error: "cookie is required" });
      return;
    }

    let raw = cookie.trim();
    if (/^cookie:\s*/i.test(raw)) {
      raw = raw.replace(/^cookie:\s*/i, "").trim();
    }
    const cleanedCookie = raw
      .split(/[\r\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join("; ");

    db.setUserCookie(userId, platform, cleanedCookie);
    logger.info({ userId, platform }, "User platform cookie saved");
    res.json({ success: true, message: "Cookie saved" });
  });

  // DELETE /:platform - Remove user cookie for a platform
  router.delete("/:platform", (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const { platform } = req.params;
    if (!platform || !SUPPORTED_PLATFORMS.includes(platform as SupportedPlatform)) {
      res.status(400).json({ error: "Invalid platform" });
      return;
    }
    const deleted = db.deleteUserCookie(userId, platform);
    logger.info({ userId, platform, deleted }, "User platform cookie deleted");
    res.json({ success: true, deleted });
  });

  // POST /qrcode - Generate login QR code for user
  router.post("/qrcode", async (req, res) => {
    try {
      const { platform } = req.body;
      if (!platform || !SUPPORTED_PLATFORMS.includes(platform as SupportedPlatform)) {
        res.status(400).json({ error: "Invalid platform" });
        return;
      }
      if (!isPlatformEnabled(platform)) {
        res.status(400).json({ error: `平台未在服务端配置中启用：${platform} (provider disabled)` });
        return;
      }
      const provider = getProvider(platform);
      if (!provider) {
        res.status(400).json({ error: "Provider not available for this platform" });
        return;
      }
      const qr = await provider.getQrCode();
      res.json(qr);
    } catch (err) {
      logger.error({ err }, "User QR code generation failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /qrcode/status - Poll QR code status and persist cookie on confirmed
  router.get("/qrcode/status", async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      const { key, platform } = req.query;
      if (!key || typeof key !== "string") {
        res.status(400).json({ error: "key is required" });
        return;
      }
      if (!platform || typeof platform !== "string" || !SUPPORTED_PLATFORMS.includes(platform as SupportedPlatform)) {
        res.status(400).json({ error: "platform is required" });
        return;
      }
      if (!isPlatformEnabled(platform)) {
        res.status(400).json({ error: `平台未在服务端配置中启用：${platform} (provider disabled)` });
        return;
      }
      const provider = getProvider(platform);
      if (!provider) {
        res.status(400).json({ error: "Provider not available" });
        return;
      }

      if (provider.checkQrCodeForCookie) {
        const result = await provider.checkQrCodeForCookie(key);
        if (result.status === "confirmed" && result.cookie) {
          db.setUserCookie(userId, platform, result.cookie);
          logger.info({ userId, platform }, "User cookie saved via personal QR login");
        }
        res.json({ status: result.status });
        return;
      }

      // Fallback: regular status check
      const status = await provider.checkQrCodeStatus(key);
      res.json({ status });
    } catch (err) {
      logger.error({ err }, "User QR status check failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
