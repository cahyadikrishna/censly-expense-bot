import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { GoogleGenAI } from "https://esm.sh/@google/genai";
import { encodeBase64 } from "https://deno.land/std@0.203.0/encoding/base64.ts";
import dayjs from "https://esm.sh/dayjs";
import { SheetsService } from "./sheets.ts";
import type { TransactionRow, MonthlySummary } from "./sheets.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TelegramPhotoSize {
  file_id: string;
  file_size: number;
  width: number;
  height: number;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  photo?: TelegramPhotoSize[];
  caption?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface ParsedTransaction {
  action: "create" | "summary" | "delete_last" | "delete" | "list" | "categories" | "budget" | "unknown";
  type?: "income" | "expense";
  amount?: number;
  category?: string;
  note?: string;
  date?: string;
  merchant?: string;
  id?: string;
}

interface BillItem {
  name: string;
  price: number;
  quantity: number;
}

interface PersonShare {
  name: string;
  items: { name: string; price: number }[];
  subtotal: number;
  tax: number;
  service: number;
  total: number;
}

interface SplitBillResult {
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

// ── Config ────────────────────────────────────────────────────────────────────

const BOT_TOKEN       = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const WEBHOOK_SECRET  = Deno.env.get("TELEGRAM_SECRET") ?? "";
const GEMINI_API_KEY  = Deno.env.get("GEMINI_API_KEY") ?? "";
const SPREADSHEET_ID  = Deno.env.get("GOOGLE_SPREADSHEET_ID") ?? "";
const SERVICE_ACCOUNT = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") ?? "{}");
const GEMINI_MODEL    = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.0-flash";

function today(): string {
  return SheetsService.witaNow().date;
}

// ── Sheets service singleton ──────────────────────────────────────────────────

function getSheets(): SheetsService {
  return new SheetsService(SPREADSHEET_ID, {
    client_email: SERVICE_ACCOUNT.client_email,
    private_key: SERVICE_ACCOUNT.private_key,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatIDR(amount: number): string {
  const str = Math.round(amount).toString();
  const formatted = str.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return "Rp " + formatted;
}

function isSplitRequest(caption: string): boolean {
  const lower = caption.toLowerCase();
  return lower.includes("split") || lower.includes("bagi") ||
         lower.includes("patungan") || lower.includes("pisah");
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  const json = await res.json();
  console.log("[sendMessage]", JSON.stringify(json));
}

async function downloadTelegramPhoto(fileId: string): Promise<Uint8Array> {
  const r1 = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
  const j1 = await r1.json();
  console.log("[downloadPhoto] getFile:", JSON.stringify(j1));
  const filePath: string = j1.result.file_path;
  const r2 = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
  return new Uint8Array(await r2.arrayBuffer());
}

// ── Reply builders ────────────────────────────────────────────────────────────

function buildHelpMessage(): string {
  return (
    `👋 <b>Censly Fin Bot</b>\n\n` +
    `<b>📸 Catat dari foto:</b>\n` +
    `Kirim foto struk → otomatis tersimpan\n\n` +
    `<b>✍️ Catat manual:</b>\n` +
    `• <code>makan siang 45rb</code>\n` +
    `• <code>gaji 8 juta</code>\n` +
    `• <code>bensin 80000</code>\n\n` +
    `<b>🔀 Split tagihan:</b>\n` +
    `Foto + caption:\n` +
    `<code>split this bill\nyoga: nasi goreng, latte\ndwi: rice bowl\ntax dibagi rata</code>\n\n` +
    `<b>⌨️ Commands:</b>\n` +
    `/list — transaksi bulan ini\n` +
    `/summary — ringkasan bulan ini\n` +
    `/budget — cek budget\n` +
    `/categories — daftar kategori\n` +
    `/delete [id] — hapus transaksi\n` +
    `/hapus — hapus transaksi terakhir`
  );
}

function buildTransactionConfirm(row: TransactionRow): string {
  const emoji = ["Gaji","Freelance"].includes(row.category) ? "💰" : "💸";
  return (
    `✅ <b>Tersimpan!</b>\n\n` +
    `🆔 <code>${row.id}</code>\n` +
    `🏷 ${row.category}${row.subcategory ? ` › ${row.subcategory}` : ""}\n` +
    `${emoji} ${formatIDR(row.amount)}\n` +
    `🏪 ${row.merchant || "—"}\n` +
    `📅 ${row.date} ${row.time}\n` +
    (row.note ? `📝 ${row.note}` : "")
  ).trim();
}

function buildSummaryMessage(summary: MonthlySummary): string {
  const monthName = dayjs(`${summary.year}-${String(summary.month).padStart(2,"0")}-01`).format("MMMM YYYY");
  const lines: string[] = [];

  lines.push(`📊 <b>${monthName}</b>\n`);
  lines.push(`💸 Total: ${formatIDR(summary.total)}`);
  lines.push(`📈 Rata-rata/hari: ${formatIDR(summary.average_per_day)}`);
  lines.push(`🔢 Transaksi: ${summary.count}x\n`);

  if (summary.by_category.length > 0) {
    lines.push(`<b>📂 Per Kategori:</b>`);
    for (const c of summary.by_category) {
      const overBudget = c.budget > 0 && c.total > c.budget;
      const budgetStr = c.budget > 0
        ? ` / ${formatIDR(c.budget)}${overBudget ? " ⚠️" : ""}`
        : "";
      lines.push(`${c.category}: ${formatIDR(c.total)}${budgetStr}`);
    }
    lines.push("");
  }

  if (summary.top_merchants.length > 0) {
    lines.push(`<b>🏪 Top Merchant:</b>`);
    for (const m of summary.top_merchants) {
      lines.push(`${m.merchant}: ${formatIDR(m.total)} (${m.count}x)`);
    }
  }

  return lines.join("\n");
}

function buildListMessage(transactions: TransactionRow[], month?: string): string {
  if (transactions.length === 0) {
    return `📭 Tidak ada transaksi${month ? ` di ${month}` : ""}.`;
  }

  const lines: string[] = [`📋 <b>Transaksi terbaru:</b>\n`];
  for (const t of transactions) {
    const emoji = ["Gaji","Freelance"].includes(t.category) ? "💰" : "💸";
    lines.push(
      `${emoji} ${t.date} — <b>${formatIDR(t.amount)}</b>\n` +
      `   ${t.category}${t.merchant ? ` · ${t.merchant}` : ""}` +
      (t.note ? `\n   📝 ${t.note}` : "") +
      `\n   <code>${t.id}</code>\n`
    );
  }
  return lines.join("\n");
}

function buildBudgetMessage(summary: MonthlySummary): string {
  const monthName = dayjs(`${summary.year}-${String(summary.month).padStart(2,"0")}-01`).format("MMMM YYYY");
  const lines: string[] = [`💰 <b>Budget ${monthName}</b>\n`];

  const withBudget = summary.by_category.filter((c) => c.budget > 0);
  if (withBudget.length === 0) {
    return `${lines[0]}\nBelum ada budget yang diset.\nEdit di sheet Categories!`;
  }

  for (const c of withBudget) {
    const pct = Math.round((c.total / c.budget) * 100);
    const bar = buildBar(pct);
    const status = pct >= 100 ? "🔴" : pct >= 80 ? "🟡" : "🟢";
    lines.push(
      `${status} <b>${c.category}</b>\n` +
      `   ${bar} ${pct}%\n` +
      `   ${formatIDR(c.total)} / ${formatIDR(c.budget)}\n` +
      `   Sisa: ${formatIDR(Math.max(0, c.remaining))}\n`
    );
  }
  return lines.join("\n");
}

function buildBar(pct: number): string {
  const filled = Math.min(10, Math.round(pct / 10));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function buildCategoriesMessage(categories: { category: string; emoji: string; budget_per_month: number }[]): string {
  const lines = [`📂 <b>Kategori:</b>\n`];
  for (const c of categories) {
    const budget = c.budget_per_month > 0 ? ` — Budget: ${formatIDR(c.budget_per_month)}/bln` : "";
    lines.push(`${c.emoji} ${c.category}${budget}`);
  }
  return lines.join("\n");
}

function buildSplitResultMessage(result: SplitBillResult): string {
  const lines: string[] = [];
  lines.push(`🧾 <b>${result.store_name}</b>`);
  lines.push(`📅 ${dayjs(result.date).isValid() ? dayjs(result.date).format("D MMMM YYYY") : result.date}`);
  lines.push(`💰 Total: ${formatIDR(result.grand_total)}\n`);

  for (const person of result.people) {
    lines.push(`👤 <b>${person.name}</b>`);
    for (const item of person.items) {
      lines.push(`   • ${item.name}: ${formatIDR(item.price)}`);
    }
    if (person.tax > 0) lines.push(`   • Tax: ${formatIDR(person.tax)}`);
    if (person.service > 0) lines.push(`   • Service: ${formatIDR(person.service)}`);
    lines.push(`   💳 <b>${formatIDR(person.total)}</b>\n`);
  }

  if (result.unassigned_items.length > 0) {
    const unassignedTotal = result.unassigned_items.reduce((s, i) => s + i.price * i.quantity, 0);
    const perPerson = result.people.length > 0 ? unassignedTotal / result.people.length : unassignedTotal;
    lines.push(`📌 <b>Item tidak terassign</b>`);
    for (const item of result.unassigned_items) {
      lines.push(`   • ${item.name}: ${formatIDR(item.price * item.quantity)}`);
    }
    if (result.people.length > 1) lines.push(`   Dibagi rata: ${formatIDR(perPerson)}/orang`);
    lines.push("");
  }

  lines.push(`─────────────────`);
  lines.push(`<b>Ringkasan bayar:</b>`);
  for (const person of result.people) {
    lines.push(`${person.name} → ${formatIDR(person.total)}`);
  }
  return lines.join("\n");
}

// ── Gemini calls ──────────────────────────────────────────────────────────────

async function parseTextWithGemini(text: string): Promise<ParsedTransaction> {
  const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

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
    `- today: ${today()}\n\n` +
    `Message: "${text}"`;

  const result = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
  });

  const raw = result.text ?? "";
  console.log("[parseText] raw:", raw);
  return JSON.parse(raw) as ParsedTransaction;
}

async function parseExpenseImageWithGemini(imageBytes: Uint8Array): Promise<{
  category: string; amount: number; merchant: string; note: string; date: string;
}> {
  const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  const prompt =
    `Extract expense data from this receipt.\n` +
    `Respond ONLY in valid JSON:\n` +
    `{"category":"Makan","amount":45000,"merchant":"Nama Toko","note":"desc","date":"YYYY-MM-DD"}\n\n` +
    `Rules:\n` +
    `- amount = TOTAL as integer IDR\n` +
    `- category: Makan|Transport|Belanja|Tagihan|Kesehatan|Hiburan|Lainnya\n` +
    `- merchant = store/restaurant name from receipt\n` +
    `- date = today if not on receipt: ${today()}`;

  const result = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { inlineData: { mimeType: "image/jpeg", data: encodeBase64(imageBytes) } },
      ],
    }],
    config: { responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
  });

  const raw = result.text ?? "";
  console.log("[parseExpenseImage] raw:", raw);
  return JSON.parse(raw);
}

