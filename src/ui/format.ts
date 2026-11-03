export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function timeLeft(position: number, duration: number) {
  const minutes = Math.max(1, Math.round((duration - position) / 60));
  if (minutes < 60) return `${minutes} min left`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min left` : `${h} h left`;
}

const sizeFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
export function formatSize(bytes?: number) {
  if (!bytes) return undefined;
  if (bytes >= 1e12) return `${sizeFormat.format(bytes / 1e12)} TB`;
  if (bytes >= 1e9) return `${sizeFormat.format(bytes / 1e9)} GB`;
  return `${sizeFormat.format(bytes / 1e6)} MB`;
}

const LANGUAGES: Record<string, string> = {
  eng: "English", en: "English", spa: "Spanish", es: "Spanish", fre: "French", fra: "French", fr: "French",
  ger: "German", deu: "German", de: "German", ita: "Italian", it: "Italian", jpn: "Japanese", ja: "Japanese",
  kor: "Korean", ko: "Korean", chi: "Chinese", zho: "Chinese", zh: "Chinese", hin: "Hindi", hi: "Hindi",
  tam: "Tamil", tel: "Telugu", mal: "Malayalam", kan: "Kannada", ben: "Bengali", mar: "Marathi",
  por: "Portuguese", pt: "Portuguese", pob: "Portuguese (Brazil)", rus: "Russian", ru: "Russian",
  ara: "Arabic", ar: "Arabic", tur: "Turkish", tr: "Turkish", pol: "Polish", pl: "Polish", cze: "Czech",
  ces: "Czech", dut: "Dutch", nld: "Dutch", nl: "Dutch", swe: "Swedish", nor: "Norwegian", dan: "Danish",
  fin: "Finnish", gre: "Greek", ell: "Greek", heb: "Hebrew", hun: "Hungarian", ind: "Indonesian",
  may: "Malay", msa: "Malay", tha: "Thai", vie: "Vietnamese", ukr: "Ukrainian", rum: "Romanian",
  ron: "Romanian", per: "Persian", fas: "Persian", hrv: "Croatian", srp: "Serbian", bul: "Bulgarian",
  slv: "Slovenian", slo: "Slovak", slk: "Slovak", est: "Estonian", lav: "Latvian", lit: "Lithuanian",
  ice: "Icelandic", isl: "Icelandic", fil: "Filipino", tgl: "Tagalog", urd: "Urdu", cat: "Catalan",
  baq: "Basque", eus: "Basque", glg: "Galician", bos: "Bosnian", mac: "Macedonian", mkd: "Macedonian",
  alb: "Albanian", sqi: "Albanian", arm: "Armenian", hye: "Armenian", geo: "Georgian", kat: "Georgian",
  aze: "Azerbaijani", kaz: "Kazakh", uzb: "Uzbek", mon: "Mongolian", nep: "Nepali", sin: "Sinhala",
  khm: "Khmer", lao: "Lao", bur: "Burmese", mya: "Burmese", swa: "Swahili", amh: "Amharic", afr: "Afrikaans",
  wel: "Welsh", cym: "Welsh", gle: "Irish", epo: "Esperanto", ze: "Chinese (bilingual)", zht: "Chinese (traditional)",
  chs: "Chinese (simplified)", spn: "Spanish (Europe)", pom: "Portuguese (Mozambique)", und: "Unknown",
};

export function languageName(code?: string) {
  if (!code) return "Unknown";
  return LANGUAGES[code.toLowerCase()] ?? code.toUpperCase();
}

/** Languages people pick from in settings. Codes match TorBox and OpenSubtitles (ISO 639-2). */
export const LANGUAGE_CHOICES = [
  "eng", "spa", "fre", "ger", "ita", "por", "hin", "tam", "tel", "jpn", "kor", "chi", "ara", "rus", "tur",
].map((code) => ({ code, name: languageName(code) }));

/** How long ago, for things at most a couple of days old: "5 min ago", "3 h ago", "yesterday". */
export function ago(at: number, now = Date.now()) {
  const minutes = Math.max(1, Math.round((now - at) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : "yesterday";
}

export function plural(count: number, one: string, other: string) {
  return `${new Intl.NumberFormat("en-US").format(count)} ${count === 1 ? one : other}`;
}

export function episodeLabel(season?: number, episode?: number) {
  if (season === undefined || episode === undefined) return "";
  return `S${season} E${episode}`;
}

export function initials(name: string) {
  return name.trim().slice(0, 1).toUpperCase() || "?";
}
