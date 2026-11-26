// Subset of the Stremio addon protocol types we use.
// https://github.com/Stremio/stremio-addon-sdk/tree/master/docs/api

export interface ExtraDef {
  name: string;
  isRequired?: boolean;
  options?: string[];
  optionsLimit?: number;
}

export interface CatalogDef {
  type: string;
  id: string;
  name?: string;
  extra?: ExtraDef[];
  /** Legacy fields */
  extraSupported?: string[];
  extraRequired?: string[];
  genres?: string[];
}

export type ResourceDef =
  | string
  | { name: string; types?: string[]; idPrefixes?: string[] };

export interface Manifest {
  id: string;
  version?: string;
  name: string;
  description?: string;
  logo?: string;
  types?: string[];
  resources?: ResourceDef[];
  idPrefixes?: string[];
  catalogs?: CatalogDef[];
  behaviorHints?: { adult?: boolean; p2p?: boolean; configurable?: boolean; configurationRequired?: boolean };
}

export interface MetaVideo {
  id: string;
  title?: string;
  name?: string;
  season?: number;
  episode?: number;
  /** legacy alias of episode */
  number?: number;
  released?: string;
  firstAired?: string;
  thumbnail?: string;
  overview?: string;
  description?: string;
  runtime?: string;
}

export interface MetaLink {
  name: string;
  category: string;
  url: string;
}

export interface Meta {
  id: string;
  type: string;
  name: string;
  poster?: string;
  posterShape?: string;
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string | number;
  released?: string;
  year?: string | number;
  imdbRating?: string | number;
  imdb_id?: string;
  moviedb_id?: number | string;
  tvdb_id?: number | string;
  genres?: string[];
  genre?: string[];
  cast?: string[];
  director?: string[] | string;
  writer?: string[] | string;
  runtime?: string;
  country?: string;
  language?: string;
  status?: string;
  certification?: string;
  awards?: string;
  website?: string;
  links?: MetaLink[];
  videos?: MetaVideo[];
  trailers?: { source: string; type?: string }[];
  trailerStreams?: { ytId?: string; title?: string }[];
  behaviorHints?: { defaultVideoId?: string; hasScheduledVideos?: boolean };
  app_extras?: { cast?: { name: string; character?: string; photo?: string }[] };
}

export interface Stream {
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  ytId?: string;
  externalUrl?: string;
  name?: string;
  title?: string;
  description?: string;
  subtitles?: Subtitle[];
  sources?: string[];
  behaviorHints?: {
    bingeGroup?: string;
    filename?: string;
    videoSize?: number;
    videoHash?: string;
    notWebReady?: boolean;
    countryWhitelist?: string[];
    proxyHeaders?: { request?: Record<string, string>; response?: Record<string, string> };
  };
}

export interface Subtitle {
  id?: string;
  url: string;
  lang: string;
}

export interface InstalledAddon {
  id: string;
  transportUrl: string;
  manifest: Manifest;
  position: number;
  enabled: boolean;
}