async function parseSplitBillWithGemini(
  imageBytes: Uint8Array,
  caption: string
): Promise<SplitBillResult> {
  const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

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
    `- date: ${today()} if not visible`;

  const result = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { inlineData: { mimeType: "image/jpeg", data: encodeBase64(imageBytes) } },
      ],
    }],
    config: { responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
  });

  const raw = result.text ?? "";
  console.log("[parseSplitBill] raw:", raw);
  return JSON.parse(raw) as SplitBillResult;
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleExpenseScan(
  imageBytes: Uint8Array,
  imageUrl: string,
  chatId: number
): Promise<void> {
  const sheets = getSheets();
  const { date, time } = SheetsService.witaNow();

  const extracted = await parseExpenseImageWithGemini(imageBytes);
  console.log("[handleExpenseScan] extracted:", JSON.stringify(extracted));

  const result = await sheets.addTransaction({
    date: extracted.date || date,
    time,
    category: extracted.category || "Lainnya",
    subcategory: "",
    amount: extracted.amount,
    currency: "IDR",
    merchant: extracted.merchant || "",
    note: extracted.note || "",
    source: "receipt_scan",
    raw_image_url: imageUrl,
  });

  console.log("[handleExpenseScan] saved:", result.id);

  const row = {
    id: result.id,
    date: extracted.date || date,
    time,
    category: extracted.category || "Lainnya",
    subcategory: "",
    amount: extracted.amount,
    currency: "IDR",
    merchant: extracted.merchant || "",
    note: extracted.note || "",
    source: "receipt_scan",
    raw_image_url: imageUrl,
  };
  await sendMessage(chatId, buildTransactionConfirm(row));
}

