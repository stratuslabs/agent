/**
 * `web.search`: the contract the ecosystem implements.
 *
 * The backends stay outside this repository — every one of them needs a
 * vendor key and a commercial relationship, so core ships `web.fetch` and
 * the ecosystem ships `web.search`. What has to be first-party is the half
 * that makes the other half worth anything: a fixed tool name and a fixed
 * result shape, so a soul or a skill written against search keeps working
 * when the operator changes vendor.
 *
 * The contract is specified in `docs/roadmap/13-search.md` and summarized
 * in this package's README; the code here is what enforces it.
 */

export {
  defineSearchProvider,
  SEARCH_CREDENTIAL_NAME,
  WEB_SEARCH_TOOL_NAME,
  type SearchContext,
  type SearchFreshness,
  type SearchOptionName,
  type SearchOptions,
  type SearchProvider,
  type SearchProviderDefinition,
  type SearchResult,
} from './contract.ts';

export {
  hostMatchesSite,
  normalizeSearchSite,
  parseFreshnessDuration,
  parseSearchCall,
  SearchOptionError,
  SEARCH_COUNT_DEFAULT,
  SEARCH_COUNT_MAX,
  type ParsedSearchCall,
} from './options.ts';

export {
  normalizePublishedAt,
  normalizeSearchResults,
  plainSnippet,
} from './results.ts';

export {
  createWebSearchTool,
  DEFAULT_MAX_SEARCHES_PER_DAY,
  UNTRUSTED_RESULT_NOTE,
  type SearchLogRecord,
  type WebSearchToolOptions,
} from './tool.ts';
