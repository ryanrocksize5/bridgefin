import type { Stream } from '../stremio/types.ts';

export interface StreamInfo {
  resolution: number; // 2160, 1080, 720, 480, 0 = unknown
  hdr: string[]; // 'DV', 'HDR10+', 'HDR10', 'HDR'
  videoCodec?: 'hevc' | 'h264' | 'av1' | 'vc1' | 'mpeg2';
  audio: string[]; // 'Atmos', 'TrueHD', 'DTS-HD MA', 'DTS', 'DD+', 'DD', 'AAC'
  channels?: number;
  source?: string; // 'BluRay REMUX', 'BluRay', 'WEB-DL', 'WEBRip', 'HDTV', 'CAM'
  sizeBytes?: number;
  filename?: string;
  container?: string; // 'mkv' | 'mp4' | ...
  cached?: boolean; // true = known cached, false = known uncached, undefined = unknown
  seeders?: number;
  releaseGroup?: string;
  languages: string[];
  isCam: boolean;
}

const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|GiB|MiB|TiB)\b/i;

export function parseSize(text: string): number | undefined {
  const m = SIZE_RE.exec(text);
  if (!m) return undefined;
  const n = Number(m[1].replace(',', '.'));
  const unit = m[2].toUpperCase();
  const mult = unit.startsWith('T') ? 1024 ** 4 : unit.startsWith('G') ? 1024 ** 3 : 1024 ** 2;
  return Math.round(n * mult);
}

export function streamText(s: Stream): string {
  return [s.name, s.title, s.description, s.behaviorHints?.filename].filter(Boolean).join('\n');
}

export function parseStream(s: Stream): StreamInfo {
  const text = streamText(s);
  const t = text.replace(/[._]/g, ' ');
  const info: StreamInfo = { resolution: 0, hdr: [], audio: [], languages: [], isCam: false };

  if (/\b(2160p|4k|uhd)\b/i.test(t)) info.resolution = 2160;
  else if (/\b1440p\b/i.test(t)) info.resolution = 1440;
  else if (/\b(1080p|fhd)\b/i.test(t)) info.resolution = 1080;
  else if (/\b720p\b/i.test(t)) info.resolution = 720;
  else if (/\b(576p|480p|sd)\b/i.test(t)) info.resolution = 480;

  if (/\b(dolby ?vision|dovi|dv)\b/i.test(t)) info.hdr.push('DV');
  if (/\bhdr10(\+|plus)/i.test(t)) info.hdr.push('HDR10+');
  else if (/\bhdr10\b/i.test(t)) info.hdr.push('HDR10');
  else if (/\bhdr\b/i.test(t)) info.hdr.push('HDR');

  if (/\b(hevc|x265|h ?265)\b/i.test(t)) info.videoCodec = 'hevc';
  else if (/\bav1\b/i.test(t)) info.videoCodec = 'av1';
  else if (/\b(avc|x264|h ?264)\b/i.test(t)) info.videoCodec = 'h264';
  else if (/\bvc-?1\b/i.test(t)) info.videoCodec = 'vc1';

  if (/\batmos\b/i.test(t)) info.audio.push('Atmos');
  if (/\btrue ?hd\b/i.test(t)) info.audio.push('TrueHD');
  if (/\bdts[- ]?(hd[- ]?)?ma\b/i.test(t)) info.audio.push('DTS-HD MA');
  else if (/\bdts[- ]?x\b/i.test(t)) info.audio.push('DTS:X');
  else if (/\bdts\b/i.test(t)) info.audio.push('DTS');
  if (/\b(ddp|dd\+|eac3|e-ac-3)\b/i.test(t) || /DD\+/i.test(text)) info.audio.push('DD+');
  else if (/\b(dd|ac3|dolby digital)\b/i.test(t)) info.audio.push('DD');
  if (/\baac\b/i.test(t)) info.audio.push('AAC');
  const ch = /\b([257])[ .]1\b/.exec(text);
  if (ch) info.channels = Number(ch[1]) + 1;

  if (/\bremux\b/i.test(t)) info.source = 'REMUX';
  else if (/\b(blu-?ray|bdrip|brrip|bdremux)\b/i.test(t)) info.source = 'BluRay';
  else if (/\bweb-?dl\b/i.test(t)) info.source = 'WEB-DL';
  else if (/\bweb-?rip\b/i.test(t)) info.source = 'WEBRip';
  else if (/\bhdtv\b/i.test(t)) info.source = 'HDTV';
  if (/\b(cam|camrip|hdcam|ts|telesync|hdts|telecine)\b/i.test(t)) {
    info.isCam = true;
    info.source = 'CAM';
  }

  info.sizeBytes = s.behaviorHints?.videoSize ?? parseSize(text);
  info.filename = s.behaviorHints?.filename ?? guessFilename(s);
  const ext = info.filename ? /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv)$/i.exec(info.filename) : null;
  info.container = ext ? ext[1].toLowerCase() : undefined;

  const seed = /👤\s*(\d+)/.exec(text) ?? /\bseeders?:?\s*(\d+)/i.exec(text);
  if (seed) info.seeders = Number(seed[1]);

  info.cached = detectCached(s);

  const langFlags = text.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu);
  if (langFlags) info.languages = [...new Set(langFlags)];
  return info;
}

function guessFilename(s: Stream): string | undefined {
  for (const part of [s.title, s.description]) {
    if (!part) continue;
    for (const line of part.split('\n')) {
      const l = line.trim();
      if (/\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts)$/i.test(l)) return l.replace(/^[^\w\[(]+/u, '');
    }
  }
  return undefined;
}

/**
 * Debrid-configured addons mark cached results in their names. Known conventions:
 *  Torrentio: "[TB+]" cached, "[TB download]" uncached.
 *  Comet / MediaFusion / AIOStreams: "⚡" cached, "⏳" or "⬇️" uncached.
 */
export function detectCached(s: Stream): boolean | undefined {
  const text = `${s.name ?? ''} ${s.title ?? ''} ${s.description ?? ''}`;
  if (/\[(TB|torbox)\s*download\]/i.test(text) || /⏳|⬇️|⬇|\buncached\b|\bnot cached\b/i.test(text)) return false;
  if (/\[(TB|torbox)\+\]/i.test(text) || /⚡|\binstant\b|\bcached\b/i.test(text)) return true;
  return undefined;
}

export function formatBytes(n?: number): string | undefined {
  if (!n || n <= 0) return undefined;
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

export function resolutionLabel(r: number): string | undefined {
  if (r >= 2160) return '4K';
  if (r >= 1440) return '1440p';
  if (r >= 1080) return '1080p';
  if (r >= 720) return '720p';
  if (r > 0) return 'SD';
  return undefined;
}

/** Version label shown in the client's version picker, e.g. "4K DV · REMUX · 58.2 GB · Torrentio". */
export function versionLabel(info: StreamInfo, addonName: string): string {
  const head = [resolutionLabel(info.resolution), info.hdr[0]].filter(Boolean).join(' ');
  const audio = info.audio[0];
  const parts = [head || undefined, info.source, info.videoCodec === 'hevc' ? 'HEVC' : info.videoCodec === 'av1' ? 'AV1' : undefined, audio, formatBytes(info.sizeBytes), addonName];
  return parts.filter(Boolean).join(' · ');
}
