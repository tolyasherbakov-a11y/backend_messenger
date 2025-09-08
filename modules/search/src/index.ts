/**
 * SearchService — безопасная обёртка над OpenSearch/Elasticsearch
 *
 * Возможности:
 *  - full-text поиск по типам: message | post | channel | user
 *  - фильтры, пагинация, сорт, highlight
 *  - подсказки (suggest) поверх тех же полей
 *
 * ENV:
 *  OS_NODE, OS_USERNAME, OS_PASSWORD, OS_INDEX_ALIAS (по умолчанию "app-content")
 */

import { Client } from '@opensearch-project/opensearch';

export type SearchType = 'message' | 'post' | 'channel' | 'user';

export type SearchQuery = {
  q: string;
  types?: SearchType[];
  limit?: number;        // 1..50
  cursor?: string | null; // base64 of from
  sort?: 'relevance' | 'recency'; // recency = updated_at desc
  // future: tenantId, ownerId, channelId, conversationId — при необходимости
};

export type SearchHit = {
  id: string;          // "<type>:<uuid>"
  type: SearchType;
  score: number;
  created_at: string;  // ISO
  updated_at: string;  // ISO
  text?: string;
  highlight?: string[]; // фрагменты
  meta?: Record<string, any>;
};

export type SearchResult = {
  hits: SearchHit[];
  nextCursor: string | null;
  totalApprox: number;  // value из hits.total (approximate)
};

export type SuggestQuery = {
  q: string;
  types?: SearchType[];
  limit?: number; // 1..10
};

export type SuggestResult = {
  suggestions: Array<{ type: SearchType; text: string; id: string }>;
};

const {
  OS_NODE = 'http://opensearch:9200',
  OS_USERNAME = '',
  OS_PASSWORD = '',
  OS_INDEX_ALIAS = 'app-content',
} = process.env;

// ──────────────────────────────────────────────────────────────────────────────

export class SearchService {
  private client: Client;
  private index: string;

  constructor() {
    this.client = new Client({
      node: OS_NODE,
      auth: OS_USERNAME || OS_PASSWORD ? { username: OS_USERNAME, password: OS_PASSWORD } : undefined,
      ssl: { rejectUnauthorized: false }, // dev: разрешаем self-signed
    });
    this.index = OS_INDEX_ALIAS;
  }

  private ensureQ(q: string): string {
    const s = String(q || '').trim();
    if (!s) return '*';
    // Нейтрализуем спецсимволы Lucene, оставим базовые слова.
    return s.replace(/[+\-=&|><!(){}\[\]^"~*?:\\/]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private fromCursor(cursor?: string | null): number {
    if (!cursor) return 0;
    try {
      const d = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8'));
      if (typeof d?.from === 'number' && d.from >= 0 && d.from <= 10000) return d.from;
      return 0;
    } catch { return 0; }
  }
  private toCursor(from: number): string {
    return Buffer.from(JSON.stringify({ from })).toString('base64');
  }

  async search(params: SearchQuery): Promise<SearchResult> {
    const q = this.ensureQ(params.q);
    const types = Array.isArray(params.types) && params.types.length
      ? params.types
      : (['message', 'post', 'channel', 'user'] as SearchType[]);
    const limit = Math.max(1, Math.min(50, Number(params.limit || 20)));
    const from = this.fromCursor(params.cursor ?? null);
    const sortRecency = params.sort === 'recency';

    const must: any[] = [];
    if (q !== '*') {
      // используем multi_match с рус/англ анализатором
      must.push({
        multi_match: {
          query: q,
          fields: ['text^3', 'meta.title^4', 'meta.username^4', 'meta.display_name^4'],
          type: 'best_fields',
          operator: 'and',
        },
      });
    }
    must.push({ terms: { type: types } });

    const body: any = {
      track_total_hits: false,
      from,
      size: limit,
      query: { bool: { must } },
      _source: ['id', 'type', 'created_at', 'updated_at', 'text', 'meta'],
      highlight: {
        pre_tags: ['<em>'],
        post_tags: ['</em>'],
        fields: { text: { fragment_size: 120, number_of_fragments: 2 } },
      },
    };

    if (sortRecency) {
      body.sort = [{ updated_at: { order: 'desc' } }];
    }

    const res = await this.client.search({ index: this.index, body });
    const hitsRaw: any[] = (res.body.hits?.hits || []);
    const hits: SearchHit[] = hitsRaw.map((h) => ({
      id: String(h._source.id),
      type: String(h._source.type) as SearchType,
      score: typeof h._score === 'number' ? h._score : 0,
      created_at: h._source.created_at,
      updated_at: h._source.updated_at,
      text: h._source.text,
      highlight: (h.highlight?.text || []) as string[],
      meta: h._source.meta || {},
    }));

    // курсор постранички: увеличиваем from на фактическое число возвращённых результатов
    const nextFrom = from + hits.length;
    const nextCursor = hits.length < limit ? null : this.toCursor(nextFrom);

    return {
      hits,
      totalApprox: Number(res.body.hits?.total?.value ?? 0), // у OS часто приблизительное
      nextCursor,
    };
  }

  async suggest(params: SuggestQuery): Promise<SuggestResult> {
    const q = this.ensureQ(params.q);
    const limit = Math.max(1, Math.min(10, Number(params.limit || 8)));
    const types = Array.isArray(params.types) && params.types.length
      ? params.types
      : (['message', 'post', 'channel', 'user'] as SearchType[]);

    if (q === '*' || q.length < 2) {
      return { suggestions: [] }; // не спамим пустотой
    }

    // Простой лайт-суггест: ищем top N по prefix-подобному matсh
    const body: any = {
      size: limit,
      query: {
        bool: {
          must: [
            { terms: { type: types } },
            {
              multi_match: {
                query: q,
                fields: ['meta.title^4', 'meta.username^4', 'meta.display_name^4', 'text^1'],
                type: 'phrase_prefix',
              },
            },
          ],
        },
      },
      _source: ['id', 'type', 'text', 'meta'],
    };

    const res = await this.client.search({ index: this.index, body });
    const hits = res.body.hits?.hits || [];
    const suggestions = hits.map((h: any) => {
      const t = String(h._source.type) as SearchType;
      let text = '';
      if (t === 'user') text = h._source.meta?.display_name || h._source.meta?.username || h._source.text || '';
      else if (t === 'channel') text = h._source.meta?.title || h._source.text || '';
      else if (t === 'post') text = h._source.meta?.title || h._source.text || '';
      else text = h._source.text || '';
      return { type: t, text: String(text).slice(0, 160), id: String(h._source.id) };
    });

    return { suggestions };
  }
}

export default SearchService;
