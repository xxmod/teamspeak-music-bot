import { spawn, type ChildProcess } from "node:child_process";
import { getFfmpegCommand } from "./player.js";
import type { Logger } from "../logger.js";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface LoudnessAnalysis {
  integratedLoudness: number; // LUFS (input_i)
  truePeak: number;           // dBFS (input_tp)
  loudnessRange: number;      // LU (input_lra)
  threshold: number;          // LUFS (input_thresh)
  targetOffset: number;       // dB
  gainDb: number;             // 推荐增益 dB
}

export interface NormalizerOptions {
  targetLufs?: number;        // 默认 -16 LUFS
  timeoutMs?: number;         // 超时毫秒数，默认 8000ms
  maxAnalyzeSeconds?: number; // 最多分析前多少秒，默认 60s
  logger?: Logger;
}

export const DEFAULT_TARGET_LUFS = -16;
export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_ANALYZE_SECONDS = 60;

/** 最大允许正向放大增益（dB），防止对极轻微噪音产生过度放大 */
export const MAX_BOOST_GAIN_DB = 12;
/** 最大允许负向衰减（dB） */
export const MAX_CUT_GAIN_DB = -15;
/** 静音阈值（LUFS）：低于此值视为纯静音，不作增益调整 */
export const SILENCE_THRESHOLD_LUFS = -70;
/** 目标安全真峰值上限（dBFS），预留 1dB 动态余量防止 D/A 转换削波 */
export const SAFE_TRUE_PEAK_LIMIT = -1.0;

/**
 * 根据测量出的 integratedLoudness 和 truePeak，计算安全的音量均衡增益（分贝）。
 */
export function calculateGainDb(
  integratedLoudness: number,
  truePeak: number,
  targetLufs: number = DEFAULT_TARGET_LUFS,
): number {
  if (!Number.isFinite(integratedLoudness) || integratedLoudness <= SILENCE_THRESHOLD_LUFS) {
    return 0;
  }

  // 达到目标 LUFS 所需的纯响度增益
  const rawGain = targetLufs - integratedLoudness;

  // 为防止音频在正向放大时出现削波破音（Digital Clipping），严格受限于安全真峰值上限
  const maxSafeGain = Number.isFinite(truePeak)
    ? SAFE_TRUE_PEAK_LIMIT - truePeak
    : rawGain;

  // 正向放大时不能超过防破音上限，负向衰减时无需受限于 maxSafeGain
  const clampedPeakGain = rawGain > 0 ? Math.min(rawGain, maxSafeGain) : rawGain;

  // 限制在安全增益区间内 [-15dB, +12dB]
  const finalGain = Math.max(MAX_CUT_GAIN_DB, Math.min(MAX_BOOST_GAIN_DB, clampedPeakGain));
  return Math.round(finalGain * 100) / 100;
}

/**
 * 构建用于 loudnorm 分析的 FFmpeg 参数
 */
export function buildAnalyzeFfmpegArgs(
  url: string,
  targetLufs: number = DEFAULT_TARGET_LUFS,
  maxAnalyzeSeconds: number = DEFAULT_MAX_ANALYZE_SECONDS,
): string[] {
  const args: string[] = [];
  const isHttp = /^https?:\/\//i.test(url);

  if (isHttp && (url.includes("bilivideo") || url.includes("bilibili"))) {
    args.push(
      "-headers",
      `Referer: https://www.bilibili.com\r\nUser-Agent: ${BROWSER_UA}\r\n`,
    );
  } else if (isHttp && (url.includes("music.126.net") || url.includes("music.163.com"))) {
    args.push(
      "-headers",
      `Referer: https://music.163.com/\r\nUser-Agent: ${BROWSER_UA}\r\n`,
    );
  }

  if (isHttp) {
    args.push(
      "-reconnect", "1",
      "-reconnect_at_eof", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-reconnect_on_network_error", "1",
      "-reconnect_on_http_error", "4xx,5xx",
    );
  }

  args.push("-i", url);

  if (maxAnalyzeSeconds > 0) {
    args.push("-t", String(maxAnalyzeSeconds));
  }

  args.push(
    "-af", `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:print_format=json`,
    "-f", "null",
    "-",
  );

  return args;
}

/**
 * 从 FFmpeg stderr 文本中解析 loudnorm 输出的 JSON
 */
export function parseLoudnormJson(stderrText: string): {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
} | null {
  const match = stderrText.match(/\{[\s\S]*?"input_i"\s*:\s*"([^"]+)"[\s\S]*?\}/);
  if (!match) return null;

  try {
    const json = JSON.parse(match[0]);
    const input_i = parseFloat(json.input_i);
    const input_tp = parseFloat(json.input_tp);
    const input_lra = parseFloat(json.input_lra);
    const input_thresh = parseFloat(json.input_thresh);
    const target_offset = parseFloat(json.target_offset);

    if (isNaN(input_i) || isNaN(input_tp)) return null;

    return {
      input_i,
      input_tp,
      input_lra: isNaN(input_lra) ? 0 : input_lra,
      input_thresh: isNaN(input_thresh) ? 0 : input_thresh,
      target_offset: isNaN(target_offset) ? 0 : target_offset,
    };
  } catch {
    return null;
  }
}

/**
 * 提前对音频 URL 或文件进行波形响度分析
 */
export async function analyzeAudioLoudness(
  url: string,
  options: NormalizerOptions = {},
): Promise<LoudnessAnalysis | null> {
  const targetLufs = options.targetLufs ?? DEFAULT_TARGET_LUFS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAnalyzeSeconds = options.maxAnalyzeSeconds ?? DEFAULT_MAX_ANALYZE_SECONDS;
  const logger = options.logger;

  const ffmpegBin = getFfmpegCommand();
  const args = buildAnalyzeFfmpegArgs(url, targetLufs, maxAnalyzeSeconds);

  return new Promise<LoudnessAnalysis | null>((resolve) => {
    let proc: ChildProcess | null = null;
    let timer: NodeJS.Timeout | null = null;
    let stderrData = "";
    let settled = false;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (proc) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
        proc = null;
      }
    };

    const finish = (result: LoudnessAnalysis | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    try {
      proc = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      logger?.warn({ err, url }, "Failed to spawn FFmpeg for loudness analysis");
      finish(null);
      return;
    }

    timer = setTimeout(() => {
      logger?.warn({ url, timeoutMs }, "FFmpeg loudness analysis timed out");
      finish(null);
    }, timeoutMs);

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrData += chunk.toString();
      // 避免 stderr 过大消耗内存
      if (stderrData.length > 50000) {
        stderrData = stderrData.slice(-50000);
      }
    });

    proc.on("error", (err) => {
      logger?.warn({ err, url }, "FFmpeg process error during loudness analysis");
      finish(null);
    });

    proc.on("exit", (code) => {
      if (code !== 0) {
        logger?.warn({ code, url }, "FFmpeg loudness analysis exited with non-zero code");
        finish(null);
        return;
      }

      const parsed = parseLoudnormJson(stderrData);
      if (!parsed) {
        logger?.warn({ url }, "Failed to parse loudnorm JSON from FFmpeg output");
        finish(null);
        return;
      }

      const gainDb = calculateGainDb(parsed.input_i, parsed.input_tp, targetLufs);
      finish({
        integratedLoudness: parsed.input_i,
        truePeak: parsed.input_tp,
        loudnessRange: parsed.input_lra,
        threshold: parsed.input_thresh,
        targetOffset: parsed.target_offset,
        gainDb,
      });
    });
  });
}