async function handleCreateFromText(
  parsed: ParsedTransaction,
  chatId: number
): Promise<void> {
  const sheets = getSheets();
  const { date, time } = SheetsService.witaNow();

  const result = await sheets.addTransaction({
    date: parsed.date || date,
    time,
    category: parsed.category || "Lainnya",
    subcategory: "",
    amount: parsed.amount ?? 0,
    currency: "IDR",
    merchant: parsed.merchant || "",
    note: parsed.note || "",
    source: "manual",
    raw_image_url: "",
  });

  console.log("[handleCreate] saved:", result.id);

  const row = {
    id: result.id,
    date: parsed.date || date,
    time,
    category: parsed.category || "Lainnya",
    subcategory: "",
    amount: parsed.amount ?? 0,
    currency: "IDR",
    merchant: parsed.merchant || "",
    note: parsed.note || "",
    source: "manual",
    raw_image_url: "",
  };
  await sendMessage(chatId, buildTransactionConfirm(row));
}

async function handleSummary(chatId: number, month?: number, year?: number): Promise<void> {
  const sheets = getSheets();
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const m = month ?? now.getMonth() + 1;
  const y = year ?? now.getFullYear();

  const summary = await sheets.getMonthlySummary(m, y);
  console.log("[handleSummary] total:", summary.total, "count:", summary.count);
  await sendMessage(chatId, buildSummaryMessage(summary));
}

