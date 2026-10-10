import crypto from "node:crypto";
import axios, { type AxiosInstance } from "axios";
import type {
  MusicProvider,
  Song,
  SongUrlResult,
  Playlist,
  PlaylistDetail,
  LyricLine,
  SearchResult,
  QrCodeResult,
  AuthStatus,
  Album,
  Artist,
  ArtistDetail,
  ArtistSongPage,
} from "./provider.js";

export function parseLyrics(lrc: string, tlyric?: string): LyricLine[] {
  if (!lrc) return [];

  const parseLine = (
    line: string
  ): { time: number; text: string } | null => {
    const match = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\](.+)$/);
    if (!match) return null;
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    const ms = parseInt(match[3].padEnd(3, "0"), 10);
    const text = match[4].trim();

    if (/^(作词|作曲|编曲|制作|混音|母带)\s*[:：]/.test(text)) return null;

    return { time: minutes * 60 + seconds + ms / 1000, text };
  };

  const lines: LyricLine[] = [];
  const translationMap = new Map<number, string>();

  if (tlyric) {
    for (const line of tlyric.split("\n")) {
      const parsed = parseLine(line);
      if (parsed) {
        translationMap.set(Math.round(parsed.time * 100), parsed.text);
      }
    }
  }

  for (const line of lrc.split("\n")) {
    const parsed = parseLine(line);
    if (parsed) {
      const timeKey = Math.round(parsed.time * 100);
      lines.push({
        time: parsed.time,
        text: parsed.text,
        translation: translationMap.get(timeKey),
      });
    }
  }

  return lines.sort((a, b) => a.time - b.time);
}

export function mapNeteaseAlbums(raw: any[] | null | undefined): Album[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => ({
    id: String(a.id),
    name: a.name ?? "",
    artist: (a.artists ?? []).map((x: any) => x.name).join(" / "),
    coverUrl: a.picUrl ?? "",
    songCount: a.size ?? 0,
    platform: "netease",
  }));
}

export function mapNeteaseArtists(raw: any[] | null | undefined): Artist[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a: any) => ({
    id: String(a.id),
    name: a.name ?? "",
    avatarUrl: a.picUrl ?? a.img1v1Url ?? "",
    aliases: (a.alias ?? a.alia ?? []).filter(
      (x: unknown): x is string => typeof x === "string" && x.length > 0
    ),
    songCount: a.musicSize ?? undefined,
    albumCount: a.albumSize ?? undefined,
    platform: "netease",
  }));
}

export function mapNeteaseSongs(raw: any[] | null | undefined): Song[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s: any) => ({
    id: String(s.id),
    name: s.name,
    artist: (s.ar ?? s.artists ?? []).map((a: any) => a.name).join(" / "),
    album: s.al?.name ?? s.album?.name ?? "",
    duration: Math.round((s.dt ?? s.duration ?? 0) / 1000),
    coverUrl: s.al?.picUrl ?? s.album?.picUrl ?? "",
    platform: "netease",
    // fee: 0=free, 1=VIP, 4=album-only, 8=free low-quality (plays in full, NOT vip)
    vip: s.fee === 1 || s.fee === 4,
  }));
}

/** 解析网易云 freeTrialInfo → 试听秒数；无片段（VIP/免费）返回 undefined。
 *  真实字段 {start,end} 单位秒；容忍 begin/trialBegin 别名 + 毫秒兜底（end>1000）。 */
export function parseNeteaseTrial(item: any): number | undefined {
  const t = item?.freeTrialInfo;
  if (!t || typeof t !== "object") return undefined;
  const start = Number(t.start ?? t.begin ?? t.trialBegin ?? 0);
  const end = Number(t.end ?? t.trialEnd);
  if (!Number.isFinite(end) || end <= start) return undefined;
  const secs = end > 1000 ? (end - start) / 1000 : end - start;
  return Math.round(secs);
}

const NETEASE_EAPI_KEY = Buffer.from("e82ckenh8dichen8");

export function encryptNeteaseEapi(url: string, object: unknown): string {
  const text = typeof object === "object" ? JSON.stringify(object) : String(object);
  const message = `nobody${url}use${text}md5forencrypt`;
  const digest = crypto.createHash("md5").update(message).digest("hex");
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  const cipher = crypto.createCipheriv("aes-128-ecb", NETEASE_EAPI_KEY, null);
  return cipher.update(data, "utf8", "hex") + cipher.final("hex");
}

export function parseNeteaseCookie(cookie?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookie) return result;
  for (const part of cookie.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (key) result[key] = val;
    }
  }
  return result;
}

