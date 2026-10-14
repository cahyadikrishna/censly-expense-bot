/**
 * llm.ts — LLM layer for Censly Edge Function (DeepSeek via OpenAI-compatible API)
 * All prompt → JSON parsing lives here. Has no dependency on sheets.ts.
 */

import OpenAI from "npm:openai@7.25.0";
import { encodeBase64 } from "https://deno.land/std@0.203.0/encoding/base64.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedTransaction {
  action: "create" | "summary" | "delete_last" | "delete" | "list" | "categories" | "budget" | "unknown";
  type?: "income" | "expense";
  amount?: number;
  category?: string;
  note?: string;
  date?: string;
  merchant?: string;
  id?: string;
}

export interface ParsedExpenseImage {
  category: string;
  amount: number;
  merchant: string;
  note: string;
  date: string;
}

export interface BillItem {
  name: string;
  price: number;
  quantity: number;
}

export interface PersonShare {
  name: string;
  items: { name: string; price: number }[];
  subtotal: number;
  tax: number;
  service: number;
  total: number;
}

export interface SplitBillResult {
  store_name: string;
  date: string;
  items: BillItem[];
  subtotal: number;
  tax: number;
  service: number;
  grand_total: number;
  people: PersonShare[];
  unassigned_items: BillItem[];
}

export interface ParsedDebt {
  person_name: string;
  item: string;
  amount: number;
}

// ── Client ────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL    = "deepseek-flash";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

function config() {
  return {
    apiKey:  Deno.env.get("DEEPSEEK_API_KEY") ?? "",
    model:   Deno.env.get("DEEPSEEK_MODEL") || DEFAULT_MODEL,
    baseURL: Deno.env.get("DEEPSEEK_BASE_URL") || DEFAULT_BASE_URL,
  };
}

function stripFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

async function callJson<T>(
  tag: string,
  prompt: string,
  opts: { imageBytes?: Uint8Array; maxTokens?: number } = {}
): Promise<T> {
  const { apiKey, model, baseURL } = config();
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");

  const client = new OpenAI({ apiKey, baseURL, maxRetries: 1, timeout: 60_000 });

  const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: "text", text: prompt }];
  if (opts.imageBytes) {
    content.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${encodeBase64(opts.imageBytes)}` },
    });
  }

  // DeepSeek JSON mode can occasionally return empty content — retry once.
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content }],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: opts.maxTokens ?? 2048,
      // DeepSeek-specific: non-thinking mode (thinking is on by default)
      thinking: { type: "disabled" },
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

    const raw = result.choices[0]?.message?.content ?? "";
    console.log(`[${tag}] raw:`, raw);

    const cleaned = stripFences(raw);
    if (!cleaned) {
      lastError = "empty response";
      continue;
    }
    try {
      return JSON.parse(cleaned) as T;
    } catch (err) {
      lastError = `invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  throw new Error(`[${tag}] LLM failed after 2 attempts: ${lastError}`);
}

// ── Parsers ───────────────────────────────────────────────────────────────────

export function parseText(text: string, today: string): Promise<ParsedTransaction> {
  const prompt =
    `You are an expense tracking assistant for Indonesian users.\n` +
    `Parse this message into a transaction or command.\n` +
    `Respond ONLY in valid JSON, no markdown:\n` +
    `{"action":"create"|"summary"|"delete_last"|"list"|"categories"|"budget"|"unknown",` +
    `"type":"income"|"expense","amount":45000,"category":"Makan","note":"desc",` +
    `"merchant":"store name","date":"YYYY-MM-DD"}\n\n` +
    `Rules:\n` +
    `- "rb"/"ribu"=thousands, "jt"/"juta"=millions\n` +
    `- "kemarin"=yesterday, "hari ini"/"tadi"=today\n` +
    `- category: Makan|Transport|Belanja|Tagihan|Kesehatan|Hiburan|Gaji|Freelance|Lainnya\n` +
    `- rekap/summary/pengeluaran bulan → action="summary"\n` +
    `- hapus/batal/delete last/hapus terakhir → action="delete_last"\n` +
    `- list/daftar/transaksi → action="list"\n` +
    `- kategori/categories → action="categories"\n` +
    `- budget/anggaran → action="budget"\n` +
    `- default type="expense" unless clearly income\n` +
    `- today: ${today}\n\n` +
    `Message: "${text}"`;

  return callJson<ParsedTransaction>("parseText", prompt);
}

