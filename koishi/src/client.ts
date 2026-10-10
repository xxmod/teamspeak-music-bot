import type { Context } from "koishi";
import type {
  Config,
  Song,
  BotInstanceInfo,
  QueueResponse,
  SearchResponse,
} from "./types.js";

export class TsmbClient {
  private endpoint: string;
  private apiKey?: string;

  constructor(
    private ctx: Context,
    private config: Config
  ) {
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.apiKey = config.apiKey?.trim();
  }

  private get headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
      headers["X-Api-Key"] = this.apiKey;
    }
    return headers;
  }

  /**
   * 格式化错误提示
   */
  private formatError(err: any): string {
    const resp = err.response?.data;
    const msg = resp?.error || resp?.message || err.message || "请求失败";
    if (err.response?.status === 401) {
      return "鉴权失败，请检查插件设置中的 apiKey 是否配置正确。";
    }
    if (err.response?.status === 403) {
      return `权限不足: ${msg}`;
    }
    if (err.response?.status === 404) {
      return `未找到目标机器人或资源: ${msg}`;
    }
    return msg;
  }

  /**
   * 获取所有机器人实例
   * GET /api/bot
   */
  async listBots(): Promise<BotInstanceInfo[]> {
    try {
      const res = await this.ctx.http.get<{ bots?: BotInstanceInfo[] }>(
        `${this.endpoint}/api/bot`,
        { headers: this.headers }
      );
      return res.bots ?? [];
    } catch (err: any) {
      throw new Error(`获取机器人列表失败: ${this.formatError(err)}`);
    }
  }

  /**
   * 确定目标机器人 ID（若未指定则自动选取首个在线的机器人）
   */
  async resolveBotId(overrideBotId?: string): Promise<string> {
    const target = overrideBotId || this.config.botId?.trim();
    if (target) {
      return target;
    }

    const bots = await this.listBots();
    if (!bots || bots.length === 0) {
      throw new Error("服务端当前未配置任何 TS 音乐机器人实例。");
    }

    const online = bots.find((b) => b.connected);
    if (online) {
      return online.id;
    }
    return bots[0].id;
  }

  /**
   * 点播歌曲（对应 !play）
   * POST /api/player/:botId/play
   */
  async play(
    query: string,
    platform?: string,
    overrideBotId?: string
  ): Promise<string> {
    const botId = await this.resolveBotId(overrideBotId);
    const plat = platform === "default" ? undefined : platform || (this.config.defaultPlatform !== "default" ? this.config.defaultPlatform : undefined);
    try {
      const res = await this.ctx.http.post<{ message?: string }>(
        `${this.endpoint}/api/player/${encodeURIComponent(botId)}/play`,
        { query, platform: plat },
        { headers: this.headers }
      );
      return res.message || `已发送点歌请求「${query}」`;
    } catch (err: any) {
      return `[错误] 点歌失败: ${this.formatError(err)}`;
    }
  }

  /**
   * 加歌入队（对应 !add）
   * POST /api/player/:botId/add
   */
  async add(
    query: string,
    platform?: string,
    overrideBotId?: string
  ): Promise<string> {
    const botId = await this.resolveBotId(overrideBotId);
    const plat = platform === "default" ? undefined : platform || (this.config.defaultPlatform !== "default" ? this.config.defaultPlatform : undefined);
    try {
      const res = await this.ctx.http.post<{ message?: string }>(
        `${this.endpoint}/api/player/${encodeURIComponent(botId)}/add`,
        { query, platform: plat },
        { headers: this.headers }
      );
      return res.message || `已将「${query}」加入播放队列`;
    } catch (err: any) {
      return `[错误] 加歌失败: ${this.formatError(err)}`;
    }
  }

  /**
   * 搜索歌曲（对应 !search）
   * GET /api/music/search?q=...&platform=...&limit=...
   */
  async search(
    query: string,
    platform?: string,
    limit = 5
  ): Promise<Song[]> {
    const plat = platform === "default" ? undefined : platform || (this.config.defaultPlatform !== "default" ? this.config.defaultPlatform : undefined);
    const params: Record<string, any> = { q: query, limit };
    if (plat) params.platform = plat;

    try {
      const res = await this.ctx.http.get<SearchResponse>(
        `${this.endpoint}/api/music/search`,
        {
          headers: this.headers,
          params,
        }
      );
      return res.songs ?? [];
    } catch (err: any) {
      throw new Error(`搜索失败: ${this.formatError(err)}`);
    }
  }

  /**
   * 插入下一首播放（对应 !playnext）
   * 原生调用：POST /api/player/:botId/play-next-song，传入搜索出来的 Song 实体
   */
  async playNextSong(
    song: Song,
    overrideBotId?: string
  ): Promise<string> {
    const botId = await this.resolveBotId(overrideBotId);
    try {
      const res = await this.ctx.http.post<{ ok?: boolean; message?: string }>(
        `${this.endpoint}/api/player/${encodeURIComponent(botId)}/play-next-song`,
        { song },
        { headers: this.headers }
      );
      return res.message || `已将「${song.name} - ${song.artist}」加入下一首播放`;
    } catch (err: any) {
      return `[错误] 插播失败: ${this.formatError(err)}`;
    }
  }

  /**
   * 暂停播放
   * POST /api/player/:botId/pause
   */
  async pause(overrideBotId?: string): Promise<string> {
    const botId = await this.resolveBotId(overrideBotId);
    try {
      const res = await this.ctx.http.post<{ message?: string }>(
        `${this.endpoint}/api/player/${encodeURIComponent(botId)}/pause`,
        {},
        { headers: this.headers }
      );
      return res.message || "已暂停播放。";
    } catch (err: any) {
      return `[错误] 暂停失败: ${this.formatError(err)}`;
    }
  }

  /**
   * 恢复播放
   * POST /api/player/:botId/resume
   */
  async resume(overrideBotId?: string): Promise<string> {
    const botId = await this.resolveBotId(overrideBotId);
    try {
      const res = await this.ctx.http.post<{ message?: string }>(
        `${this.endpoint}/api/player/${encodeURIComponent(botId)}/resume`,
        {},
        { headers: this.headers }
      );
      return res.message || "已恢复播放。";
    } catch (err: any) {
      return `[错误] 恢复失败: ${this.formatError(err)}`;
    }
  }

  /**
   * 切歌/下一首
   * POST /api/player/:botId/next
   */
  async next(overrideBotId?: string): Promise<string> {
    const botId = await this.resolveBotId(overrideBotId);
    try {
      const res = await this.ctx.http.post<{ message?: string }>(
        `${this.endpoint}/api/player/${encodeURIComponent(botId)}/next`,
        {},
        { headers: this.headers }
      );
      return res.message || "已跳过当前歌曲。";
    } catch (err: any) {
      return `[错误] 切歌失败: ${this.formatError(err)}`;
    }
  }

  /**
   * 上一首
   * POST /api/player/:botId/prev
   */
  async prev(overrideBotId?: string): Promise<string> {
    const botId = await this.resolveBotId(overrideBotId);
    try {
      const res = await this.ctx.http.post<{ message?: string }>(
        `${this.endpoint}/api/player/${encodeURIComponent(botId)}/prev`,
        {},
        { headers: this.headers }
      );
      return res.message || "正在播放上一首歌曲。";
    } catch (err: any) {
      return `[错误] 上一首失败: ${this.formatError(err)}`;
    }
  }

  /**
   * 停止播放
   * POST /api/player/:botId/stop
   */
  async stop(overrideBotId?: string): Promise<string> {
    const botId = await this.resolveBotId(overrideBotId);
    try {
      const res = await this.ctx.http.post<{ message?: string }>(
        `${this.endpoint}/api/player/${encodeURIComponent(botId)}/stop`,
        {},
        { headers: this.headers }
      );
      return res.message || "已停止播放。";
    } catch (err: any) {
      return `[错误] 停止失败: ${this.formatError(err)}`;
    }
  }

  /**
   * 清空队列
   * POST /api/player/:botId/clear
   */
  async clear(overrideBotId?: string): Promise<string> {
    const botId = await this.resolveBotId(overrideBotId);
    try {
      const res = await this.ctx.http.post<{ message?: string }>(
        `${this.endpoint}/api/player/${encodeURIComponent(botId)}/clear`,
        {},
        { headers: this.headers }
      );
      return res.message || "已清空播放列表。";
    } catch (err: any) {
      return `[错误] 清空失败: ${this.formatError(err)}`;
    }
  }

  /**
   * 获取当前播放队列和状态
   * GET /api/player/:botId/queue
   */
  async getQueue(overrideBotId?: string): Promise<QueueResponse> {
    const botId = await this.resolveBotId(overrideBotId);
    try {
      return await this.ctx.http.get<QueueResponse>(
        `${this.endpoint}/api/player/${encodeURIComponent(botId)}/queue`,
        { headers: this.headers }
      );
    } catch (err: any) {
      throw new Error(`获取播放列表失败: ${this.formatError(err)}`);
    }
  }

  /**
   * 获取当前播放进度秒数
   * GET /api/player/:botId/elapsed
   */
  async getElapsed(overrideBotId?: string): Promise<number> {
    const botId = await this.resolveBotId(overrideBotId);
    try {
      const res = await this.ctx.http.get<{ elapsed?: number }>(
        `${this.endpoint}/api/player/${encodeURIComponent(botId)}/elapsed`,
        { headers: this.headers }
      );
      return res.elapsed ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * 调节音量 (0-100)
   * POST /api/player/:botId/volume
   */
  async setVolume(volume: number, overrideBotId?: string): Promise<string> {
    const botId = await this.resolveBotId(overrideBotId);
    try {
      const res = await this.ctx.http.post<{ message?: string }>(
        `${this.endpoint}/api/player/${encodeURIComponent(botId)}/volume`,
        { volume },
        { headers: this.headers }
      );
      return res.message || `音量已调整为 ${volume}%`;
    } catch (err: any) {
      return `[错误] 音量调节失败: ${this.formatError(err)}`;
    }
  }

  /**
   * 设置播放模式
   * POST /api/player/:botId/mode
   */
  async setMode(mode: string, overrideBotId?: string): Promise<string> {
    const botId = await this.resolveBotId(overrideBotId);
    try {
      const res = await this.ctx.http.post<{ message?: string }>(
        `${this.endpoint}/api/player/${encodeURIComponent(botId)}/mode`,
        { mode },
        { headers: this.headers }
      );
      return res.message || `播放模式已切换为 ${mode}`;
    } catch (err: any) {
      return `[错误] 模式切换失败: ${this.formatError(err)}`;
    }
  }
}