// NetEase quality levels: standard(128k) higher(192k) exhigh(320k) lossless(flac) hires(hi-res) jyeffect jymaster
export const NETEASE_QUALITY_LEVELS = [
  { value: "standard", label: "标准 (128kbps)", bitrate: 128 },
  { value: "higher", label: "较高 (192kbps)", bitrate: 192 },
  { value: "exhigh", label: "极高 (320kbps)", bitrate: 320 },
  { value: "lossless", label: "无损 (FLAC)", bitrate: 900 },
  { value: "hires", label: "Hi-Res", bitrate: 1500 },
  { value: "jymaster", label: "超清母带", bitrate: 4000 },
] as const;

export class NeteaseProvider implements MusicProvider {
  readonly platform = "netease" as const;
  private api: AxiosInstance;
  private clientlogClient: AxiosInstance;
  private cookie = "";
  private quality = "exhigh";
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.api = axios.create({
      baseURL: baseUrl,
      timeout: 10000,
    });
    this.clientlogClient = axios.create({
      baseURL: "https://clientlog.music.163.com",
      timeout: 10000,
    });
  }

  setQuality(quality: string): void {
    this.quality = quality;
  }

  getQuality(): string {
    return this.quality;
  }

  private get cookieParams(): Record<string, string> {
    return this.cookie ? { cookie: this.cookie } : {};
  }

  private getCookieParams(cookieOverride?: string): Record<string, string> {
    const c = cookieOverride !== undefined ? cookieOverride : this.cookie;
    return c ? { cookie: c } : {};
  }

  async search(query: string, limit = 20, offset = 0): Promise<SearchResult> {
    // /cloudsearch supports offset for every type. Songs, playlists (type 1000)
    // and albums (type 10) are all limit/offset-driven so the web can page past
    // the first page (playlists/albums were previously hardcoded to limit: 10).
    const [songRes, playlistRes, albumRes, artistRes] = await Promise.all([
      this.api.get("/cloudsearch", {
        params: { keywords: query, type: 1, limit, offset, ...this.cookieParams },
      }),
      this.api.get("/cloudsearch", {
        params: {
          keywords: query,
          type: 1000,
          limit,
          offset,
          ...this.cookieParams,
        },
      }),
      this.api.get("/cloudsearch", {
        params: { keywords: query, type: 10, limit, offset, ...this.cookieParams },
      }),
      this.api.get("/cloudsearch", {
        params: { keywords: query, type: 100, limit, offset, ...this.cookieParams },
      }),
    ]);

    const songs: Song[] = mapNeteaseSongs(songRes.data?.result?.songs);

    const playlists: Playlist[] = (
      playlistRes.data?.result?.playlists ?? []
    ).map((p: any) => ({
      id: String(p.id),
      name: p.name,
      coverUrl: p.coverImgUrl ?? "",
      songCount: p.trackCount ?? 0,
      platform: "netease",
    }));

    const albums = mapNeteaseAlbums(albumRes.data?.result?.albums);

    const artists = mapNeteaseArtists(artistRes.data?.result?.artists);

    return { songs, playlists, albums, artists };
  }

  async getSongUrl(songId: string, quality?: string): Promise<SongUrlResult | null> {
    const level = quality ?? this.quality;
    const res = await this.api.get("/song/url/v1", {
      params: { id: songId, level, ...this.cookieParams },
    });
    const item = res.data?.data?.[0];
    const url = item?.url;
    if (!url) return null;
    return { url, trialDuration: parseNeteaseTrial(item) };
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    const res = await this.api.get("/song/detail", {
      params: { ids: songId, ...this.cookieParams },
    });
    return mapNeteaseSongs(res.data?.songs)[0] ?? null;
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    const res = await this.api.get("/playlist/track/all", {
      params: { id: playlistId, ...this.cookieParams },
    });
    return mapNeteaseSongs(res.data?.songs);
  }

  async getRecommendPlaylists(cookieOverride?: string): Promise<Playlist[]> {
    const res = await this.api.get("/personalized", {
      params: { limit: 10, ...this.getCookieParams(cookieOverride) },
    });
    return (res.data?.result ?? []).map((p: any) => ({
      id: String(p.id),
      name: p.name,
      coverUrl: p.picUrl ?? "",
      songCount: p.trackCount ?? 0,
      platform: "netease",
    }));
  }

  async getAlbumSongs(albumId: string): Promise<Song[]> {
    const res = await this.api.get("/album", {
      params: { id: albumId, ...this.cookieParams },
    });
    return mapNeteaseSongs(res.data?.songs);
  }

  async getArtistDetail(artistId: string): Promise<ArtistDetail | null> {
    // /artists returns { artist, hotSongs }; the hot songs are fetched
    // separately via /artist/songs (order=hot) so the artist page's three
    // upstream calls stay independent of each other.
    const res = await this.api.get("/artists", {
      params: { id: artistId, ...this.cookieParams },
    });
    const a = res.data?.artist;
    if (!a) return null;
    return {
      ...mapNeteaseArtists([a])[0],
      description: a.briefDesc ?? "",
    };
  }

  async getArtistSongs(artistId: string, limit = 50): Promise<Song[]> {
    const res = await this.api.get("/artist/songs", {
      params: {
        id: artistId,
        limit,
        offset: 0,
        order: "hot",
        ...this.cookieParams,
      },
    });
    return mapNeteaseSongs(res.data?.songs);
  }

  async getArtistAlbums(artistId: string, limit = 20): Promise<Album[]> {
    const res = await this.api.get("/artist/album", {
      params: { id: artistId, limit, offset: 0, ...this.cookieParams },
    });
    return mapNeteaseAlbums(res.data?.hotAlbums);
  }

  /**
   * Full catalogue page for the artist page's "全部歌曲" list: /artist/songs
   * supports real offset paging (Adele reports total 345 with more=true, and
   * offset=50/100/150 each return a fresh slice of 50). order=hot keeps the page
   * ordering identical to getArtistSongs so the hot preview and the full list
   * are one continuous ranking.
   */
  async getArtistAllSongs(artistId: string, offset = 0, limit = 50): Promise<ArtistSongPage> {
    const safeOffset = Math.max(0, Math.trunc(offset) || 0);
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 50, 100));
    const res = await this.api.get("/artist/songs", {
      params: {
        id: artistId,
        limit: safeLimit,
        offset: safeOffset,
        order: "hot",
        ...this.cookieParams,
      },
    });
    const songs = mapNeteaseSongs(res.data?.songs);
    const reported = Number(res.data?.total);
    const total = Number.isFinite(reported) && reported > 0 ? reported : safeOffset + songs.length;
    const more = res.data?.more;
    const hasMore =
      typeof more === "boolean" ? more : safeOffset + songs.length < total;
    return { songs, total, hasMore };
  }

  async getLyrics(songId: string): Promise<LyricLine[]> {
    const res = await this.api.get("/lyric", {
      params: { id: songId, ...this.cookieParams },
    });
    return parseLyrics(
      res.data?.lrc?.lyric ?? "",
      res.data?.tlyric?.lyric
    );
  }

  async getQrCode(): Promise<QrCodeResult> {
    const keyRes = await this.api.get("/login/qr/key", {
      params: { timestamp: Date.now() },
    });
    const key = keyRes.data?.data?.unikey ?? "";
    const createRes = await this.api.get("/login/qr/create", {
      params: { key, qrimg: true },
    });
    return {
      qrUrl: createRes.data?.data?.qrurl ?? "",
      qrImg: createRes.data?.data?.qrimg ?? "",
      key,
    };
  }

  async checkQrCodeStatus(
    key: string
  ): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    const res = await this.api.get("/login/qr/check", {
      params: { key, timestamp: Date.now() },
    });
    const code = res.data?.code;
    switch (code) {
      case 801:
        return "waiting";
      case 802:
        return "scanned";
      case 803:
        if (res.data?.cookie) {
          this.cookie = res.data.cookie;
        }
        return "confirmed";
      default:
        return "expired";
    }
  }

  async checkQrCodeForCookie(
    key: string
  ): Promise<{ status: "waiting" | "scanned" | "confirmed" | "expired"; cookie?: string }> {
    const res = await this.api.get("/login/qr/check", {
      params: { key, timestamp: Date.now() },
    });
    const code = res.data?.code;
    switch (code) {
      case 801:
        return { status: "waiting" };
      case 802:
        return { status: "scanned" };
      case 803:
        return { status: "confirmed", cookie: res.data?.cookie || "" };
      default:
        return { status: "expired" };
    }

  }

  async sendSmsCode(phone: string): Promise<boolean> {
    const res = await this.api.get("/captcha/sent", {
      params: { phone },
    });
    return res.data?.code === 200;
  }

  async loginWithSms(phone: string, code: string): Promise<boolean> {
    const res = await this.api.get("/captcha/verify", {
      params: { phone, captcha: code },
    });
    if (res.data?.cookie) {
      this.cookie = res.data.cookie;
    }
    return res.data?.code === 200;
  }

  setCookie(cookie: string): void {
    this.cookie = cookie;
  }

  getCookie(): string {
    return this.cookie;
  }

  async getAuthStatus(): Promise<AuthStatus> {
    if (!this.cookie) return { loggedIn: false };
    try {
      const res = await this.api.get("/login/status", {
        params: { ...this.cookieParams },
      });
      const profile = res.data?.data?.profile;
      if (profile) {
        return {
          loggedIn: true,
          nickname: profile.nickname,
          avatarUrl: profile.avatarUrl,
        };
      }
    } catch {
      // ignore
    }
    return { loggedIn: false };
  }

  async getPersonalFm(cookieOverride?: string): Promise<Song[]> {
    const res = await this.api.get("/personal_fm", {
      params: { timestamp: Date.now(), ...this.getCookieParams(cookieOverride) },
    });
    return mapNeteaseSongs(res.data?.data);
  }

  async getDailyRecommendSongs(cookieOverride?: string): Promise<Song[]> {
    const res = await this.api.get("/recommend/songs", {
      params: { ...this.getCookieParams(cookieOverride) },
    });
    return mapNeteaseSongs(res.data?.data?.dailySongs);
  }

  async getPlaylistDetail(playlistId: string): Promise<PlaylistDetail | null> {
    const res = await this.api.get("/playlist/detail", {
      params: { id: playlistId, ...this.cookieParams },
    });
    const p = res.data?.playlist;
    if (!p) return null;
    return {
      id: String(p.id),
      name: p.name ?? "",
      description: p.description ?? "",
      coverUrl: p.coverImgUrl ?? "",
      songCount: p.trackCount ?? 0,
    };
  }

  async getUserPlaylists(cookieOverride?: string): Promise<Playlist[]> {
    const params = this.getCookieParams(cookieOverride);
    // First get user ID from login status
    const statusRes = await this.api.get("/login/status", {
      params,
    });
    const uid = statusRes.data?.data?.profile?.userId;
    if (!uid) return [];

    const res = await this.api.get("/user/playlist", {
      params: { uid, ...params },
    });
    return (res.data?.playlist ?? []).map((p: any) => ({
      id: String(p.id),
      name: p.name,
      coverUrl: p.coverImgUrl ?? "",
      songCount: p.trackCount ?? 0,
      platform: "netease",
      editable: !p.subscribed,
    }));
  }

  async likeSong(songId: string, like = true, cookieOverride?: string): Promise<boolean> {
    const params = this.getCookieParams(cookieOverride);
    const res = await this.api.get("/like", {
      params: { id: songId, like, ...params },
    });
    return res.data?.code === 200;
  }

  async addSongToPlaylist(playlistId: string, songId: string, cookieOverride?: string): Promise<boolean> {
    const params = this.getCookieParams(cookieOverride);
    const res = await this.api.get("/playlist/tracks", {
      params: { op: "add", pid: playlistId, tracks: songId, ...params },
    });
    return res.data?.body?.code === 200 || res.data?.code === 200;
  }

  async scrobble(songId: string, timeSec: number, cookieOverride?: string): Promise<boolean> {
    try {
      const rawCookie = cookieOverride !== undefined ? cookieOverride : this.cookie;
      const cookieObj = parseNeteaseCookie(rawCookie);
      const musicU = cookieObj.MUSIC_U;
      if (!musicU) {
        return false;
      }

      const id = String(songId || "");
      if (!/^\d+$/.test(id)) {
        return false;
      }

      const time = Math.max(1, Math.round(timeSec));
      const now = Date.now();
      const deviceId = crypto.randomBytes(16).toString("hex");

      const header: Record<string, string> = {
        osver: "15.5",
        deviceId,
        os: "osx",
        appver: "3.1.10.5100",
        versioncode: "140",
        mobilename: "",
        buildver: String(now).slice(0, 10),
        resolution: "1920x1080",
        __csrf: cookieObj.__csrf || "",
        channel: "netease",
        requestId: `${now}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
        MUSIC_U: musicU,
      };

      const cookieHeader = Object.entries(header)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("; ");

      const headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: "https://clientlog.music.163.com",
        Cookie: cookieHeader,
      };

      const base = {
        id,
        type: "song",
        mainsite: "1",
        mainsiteWeb: "1",
        content: "id=0",
      };

      // 1) startplay: 写入「最近播放」
      const startplayData = {
        logs: JSON.stringify([{ action: "startplay", json: base }]),
        e_r: false,
        header,
      };
      const startEncrypted = encryptNeteaseEapi("/api/feedback/weblog", startplayData);
      const startRes = await this.clientlogClient.post(
        "/eapi/feedback/weblog",
        new URLSearchParams({ params: startEncrypted }).toString(),
        { headers },
      );

      // 2) play: 累计播放时长与「听歌排行」
      const playData = {
        logs: JSON.stringify([
          {
            action: "play",
            json: {
              ...base,
              download: 0,
              end: "playend",
              sourceId: "0",
              time,
              wifi: 0,
              source: "list",
            },
          },
        ]),
        e_r: false,
        header,
      };
      const playEncrypted = encryptNeteaseEapi("/api/feedback/weblog", playData);
      const playRes = await this.clientlogClient.post(
        "/eapi/feedback/weblog",
        new URLSearchParams({ params: playEncrypted }).toString(),
        { headers },
      );

      const startOk = startRes.data?.code === 200 || startRes.status === 200;
      const playOk = playRes.data?.code === 200 || playRes.status === 200;
      return Boolean(startOk && playOk);
    } catch {
      return false;
    }
  }
}
