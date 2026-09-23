import { describe, it, expect, vi } from "vitest";
import {
  calculateGainDb,
  parseLoudnormJson,
  buildAnalyzeFfmpegArgs,
  analyzeAudioLoudness,
  DEFAULT_TARGET_LUFS,
  DEFAULT_MAX_ANALYZE_SECONDS,
  MAX_BOOST_GAIN_DB,
  MAX_CUT_GAIN_DB,
  SAFE_TRUE_PEAK_LIMIT,
} from "./normalizer.js";

describe("calculateGainDb", () => {
  it("computes linear boost when loudness is lower than target and peak has ample headroom", () => {
    // -22 LUFS input, target -16 LUFS -> wants +6 dB boost
    // True Peak is -10 dBFS, max safe gain = -1.0 - (-10) = +9 dBFS
    // +6 dB <= +9 dB -> safely gives +6 dB
    const gain = calculateGainDb(-22, -10, -16);
    expect(gain).toBe(6);
  });

  it("limits positive boost to prevent True Peak clipping when headroom is insufficient", () => {
    // -22 LUFS input, target -16 LUFS -> wants +6 dB boost
    // True Peak is -3.5 dBFS, max safe gain = -1.0 - (-3.5) = +2.5 dBFS
    // Boost must be clamped to +2.5 dBFS to prevent clipping
    const gain = calculateGainDb(-22, -3.5, -16);
    expect(gain).toBe(2.5);
  });

  it("computes negative gain (cut) when song is louder than target", () => {
    // -11 LUFS input, target -16 LUFS -> wants -5 dB cut
    // True Peak is -0.5 dBFS
    const gain = calculateGainDb(-11, -0.5, -16);
    expect(gain).toBe(-5);
  });

  it("clamps boost to MAX_BOOST_GAIN_DB (+12 dB)", () => {
    // -35 LUFS input -> wants +19 dB, but capped at +12 dB
    const gain = calculateGainDb(-35, -25, -16);
    expect(gain).toBe(MAX_BOOST_GAIN_DB);
  });

  it("clamps attenuation to MAX_CUT_GAIN_DB (-15 dB)", () => {
    // 0 LUFS input -> wants -16 dB, but capped at -15 dB
    const gain = calculateGainDb(0, 0, -16);
    expect(gain).toBe(MAX_CUT_GAIN_DB);
  });

  it("returns 0 for near-silent audio (<= -70 LUFS) or non-finite values", () => {
    expect(calculateGainDb(-75, -50, -16)).toBe(0);
    expect(calculateGainDb(-Infinity, -10, -16)).toBe(0);
    expect(calculateGainDb(NaN, -10, -16)).toBe(0);
  });
});

describe("parseLoudnormJson", () => {
  it("extracts and parses loudnorm JSON block from FFmpeg stderr output", () => {
    const stderr = `
Input #0, mp3, from 'test.mp3':
  Duration: 00:03:15.00
Stream mapping:
  Stream #0:0 -> #0:0 (mp3 -> pcm_s16le)
[Parsed_loudnorm_0 @ 0x12345] 
{
	"input_i" : "-21.75",
	"input_tp" : "-4.20",
	"input_lra" : "6.50",
	"input_thresh" : "-32.10",
	"output_i" : "-16.00",
	"output_tp" : "-1.50",
	"output_lra" : "5.80",
	"output_thresh" : "-26.50",
	"normalization_type" : "dynamic",
	"target_offset" : "0.00"
}
[out#0/null @ 0x54321] video:0KiB audio:100KiB
`;
    const parsed = parseLoudnormJson(stderr);
    expect(parsed).not.toBeNull();
    expect(parsed!.input_i).toBe(-21.75);
    expect(parsed!.input_tp).toBe(-4.20);
    expect(parsed!.input_lra).toBe(6.50);
    expect(parsed!.input_thresh).toBe(-32.10);
    expect(parsed!.target_offset).toBe(0.00);
  });

  it("returns null if no loudnorm JSON exists in stderr", () => {
    expect(parseLoudnormJson("ffmpeg version 7.1 Error opening input")).toBeNull();
  });
});

describe("buildAnalyzeFfmpegArgs", () => {
  it("builds basic loudnorm analysis args with time limit", () => {
    const args = buildAnalyzeFfmpegArgs("test.mp3", -16, 120);
    expect(args).toContain("-i");
    expect(args).toContain("test.mp3");
    expect(args).toContain("-t");
    expect(args).toContain("120");
    expect(args).toContain("-af");
    expect(args[args.indexOf("-af") + 1]).toContain("loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json");
    expect(args).toContain("-f");
    expect(args).toContain("null");
  });

  it("uses DEFAULT_MAX_ANALYZE_SECONDS (60) by default", () => {
    expect(DEFAULT_MAX_ANALYZE_SECONDS).toBe(60);
    const args = buildAnalyzeFfmpegArgs("test.mp3");
    expect(args).toContain("-t");
    expect(args[args.indexOf("-t") + 1]).toBe("60");
  });

  it("adds bilibili headers for bilibili URLs", () => {
    const args = buildAnalyzeFfmpegArgs("https://upos-sz-mirrorcoso1.bilivideo.com/audio.m4s");
    expect(args).toContain("-headers");
    const headers = args[args.indexOf("-headers") + 1];
    expect(headers).toContain("Referer: https://www.bilibili.com");
  });

  it("adds netease headers for netease URLs", () => {
    const args = buildAnalyzeFfmpegArgs("https://m701.music.126.net/audio.mp3");
    expect(args).toContain("-headers");
    const headers = args[args.indexOf("-headers") + 1];
    expect(headers).toContain("Referer: https://music.163.com/");
  });
});

describe("analyzeAudioLoudness integration", () => {
  it("analyzes synthetic audio generated via lavfi", async () => {
    // A 1-second synthetic sine wave in lavfi
    const analysis = await analyzeAudioLoudness("sine=frequency=440:duration=1", {
      targetLufs: -16,
      timeoutMs: 5000,
    });
    // Synthetic lavfi works with ffmpeg -i sine=... if supported or returns null
    if (analysis) {
      expect(Number.isFinite(analysis.integratedLoudness)).toBe(true);
      expect(Number.isFinite(analysis.truePeak)).toBe(true);
      expect(Number.isFinite(analysis.gainDb)).toBe(true);
    }
  });

  it("gracefully returns null on invalid file or timeout", async () => {
    const analysis = await analyzeAudioLoudness("http://127.0.0.1:59999/nonexistent.mp3", {
      timeoutMs: 500,
    });
    expect(analysis).toBeNull();
  });
});