async function handleList(chatId: number, limit = 10): Promise<void> {
  const sheets = getSheets();
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const transactions = await sheets.getTransactions({
    month: now.getMonth() + 1,
    year: now.getFullYear(),
    limit,
  });
  console.log("[handleList] count:", transactions.length);
  await sendMessage(chatId, buildListMessage(transactions));
}

async function handleDeleteLast(chatId: number): Promise<void> {
  const sheets = getSheets();
  const result = await sheets.deleteLastTransaction();
  console.log("[handleDeleteLast] result:", JSON.stringify(result));

  if (!result.success) {
    await sendMessage(chatId, `❌ ${result.message}`);
    return;
  }

  const d = result.deleted!;
  await sendMessage(
    chatId,
    `🗑 <b>Dihapus!</b>\n\n${d.category} — ${formatIDR(d.amount)}\n${d.merchant ? `🏪 ${d.merchant}\n` : ""}📅 ${d.date}\n<code>${d.id}</code>`
  );
}

async function handleDeleteById(chatId: number, id: string): Promise<void> {
  const sheets = getSheets();
  const result = await sheets.deleteTransaction(id);
  console.log("[handleDeleteById] result:", JSON.stringify(result));

  if (!result.success) {
    await sendMessage(chatId, `❌ ${result.message}`);
    return;
  }

  const d = result.deleted!;
  await sendMessage(
    chatId,
    `🗑 <b>Dihapus!</b>\n\n${d.category} — ${formatIDR(d.amount)}\n📅 ${d.date}\n<code>${d.id}</code>`
  );
}

