/**
 * BM25-only evaluation tests (unit layer).
 *
 * This is a fast suite copied from the BM25 block in `models/eval.test.ts`.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import type { Database } from "../src/db.js";
import { createHash } from "crypto";
import { fileURLToPath } from "url";

import {
  createStore,
  searchFTS,
  insertDocument,
  insertContent,
} from "../src/store.js";

// Set INDEX_PATH before importing store to prevent using global index
const tempDir = mkdtempSync(join(tmpdir(), "qmd-eval-unit-"));
process.env.INDEX_PATH = join(tempDir, "eval-unit.sqlite");

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const evalQueries: {
  query: string;
  expectedDoc: string;
  difficulty: "easy" | "medium" | "hard" | "fusion";
}[] = [
  // EASY: Exact keyword matches
  { query: "API versioning", expectedDoc: "api-design", difficulty: "easy" },
  { query: "Series A fundraising", expectedDoc: "fundraising", difficulty: "easy" },
  { query: "CAP theorem", expectedDoc: "distributed-systems", difficulty: "easy" },
  { query: "overfitting machine learning", expectedDoc: "machine-learning", difficulty: "easy" },
  { query: "remote work VPN", expectedDoc: "remote-work", difficulty: "easy" },
  { query: "Project Phoenix retrospective", expectedDoc: "product-launch", difficulty: "easy" },

  // MEDIUM: Semantic/conceptual queries
  { query: "how to structure REST endpoints", expectedDoc: "api-design", difficulty: "medium" },
  { query: "raising money for startup", expectedDoc: "fundraising", difficulty: "medium" },
  { query: "consistency vs availability tradeoffs", expectedDoc: "distributed-systems", difficulty: "medium" },
  { query: "how to prevent models from memorizing data", expectedDoc: "machine-learning", difficulty: "medium" },
  { query: "working from home guidelines", expectedDoc: "remote-work", difficulty: "medium" },
  { query: "what went wrong with the launch", expectedDoc: "product-launch", difficulty: "medium" },

  // HARD: Vague, partial memory, indirect
  { query: "nouns not verbs", expectedDoc: "api-design", difficulty: "hard" },
  { query: "Sequoia investor pitch", expectedDoc: "fundraising", difficulty: "hard" },
  { query: "Raft algorithm leader election", expectedDoc: "distributed-systems", difficulty: "hard" },
  { query: "F1 score precision recall", expectedDoc: "machine-learning", difficulty: "hard" },
  { query: "quarterly team gathering travel", expectedDoc: "remote-work", difficulty: "hard" },
  { query: "beta program 47 bugs", expectedDoc: "product-launch", difficulty: "hard" },

  // FUSION: Multi-signal queries that need both lexical AND semantic matching
  // These should have weak individual scores but strong combined RRF scores
  { query: "how much runway before running out of money", expectedDoc: "fundraising", difficulty: "fusion" },
  { query: "datacenter replication sync strategy", expectedDoc: "distributed-systems", difficulty: "fusion" },
  { query: "splitting data for training and testing", expectedDoc: "machine-learning", difficulty: "fusion" },
  { query: "JSON response codes error messages", expectedDoc: "api-design", difficulty: "fusion" },
  { query: "video calls camera async messaging", expectedDoc: "remote-work", difficulty: "fusion" },
  { query: "CI/CD pipeline testing coverage", expectedDoc: "product-launch", difficulty: "fusion" },
];

const chineseEvalQueries: {
  query: string;
  expectedDocs: string[];
  topK: number;
  unexpectedDocs?: string[];
  unexpectedTopK?: number;
  purpose: string;
}[] = [
  {
    query: "中华国歌",
    expectedDocs: [
      "法律-中华人民共和国国歌",
      "历史-义勇军进行曲的历史",
    ],
    topK: 2,
    purpose: "预期：中华人民共和国国歌 / 义勇军进行曲的历史 等应靠前",
  },
  {
    query: "中华人民共和国国歌",
    expectedDocs: [
      "法律-中华人民共和国国歌",
      "历史-义勇军进行曲的历史",
    ],
    topK: 2,
    purpose: "预期：标题或正文完整包含该短语的文档应最靠前",
  },
  {
    query: "国歌 历史",
    expectedDocs: [
      "历史-义勇军进行曲的历史",
      "音乐-国歌的历史与演变",
      "音乐-法国国歌",
      "教育-国歌教学活动",
    ],
    topK: 4,
    purpose: "预期：同时覆盖“国歌”和“历史”的文档优先于只覆盖一个词的文档",
  },
  {
    query: "中文 分词 搜索",
    expectedDocs: [
      "科技-简单中文分词与搜索",
      "科技-Jieba-中文分词",
      "科技-记忆搜索中的中文查询",
      "教育-搜索系统课程设计",
    ],
    topK: 5,
    purpose: "预期：简单中文分词与搜索 / Jieba 中文分词 / 记忆搜索中的中文查询 / 搜索系统课程设计 等靠前",
  },
  {
    query: "BM25 中文 查询",
    expectedDocs: [
      "科技-记忆搜索中的中文查询",
      "教育-搜索系统课程设计",
    ],
    topK: 5,
    unexpectedDocs: [
      "科技-BM25-排序算法简介",
      "科技-相关性评分与排序",
      "科技-分词器与-tokenizer",
    ],
    unexpectedTopK: 5,
    purpose: "预期：记忆搜索中的中文查询 / 搜索系统课程设计 等靠前",
  },
  {
    query: "国家 仪式 国歌",
    expectedDocs: [
      "社会-国家仪式与礼仪",
      "音乐-国歌的历史与演变",
      "法律-中华人民共和国国歌",
    ],
    topK: 3,
    unexpectedDocs: [
      "社会-学校升旗仪式",
    ],
    unexpectedTopK: 3,
    purpose: "预期：国家仪式与礼仪 / 国歌的历史与演变 / 中华人民共和国国歌 等靠前",
  },
  {
    query: "QMD 记忆 搜索",
    expectedDocs: ["科技-QMD-记忆搜索系统"],
    topK: 1,
    purpose: "预期：QMD 记忆搜索系统 应最靠前，其他搜索相关文档其次",
  },
  {
    query: "中华 人民 共和国",
    expectedDocs: [
      "法律-中华人民共和国国歌",
      "法律-中华人民共和国宪法",
      "历史-义勇军进行曲的历史",
      "社会-中华人民共和国相关知识",
      "历史-中华民国与中华人民共和国",
    ],
    topK: 5,
    purpose: "预期：完整覆盖多个词项的文档比分散覆盖的文档更靠前",
  },
  {
    query: "国歌法",
    expectedDocs: ["法律-国歌法"],
    topK: 3,
    purpose: "预期：国歌法 文档应排第一或非常靠前",
  },
  {
    query: "Rust 生命周期",
    expectedDocs: ["科技-Rust-生命周期"],
    topK: 1,
    unexpectedDocs: [
      "科技-中文全文检索系统",
      "科技-BM25-排序算法简介",
      "科技-Jieba-中文分词",
      "科技-记忆搜索中的中文查询",
      "科技-相关性评分与排序",
    ],
    unexpectedTopK: 3,
    purpose: "预期：Rust 生命周期 相关文档靠前，中文搜索/BM25文档不应误排到前列",
  },
];

function matchesExpected(filepath: string, expectedDoc: string): boolean {
  return filepath.toLowerCase().includes(expectedDoc.toLowerCase());
}

function calcHitRate(
  queries: typeof evalQueries,
  searchFn: (query: string) => { filepath: string }[],
  topK: number
): number {
  let hits = 0;
  for (const { query, expectedDoc } of queries) {
    const results = searchFn(query).slice(0, topK);
    if (results.some(r => matchesExpected(r.filepath, expectedDoc))) hits++;
  }
  return hits / queries.length;
}

function extractEvalTitle(content: string, fallback: string): string {
  const subtitle = content.match(/^##\s+(.+)$/m)?.[1]?.trim();
  if (subtitle) return subtitle;

  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;

  return fallback;
}

function indexEvalDocs(db: Database, dirName: string, collectionName: string): void {
  const evalDocsDir = join(dirname(fileURLToPath(import.meta.url)), dirName);
  const files = readdirSync(evalDocsDir).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const content = readFileSync(join(evalDocsDir, file), "utf-8");
    const title = extractEvalTitle(content, file);
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
    const now = new Date().toISOString();

    insertContent(db, hash, content, now);
    insertDocument(db, collectionName, file, title, hash, now, now);
  }
}

describe("BM25 Search (FTS)", () => {
  let store: ReturnType<typeof createStore>;
  let db: Database;

  beforeAll(() => {
    store = createStore();
    db = store.db;

    indexEvalDocs(db, "eval-docs", "eval-docs");
    indexEvalDocs(db, "eval-docs-cn", "eval-docs-cn");
  });

  afterAll(() => {
    store.close();
  });

  test("easy queries: ≥80% Hit@3", () => {
    const easyQueries = evalQueries.filter(q => q.difficulty === "easy");
    const hitRate = calcHitRate(easyQueries, q => searchFTS(db, q, 5), 3);
    expect(hitRate).toBeGreaterThanOrEqual(0.8);
  });

  test("medium queries: ≥15% Hit@3 (BM25 struggles with semantic)", () => {
    const mediumQueries = evalQueries.filter(q => q.difficulty === "medium");
    const hitRate = calcHitRate(mediumQueries, q => searchFTS(db, q, 5), 3);
    expect(hitRate).toBeGreaterThanOrEqual(0.15);
  });

  test("hard queries: ≥15% Hit@5 (BM25 baseline)", () => {
    const hardQueries = evalQueries.filter(q => q.difficulty === "hard");
    const hitRate = calcHitRate(hardQueries, q => searchFTS(db, q, 5), 5);
    expect(hitRate).toBeGreaterThanOrEqual(0.15);
  });

  test("overall Hit@3 ≥40% (BM25 baseline)", () => {
    const hitRate = calcHitRate(evalQueries, q => searchFTS(db, q, 5), 3);
    expect(hitRate).toBeGreaterThanOrEqual(0.4);
  });

  describe("Chinese queries", () => {
    test.each(chineseEvalQueries)("$query", ({ query, expectedDocs, topK, purpose, unexpectedDocs, unexpectedTopK }) => {
      const results = searchFTS(db, query, Math.max(topK, unexpectedTopK ?? 0, 5));
      const topResults = results.slice(0, topK);

      for (const expectedDoc of expectedDocs) {
        expect(
          topResults.some((r: { filepath: string }) => matchesExpected(r.filepath, expectedDoc)),
          `${query}: ${purpose}; missing ${expectedDoc} in top${topK}`,
        ).toBe(true);
      }

      if (unexpectedDocs && unexpectedDocs.length > 0) {
        const forbiddenResults = results.slice(0, unexpectedTopK ?? topK);
        for (const unexpectedDoc of unexpectedDocs) {
          expect(
            forbiddenResults.some((r: { filepath: string }) => matchesExpected(r.filepath, unexpectedDoc)),
            `${query}: ${purpose}; unexpected ${unexpectedDoc} appeared in top${unexpectedTopK ?? topK}`,
          ).toBe(false);
        }
      }
    });
  });
});