export function parseExpenseImage(imageBytes: Uint8Array, today: string): Promise<ParsedExpenseImage> {
  const prompt =
    `Extract expense data from this receipt.\n` +
    `Respond ONLY in valid JSON:\n` +
    `{"category":"Makan","amount":45000,"merchant":"Nama Toko","note":"desc","date":"YYYY-MM-DD"}\n\n` +
    `Rules:\n` +
    `- amount = TOTAL as integer IDR\n` +
    `- category: Makan|Transport|Belanja|Tagihan|Kesehatan|Hiburan|Lainnya\n` +
    `- merchant = store/restaurant name from receipt\n` +
    `- date = today if not on receipt: ${today}`;

  return callJson<ParsedExpenseImage>("parseExpenseImage", prompt, { imageBytes });
}

export function parseSplitBill(
  imageBytes: Uint8Array,
  caption: string,
  today: string
): Promise<SplitBillResult> {
  const instructions = caption
    .replace(/split\s*(this\s*)?(bill)?/gi, "")
    .replace(/bagi\s*(tagihan|bill|rata)?/gi, "")
    .replace(/patungan/gi, "")
    .replace(/pisah\s*(tagihan|bill)?/gi, "")
    .trim();

  const prompt =
    `You are a precise bill splitting assistant for Indonesian restaurant bills.\n\n` +
    `DEFAULT RULES (apply when not overridden):\n` +
    `- Unassigned items: split equally among all people\n` +
    `- Tax and service: split equally among all people\n` +
    `- Shared items (table fee, shared dishes): split equally\n` +
    `- No people mentioned: 1 person pays full amount\n` +
    (instructions ? `\nUSER INSTRUCTIONS (override defaults):\n${instructions}\n` : "") +
    `\nRespond ONLY in valid JSON:\n` +
    `{"store_name":"...","date":"YYYY-MM-DD",` +
    `"items":[{"name":"...","price":35000,"quantity":1}],` +
    `"subtotal":150000,"tax":16500,"service":15000,"grand_total":181500,` +
    `"people":[{"name":"yoga","items":[{"name":"Nasi Goreng","price":35000}],` +
    `"subtotal":35000,"tax":5500,"service":5000,"total":45500}],` +
    `"unassigned_items":[]}\n\n` +
    `Rules:\n` +
    `- All prices as integer IDR\n` +
    `- Fuzzy match item names to receipt\n` +
    `- "dibagi rata"=equal split, "proporsional"=proportional to subtotal\n` +
    `- Sum of people totals must equal grand_total minus unassigned\n` +
    `- date: ${today} if not visible`;

  return callJson<SplitBillResult>("parseSplitBill", prompt, { imageBytes, maxTokens: 4096 });
}

export function parseDebt(text: string, today: string): Promise<ParsedDebt> {
  const prompt =
    `You are an expense tracking assistant for Indonesian users.\n` +
    `The user paid for someone else's item and wants to track what that person owes them.\n` +
    `Parse this message and extract the person name, item description, and amount.\n` +
    `Respond ONLY in valid JSON, no markdown:\n` +
    `{"person_name":"Widhi","item":"drink","amount":170000}\n\n` +
    `Rules:\n` +
    `- "rb"/"ribu" = ×1000, "k" at end = ×1000, "jt"/"juta" = ×1,000,000\n` +
    `- person_name: the person who owes the money (first proper noun after "deb ")\n` +
    `- item: what was bought (brief description, in English or Indonesian)\n` +
    `- amount: integer IDR\n` +
    `- today: ${today}\n\n` +
    `Message: "${text}"`;

  return callJson<ParsedDebt>("parseDebt", prompt);
}