async function handleBudget(chatId: number): Promise<void> {
  const sheets = getSheets();
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const summary = await sheets.getMonthlySummary(now.getMonth() + 1, now.getFullYear());
  console.log("[handleBudget] categories:", summary.by_category.length);
  await sendMessage(chatId, buildBudgetMessage(summary));
}

async function handleCategories(chatId: number): Promise<void> {
  const sheets = getSheets();
  const categories = await sheets.getCategories();
  console.log("[handleCategories] count:", categories.length);
  await sendMessage(chatId, buildCategoriesMessage(categories));
}

async function handleSplitBill(
  imageBytes: Uint8Array,
  caption: string,
  chatId: number
): Promise<void> {
  const result = await parseSplitBillWithGemini(imageBytes, caption);
  console.log("[handleSplitBill] people:", result.people.length, "total:", result.grand_total);
  // Split bills are not saved to the sheet — display only
  await sendMessage(chatId, buildSplitResultMessage(result));
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  try {
    // 1. Verify webhook secret (only if set)
    const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
      console.warn("[auth] invalid secret:", secret);
      return new Response("Unauthorized", { status: 401 });
    }

    // 2. Parse update
    const update: TelegramUpdate = await req.json();
    console.log("[update]", JSON.stringify(update));

    const message = update.message;
    if (!message) return new Response("ok", { status: 200 });

    const chatId = message.chat.id;
    const caption = message.caption?.trim() ?? "";

    // 3. Route
    if (message.photo && message.photo.length > 0) {
      const photo = message.photo[message.photo.length - 1];

      if (isSplitRequest(caption)) {
        await sendMessage(chatId, "🧮 Menghitung split tagihan...");
        const imageBytes = await downloadTelegramPhoto(photo.file_id);
        await handleSplitBill(imageBytes, caption, chatId);
      } else {
        await sendMessage(chatId, "🔍 Memproses struk...");
        const imageBytes = await downloadTelegramPhoto(photo.file_id);
        // Use file_id as a stable image reference
        const imageUrl = `tg://file/${photo.file_id}`;
        await handleExpenseScan(imageBytes, imageUrl, chatId);
      }

    } else if (message.text) {
      const text = message.text.trim();

      // Slash commands
      if (text === "/start" || text === "/help") {
        await sendMessage(chatId, buildHelpMessage());
        return new Response("ok", { status: 200 });
      }
      if (text === "/list") {
        await handleList(chatId);
        return new Response("ok", { status: 200 });
      }
      if (text === "/summary") {
        await handleSummary(chatId);
        return new Response("ok", { status: 200 });
      }
      if (text === "/budget") {
        await handleBudget(chatId);
        return new Response("ok", { status: 200 });
      }
      if (text === "/categories") {
        await handleCategories(chatId);
        return new Response("ok", { status: 200 });
      }
      if (text === "/hapus") {
        await handleDeleteLast(chatId);
        return new Response("ok", { status: 200 });
      }

      // Delete by ID — match "delete txn_...", "/delete txn_...", "hapus txn_..."
      const txnIdMatch = text.match(/\b(txn_\d+)\b/);
      if (txnIdMatch) {
        await handleDeleteById(chatId, txnIdMatch[1]);
        return new Response("ok", { status: 200 });
      }

      // Natural language
      const parsed = await parseTextWithGemini(text);
      console.log("[text] parsed:", JSON.stringify(parsed));

      switch (parsed.action) {
        case "create":       await handleCreateFromText(parsed, chatId); break;
        case "summary":      await handleSummary(chatId); break;
        case "delete_last":  await handleDeleteLast(chatId); break;
        case "list":         await handleList(chatId); break;
        case "budget":       await handleBudget(chatId); break;
        case "categories":   await handleCategories(chatId); break;
        default:             await sendMessage(chatId, buildHelpMessage());
      }
    }

    return new Response("ok", { status: 200 });

  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error("[error]", e.message, e.stack);
    return new Response("ok", { status: 200 }); // Always 200 to avoid Telegram retries
  }
});
