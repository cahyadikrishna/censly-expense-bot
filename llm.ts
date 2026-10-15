/**
 * llm.ts — LLM layer for Censly Edge Function (DeepSeek via OpenAI-compatible API)
 * All prompt → JSON parsing lives here. Has no dependency on sheets.ts.
 */

import OpenAI from "npm:openai@7.25.0";
import { encodeBase64 } from "https://deno.land/std@0.203.0/encoding/base64.ts";
import { computeSplit } from "./split.ts";
import type { SplitExtraction } from "./split.ts";

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

  // Image must come BEFORE the text: with text first + JSON mode, deepseek-flash
  // sometimes echoes the response_format ({"type":"json_object"}) instead of answering.
  const content: OpenAI.Chat.ChatCompletionContentPart[] = [];
  if (opts.imageBytes) {
    content.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${encodeBase64(opts.imageBytes)}` },
    });
  }
  content.push({ type: "text", text: prompt });

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
      const parsed = JSON.parse(cleaned);
      if (parsed?.type === "json_object") {
        // Echoed response_format — unwrap if the real payload is nested, else retry
        if (parsed.data && typeof parsed.data === "object") return parsed.data as T;
        lastError = "echoed response_format instead of data";
        continue;
      }
      return parsed as T;
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

export async function parseSplitBill(
  imageBytes: Uint8Array,
  caption: string,
  today: string
): Promise<SplitBillResult> {
  const instructions = caption
    .replace(/split\s*(this\s*)?(bill)?/gi, "")
    .replace(/\bbagi\s*(tagihan|bill|rata)?/gi, "") // \b keeps "dibagi rata" instructions intact
    .replace(/patungan/gi, "")
    .replace(/pisah\s*(tagihan|bill)?/gi, "")
    .trim();

  // The model only reads the receipt and maps items to people; split.ts does the math.
  const prompt =
    `You are a precise receipt reader for Indonesian restaurant bills.\n` +
    `Read every line item from the receipt image and decide who ordered each one.\n\n` +
    (instructions ? `USER INSTRUCTIONS:\n${instructions}\n\n` : `USER INSTRUCTIONS: (none)\n\n`) +
    `Respond ONLY in valid JSON:\n` +
    `{"store_name":"...","date":"YYYY-MM-DD",` +
    `"items":[{"name":"Nasi Goreng","price":35000,"quantity":1,"assigned_to":["yoga"]},` +
    `{"name":"Es Teh","price":20000,"quantity":2,"assigned_to":[]}],` +
    `"subtotal":150000,"tax":16500,"service":15000,"grand_total":181500,` +
    `"people":["yoga","dwi"],"tax_split":"equal"}\n\n` +
    `Rules:\n` +
    `- All prices as integer IDR, read digits exactly as printed\n` +
    `- price = line total as printed on the receipt (already multiplied by quantity)\n` +
    `- Include every purchased line item; do not include subtotal/tax/service/total lines as items\n` +
    `- tax = PB1/PPN/pajak/tax amount, service = service charge amount (0 if absent)\n` +
    `- grand_total = final TOTAL printed on the receipt\n` +
    `- people = every person named in the instructions, lowercase as written; [] if nobody is named\n` +
    `- assigned_to = names of people who ordered that item (fuzzy match item names to receipt)\n` +
    `- assigned_to = [] for shared items, items marked "dibagi rata"/"bagi rata"/shared, or items nobody claimed\n` +
    `- tax_split = "proportional" only if the instructions say proporsional/proportional, otherwise "equal"\n` +
    `- Do NOT calculate per-person amounts\n` +
    `- date: ${today} if not visible`;

  const extraction = await callJson<SplitExtraction>("parseSplitBill", prompt, { imageBytes, maxTokens: 4096 });
  return computeSplit(extraction);
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
