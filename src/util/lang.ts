// Small ISO-639 helper for subtitle tracks (addons mostly send ISO 639-2 like "eng").
const TABLE: [string, string, string][] = [
  ['en', 'eng', 'English'], ['es', 'spa', 'Spanish'], ['fr', 'fre', 'French'], ['de', 'ger', 'German'],
  ['it', 'ita', 'Italian'], ['pt', 'por', 'Portuguese'], ['pb', 'pob', 'Portuguese (BR)'], ['nl', 'dut', 'Dutch'],
  ['sv', 'swe', 'Swedish'], ['no', 'nor', 'Norwegian'], ['da', 'dan', 'Danish'], ['fi', 'fin', 'Finnish'],
  ['pl', 'pol', 'Polish'], ['cs', 'cze', 'Czech'], ['sk', 'slo', 'Slovak'], ['hu', 'hun', 'Hungarian'],
  ['ro', 'rum', 'Romanian'], ['bg', 'bul', 'Bulgarian'], ['el', 'gre', 'Greek'], ['tr', 'tur', 'Turkish'],
  ['ru', 'rus', 'Russian'], ['uk', 'ukr', 'Ukrainian'], ['ar', 'ara', 'Arabic'], ['he', 'heb', 'Hebrew'],
  ['fa', 'per', 'Persian'], ['hi', 'hin', 'Hindi'], ['bn', 'ben', 'Bengali'], ['ta', 'tam', 'Tamil'],
  ['te', 'tel', 'Telugu'], ['ml', 'mal', 'Malayalam'], ['th', 'tha', 'Thai'], ['vi', 'vie', 'Vietnamese'],
  ['id', 'ind', 'Indonesian'], ['ms', 'may', 'Malay'], ['tl', 'tgl', 'Tagalog'], ['zh', 'chi', 'Chinese'],
  ['ja', 'jpn', 'Japanese'], ['ko', 'kor', 'Korean'], ['hr', 'hrv', 'Croatian'], ['sr', 'srp', 'Serbian'],
  ['sl', 'slv', 'Slovenian'], ['et', 'est', 'Estonian'], ['lv', 'lav', 'Latvian'], ['lt', 'lit', 'Lithuanian'],
];
const ALIASES: Record<string, string> = { fra: 'fre', deu: 'ger', nld: 'dut', ces: 'cze', slk: 'slo', ron: 'rum', ell: 'gre', fas: 'per', msa: 'may', zho: 'chi', zht: 'chi', ze: 'chi' };

export function toIso639_2(code: string): string {
  const c = String(code ?? '').toLowerCase().trim();
  if (ALIASES[c]) return ALIASES[c];
  const row = TABLE.find((r) => r[0] === c || r[1] === c || r[2].toLowerCase() === c);
  return row ? row[1] : c || 'und';
}

export function languageName(code: string): string {
  const c = toIso639_2(code);
  return TABLE.find((r) => r[1] === c)?.[2] ?? code;
}
