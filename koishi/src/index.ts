import { Context } from "koishi";
import { Config, Song } from "./types.js";
import { TsmbClient } from "./client.js";

export * from "./types.js";
export * from "./client.js";

export const name = "teamspeak-music-bot";

// 格式化秒数为 mm:ss
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// 平台中文映射
const PLATFORM_NAMES: Record<string, string> = {
  netease: "网易云",
  qq: "QQ音乐",
  bilibili: "B站",
  kugou: "酷狗",
  youtube: "YouTube",
  local: "本地",
};

export function apply(ctx: Context, config: Config) {
  const client = new TsmbClient(ctx, config);

  // 会话级搜索结果缓存：sessionKey -> Song[]
  const searchCache = new Map<string, Song[]>();

  // 当前会话（群组或私聊用户）绑定的目标机器人 ID：sessionKey -> botId
  const boundBots = new Map<string, string>();

  const getSessionKey = (session: any): string => {
    return session?.channelId || session?.userId || "default";
  };

  /**
   * 获取当前会话生效的 botId：
   * 优先顺序：指令参数 -B > 当前会话手动绑定的 botId > 插件配置项中的 botId > 自动选择首个在线 bot
   */
  const getEffectiveBotId = (session: any, optionBotId?: string): string | undefined => {
    if (optionBotId) return optionBotId;
    const sessionKey = getSessionKey(session);
    return boundBots.get(sessionKey);
  };

  const getPlatformFromOptions = (options: any): string | undefined => {
    if (options?.netease) return "netease";
    if (options?.qq) return "qq";
    if (options?.bilibili) return "bilibili";
    if (options?.kugou) return "kugou";
    if (options?.youtube) return "youtube";
    return undefined;
  };

  // 0. 切换机器人 (支持两步交互「切换机器人」-> 输入数字，也支持一步「切换机器人 1」)
  const switchBotCmd = ctx
    .command("tsmb.switch [index:number]", "查看并切换当前控制的 TeamSpeak 音乐机器人")
    .alias("切换机器人")
    .alias("选择机器人")
    .action(async ({ session }, index) => {
      try {
        const bots = await client.listBots();
        if (!bots || bots.length === 0) {
          return "服务端未发现任何已配置的 TS 音乐机器人实例。";
        }

        const sessionKey = getSessionKey(session);

        // 1. 若用户直接输入了数字序号，如「切换机器人 1」
        if (index !== undefined) {
          if (index < 1 || index > bots.length) {
            return `[错误] 无效的序号，请输入 1 到 ${bots.length} 之间的数字。`;
          }
          const selected = bots[index - 1];
          boundBots.set(sessionKey, selected.id);
          const channelInfo = selected.channelName ? ` (频道: ${selected.channelName})` : "";
          return `[成功] 已切换当前控制机器人为: [${selected.name}]${channelInfo}`;
        }

        // 2. 用户仅输入「切换机器人」，列出列表并等待用户输入序号
        const currentBoundId = boundBots.get(sessionKey);
        const lines = ["请输入数字序号选择要切换的机器人:"];
        bots.forEach((b, i) => {
          const status = b.connected ? "[在线]" : "[离线]";
          const isCurrent = b.id === currentBoundId || (!currentBoundId && i === 0);
          const tag = isCurrent ? " <- [当前控制]" : "";
          let item = `${i + 1}. [${b.name}] - ${status}${tag}`;
          if (b.channelName) item += ` (频道: ${b.channelName})`;
          lines.push(item);
        });
        lines.push("\n提示: 请直接发送数字序号（如 1）完成切换，输入其他内容或 30 秒无操作将自动取消。");

        if (!session) {
          return lines.join("\n");
        }

        await session.send(lines.join("\n"));

        // 等待当前用户在当前频道的下一个输入
        const reply = await session.prompt(30000);
        if (!reply || !reply.trim()) {
          return "[提示] 等待超时，已取消机器人切换。";
        }

        const selectedIdx = parseInt(reply.trim(), 10);
        if (isNaN(selectedIdx) || selectedIdx < 1 || selectedIdx > bots.length) {
          return "[错误] 输入的序号无效，已取消切换。";
        }

        const selected = bots[selectedIdx - 1];
        boundBots.set(sessionKey, selected.id);
        const channelInfo = selected.channelName ? ` (频道: ${selected.channelName})` : "";
        return `[成功] 切换完成！当前控制机器人: [${selected.name}]${channelInfo}`;
      } catch (err: any) {
        return `[错误] 获取机器人列表失败: ${err.message}`;
      }
    });

  // 1. 点歌 / 播放 (对应 !play)
  const playCmd = ctx
    .command("tsmb.play <query:text>", "在 TeamSpeak 中点歌播放")
    .option("bot", "-B <botId:string> 指定机器人 ID")
    .option("netease", "-n 使用网易云源")
    .option("qq", "-q 使用 QQ 音乐源")
    .option("bilibili", "-b 使用哔哩哔哩源")
    .option("kugou", "-k 使用酷狗音乐源")
    .option("youtube", "-y 使用 YouTube 源")
    .action(async ({ session, options }, query) => {
      if (!query || !query.trim()) {
        return "请输入歌曲名，例如：播放 晴天 或 播放 -q 周杰伦";
      }

      const q = query.trim();
      const sessionKey = getSessionKey(session);
      const cached = searchCache.get(sessionKey);
      const targetBot = getEffectiveBotId(session, options?.bot);

      // 若输入为纯数字且命中刚才的搜索缓存
      const index = parseInt(q, 10);
      if (!isNaN(index) && cached && index >= 1 && index <= cached.length) {
        const song = cached[index - 1];
        const platform = song.platform;
        return await client.play(`${song.name} ${song.artist}`, platform, targetBot);
      }

      const platform = getPlatformFromOptions(options);
      return await client.play(q, platform, targetBot);
    });

  // 2. 下一首播放 / 插播 (对应 !playnext)
  const playNextCmd = ctx
    .command("tsmb.playnext <query:text>", "将歌曲加入下一首优先播放（插播）")
    .option("bot", "-B <botId:string> 指定机器人 ID")
    .option("netease", "-n 使用网易云源")
    .option("qq", "-q 使用 QQ 音乐源")
    .option("bilibili", "-b 使用哔哩哔哩源")
    .option("kugou", "-k 使用酷狗音乐源")
    .option("youtube", "-y 使用 YouTube 源")
    .action(async ({ session, options }, query) => {
      if (!query || !query.trim()) {
        return "请输入要插播的歌曲名，例如：下一首播放 稻香";
      }

      const q = query.trim();
      const sessionKey = getSessionKey(session);
      const cached = searchCache.get(sessionKey);
      const targetBot = getEffectiveBotId(session, options?.bot);

      // 1. 若输入为搜索结果的数字序号
      const index = parseInt(q, 10);
      if (!isNaN(index) && cached && index >= 1 && index <= cached.length) {
        const song = cached[index - 1];
        return await client.playNextSong(song, targetBot);
      }

      // 2. 否则通过原生搜索接口检索出该歌曲
      const platform = getPlatformFromOptions(options);
      try {
        const songs = await client.search(q, platform, 1);
        if (!songs || songs.length === 0) {
          return `[错误] 未找到关于「${q}」的歌曲，请更换关键词重试。`;
        }
        const targetSong = songs[0];
        return await client.playNextSong(targetSong, targetBot);
      } catch (err: any) {
        return `[错误] 插播检索失败: ${err.message}`;
      }
    });

  // 3. 搜索歌曲 (对应 !search)
  const searchCmd = ctx
    .command("tsmb.search <query:text>", "搜索歌曲列表")
    .option("netease", "-n 使用网易云源")
    .option("qq", "-q 使用 QQ 音乐源")
    .option("bilibili", "-b 使用哔哩哔哩源")
    .option("kugou", "-k 使用酷狗音乐源")
    .option("youtube", "-y 使用 YouTube 源")
    .action(async ({ session, options }, query) => {
      if (!query || !query.trim()) {
        return "请输入要搜索的关键词，例如：搜索 晴天";
      }

      const platform = getPlatformFromOptions(options);
      try {
        const songs = await client.search(query.trim(), platform, 5);
        if (!songs || songs.length === 0) {
          return `未找到关于「${query}」的歌曲。`;
        }

        const sessionKey = getSessionKey(session);
        searchCache.set(sessionKey, songs);

        const platLabel = platform ? (PLATFORM_NAMES[platform] || platform) : "默认音源";
        const lines = [`搜索结果 [${platLabel}]:`];
        songs.forEach((s, i) => {
          const duration = s.duration ? ` (${formatTime(s.duration)})` : "";
          const album = s.album ? ` [${s.album}]` : "";
          lines.push(`${i + 1}. ${s.name} - ${s.artist}${album}${duration}`);
        });
        lines.push("\n提示: 直接发送「播放 1」点歌，或发送「下一首播放 1」插播。");
        return lines.join("\n");
      } catch (err: any) {
        return `[错误] ${err.message}`;
      }
    });

  // 4. 加歌（仅加入队尾）
  const addCmd = ctx
    .command("tsmb.add <query:text>", "将歌曲加入播放列表末尾")
    .option("bot", "-B <botId:string> 指定机器人 ID")
    .option("netease", "-n 使用网易云源")
    .option("qq", "-q 使用 QQ 音乐源")
    .option("bilibili", "-b 使用哔哩哔哩源")
    .option("kugou", "-k 使用酷狗音乐源")
    .option("youtube", "-y 使用 YouTube 源")
    .action(async ({ session, options }, query) => {
      if (!query || !query.trim()) {
        return "请输入歌曲名，例如：加歌 七里香";
      }
      const platform = getPlatformFromOptions(options);
      const targetBot = getEffectiveBotId(session, options?.bot);
      return await client.add(query.trim(), platform, targetBot);
    });

  // 5. 暂停
  const pauseCmd = ctx
    .command("tsmb.pause", "暂停播放")
    .option("bot", "-B <botId:string> 指定机器人 ID")
    .action(async ({ session, options }) => client.pause(getEffectiveBotId(session, options?.bot)));

  // 6. 恢复 / 继续
  const resumeCmd = ctx
    .command("tsmb.resume", "恢复播放")
    .option("bot", "-B <botId:string> 指定机器人 ID")
    .action(async ({ session, options }) => client.resume(getEffectiveBotId(session, options?.bot)));

  // 7. 切歌 / 下一首
  const nextCmd = ctx
    .command("tsmb.next", "切歌（跳过当前歌曲）")
    .option("bot", "-B <botId:string> 指定机器人 ID")
    .action(async ({ session, options }) => client.next(getEffectiveBotId(session, options?.bot)));

  // 8. 上一首
  const prevCmd = ctx
    .command("tsmb.prev", "播放上一首歌曲")
    .option("bot", "-B <botId:string> 指定机器人 ID")
    .action(async ({ session, options }) => client.prev(getEffectiveBotId(session, options?.bot)));

  // 9. 停止
  const stopCmd = ctx
    .command("tsmb.stop", "停止播放")
    .option("bot", "-B <botId:string> 指定机器人 ID")
    .action(async ({ session, options }) => client.stop(getEffectiveBotId(session, options?.bot)));

  // 10. 清空列表
  const clearCmd = ctx
    .command("tsmb.clear", "清空播放列表队列")
    .option("bot", "-B <botId:string> 指定机器人 ID")
    .action(async ({ session, options }) => client.clear(getEffectiveBotId(session, options?.bot)));

  // 11. 正在播放
  const nowCmd = ctx
    .command("tsmb.now", "查看当前正在播放的曲目")
    .option("bot", "-B <botId:string> 指定机器人 ID")
    .action(async ({ session, options }) => {
      try {
        const targetBot = getEffectiveBotId(session, options?.bot);
        const queueRes = await client.getQueue(targetBot);
        const status = queueRes.status;
        if (!status || status.state === "idle" || !status.currentSong) {
          return "当前没有正在播放的歌曲。";
        }

        const song = status.currentSong;
        const elapsed = await client.getElapsed(targetBot);
        const elapsedStr = formatTime(elapsed);
        const totalStr = song.duration ? formatTime(song.duration) : "--:--";
        const stateLabel = status.state === "playing" ? "正在播放" : "已暂停";
        const platformName = PLATFORM_NAMES[song.platform] || song.platform;

        const lines = [
          `[${stateLabel}] [${platformName}]`,
          `歌名: ${song.name}`,
          `歌手: ${song.artist}`,
          `进度: [${elapsedStr} / ${totalStr}]`,
          `音量: ${status.volume ?? 50}% | 模式: ${status.mode ?? "sequence"}`,
        ];
        if (song.requestedBy) {
          lines.push(`点歌人: ${song.requestedBy}`);
        }
        return lines.join("\n");
      } catch (err: any) {
        return `[错误] ${err.message}`;
      }
    });

  // 12. 播放列表
  const queueCmd = ctx
    .command("tsmb.queue", "查看当前播放队列")
    .option("bot", "-B <botId:string> 指定机器人 ID")
    .action(async ({ session, options }) => {
      try {
        const targetBot = getEffectiveBotId(session, options?.bot);
        const queueRes = await client.getQueue(targetBot);
        const queue = queueRes.queue;
        if (!queue || queue.length === 0) {
          return "当前播放队列为空。";
        }

        const lines = [`播放队列 (共 ${queue.length} 首):`];
        queue.slice(0, 10).forEach((s, i) => {
          const plat = PLATFORM_NAMES[s.platform] ? `[${PLATFORM_NAMES[s.platform]}] ` : "";
          const dur = s.duration ? ` (${formatTime(s.duration)})` : "";
          const req = s.requestedBy ? ` 由 ${s.requestedBy} 点播` : "";
          lines.push(`${i + 1}. ${plat}${s.name} - ${s.artist}${dur}${req}`);
        });

        if (queue.length > 10) {
          lines.push(`... 还有 ${queue.length - 10} 首歌曲`);
        }
        return lines.join("\n");
      } catch (err: any) {
        return `[错误] ${err.message}`;
      }
    });

  // 13. 调整音量
  const volCmd = ctx
    .command("tsmb.vol [volume:number]", "调节播放音量 (0-100)")
    .option("bot", "-B <botId:string> 指定机器人 ID")
    .action(async ({ session, options }, volume) => {
      const targetBot = getEffectiveBotId(session, options?.bot);
      if (volume === undefined) {
        const queueRes = await client.getQueue(targetBot);
        return `当前音量: ${queueRes.status?.volume ?? 50}%`;
      }
      const v = Math.max(0, Math.min(100, volume));
      return await client.setVolume(v, targetBot);
    });

  // 14. 切换播放模式
  const modeCmd = ctx
    .command("tsmb.mode [mode:string]", "设置播放模式 (sequence:顺序 / repeat:单曲循环 / random:随机)")
    .option("bot", "-B <botId:string> 指定机器人 ID")
    .action(async ({ session, options }, mode) => {
      if (!mode) {
        return "请指定播放模式: sequence (顺序播放)、repeat (单曲循环)、random (随机播放)";
      }
      const targetBot = getEffectiveBotId(session, options?.bot);
      return await client.setMode(mode.toLowerCase(), targetBot);
    });

  // 15. 查看机器人列表
  ctx
    .command("tsmb.status", "查看 TeamSpeak 音乐机器人列表与状态")
    .alias("tsmb状态")
    .alias("音乐机器人状态")
    .action(async () => {
      try {
        const bots = await client.listBots();
        if (!bots || bots.length === 0) {
          return "服务端未发现任何已配置的 TS 音乐机器人。";
        }
        const lines = ["TeamSpeak 音乐机器人实例列表:"];
        for (const b of bots) {
          const status = b.connected ? "[在线]" : "[离线]";
          let info = `- [${b.name}] (ID: ${b.id}) - ${status}`;
          if (b.channelName) info += ` | 频道: ${b.channelName}`;
          if (b.currentSong) info += `\n  - 正在播放: ${b.currentSong.name} - ${b.currentSong.artist}`;
          lines.push(info);
        }
        return lines.join("\n");
      } catch (err: any) {
        return `[错误] ${err.message}`;
      }
    });

  // 注册常用中文快捷别名
  if (config.enableChineseAliases) {
    playCmd.alias("播放").alias("点歌");
    playNextCmd.alias("下一首播放").alias("插播");
    searchCmd.alias("搜索");
    addCmd.alias("加歌");
    pauseCmd.alias("暂停");
    resumeCmd.alias("继续").alias("恢复");
    nextCmd.alias("切歌").alias("下一首").alias("跳过");
    prevCmd.alias("上一首");
    stopCmd.alias("停止");
    clearCmd.alias("清空列表").alias("清空队列");
    nowCmd.alias("正在播放").alias("当前播放");
    queueCmd.alias("播放列表").alias("查看队列").alias("歌单");
    volCmd.alias("音量");
    modeCmd.alias("播放模式");
  }
}
