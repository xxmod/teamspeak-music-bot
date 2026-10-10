import { Schema } from "koishi";

export interface Config {
  endpoint: string;
  apiKey?: string;
  botId?: string;
  defaultPlatform: "default" | "netease" | "qq" | "bilibili" | "kugou" | "youtube";
  enableChineseAliases: boolean;
}

export const Config: Schema<Config> = Schema.object({
  endpoint: Schema.string()
    .description("TeamSpeak 音乐机器人的 WebUI 后端地址（末尾无需加斜杠）")
    .default("http://127.0.0.1:3000"),
  apiKey: Schema.string()
    .role("secret")
    .description("WebUI 后端 API Key（若开启游客模式可留空，建议在 WebUI 后端设置-API密钥中生成并填写）")
    .default(""),
  botId: Schema.string()
    .description("目标 TS 机器人实例 ID（留空则自动选择首个在线机器人）")
    .default(""),
  defaultPlatform: Schema.union([
    Schema.const("default").description("跟随服务端默认配置"),
    Schema.const("netease").description("网易云音乐"),
    Schema.const("qq").description("QQ 音乐"),
    Schema.const("bilibili").description("哔哩哔哩"),
    Schema.const("kugou").description("酷狗音乐"),
    Schema.const("youtube").description("YouTube"),
  ])
    .description("点歌与搜索默认音源平台")
    .default("default"),
  enableChineseAliases: Schema.boolean()
    .description("是否启用常用中文别名（如「播放」、「下一首播放」、「搜索」、「暂停」等）")
    .default(true),
});

export interface Song {
  id: string;
  name: string;
  artist: string;
  album?: string;
  duration: number;
  coverUrl?: string;
  platform: string;
  requestedBy?: string;
}

export interface BotInstanceInfo {
  id: string;
  name: string;
  connected: boolean;
  channelName?: string;
  currentSong?: Song;
  state?: "idle" | "playing" | "paused";
  volume?: number;
  mode?: "sequence" | "repeat" | "random";
}

export interface QueueResponse {
  queue: Song[];
  status?: {
    connected: boolean;
    state: "idle" | "playing" | "paused";
    currentSong?: Song;
    volume: number;
    mode: "sequence" | "repeat" | "random";
    elapsed?: number;
  };
}

export interface SearchResponse {
  songs?: Song[];
  albums?: any[];
  playlists?: any[];
}
