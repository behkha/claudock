import type { SearchResult } from '../types'

/**
 * Search domain contract (global command palette). Owned by the search worker.
 * `query` returns at most ~30 results, best first. Must be fast (< 300 ms on a warm cache);
 * return [] for an empty or 1-character query.
 */
export interface SearchApi {
  query(q: string): Promise<SearchResult[]>
}

export interface SearchEvents {}
