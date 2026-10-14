/**
 * sheets.ts — Google Sheets API service for Censly Edge Function
 * Handles all CRUD operations against the spreadsheet.
 *
 * Auth: Service Account via JWT — no OAuth redirect needed.
 * All timestamps in Asia/Makassar (WITA, UTC+8).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * sheets.ts — Google Sheets API service for Censly Edge Function
 * Handles all CRUD operations against the spreadsheet.
 *
 * Auth: Service Account via JWT — no OAuth redirect needed.
 * All timestamps in Asia/Makassar (WITA, UTC+8).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TransactionRow {
  id: string;
  date: string;         // YYYY-MM-DD
  time: string;         // HH:MM
  category: string;
  subcategory: string;
  amount: number;
  currency: string;
  merchant: string;
  note: string;
  source: string;
  raw_image_url: string;
}

export interface CategoryRow {
  category: string;
  emoji: string;
  budget_per_month: number;
  color: string;
  icon_name: string;
}

export interface MonthlySummary {
  month: number;
  year: number;
  total: number;
  average_per_day: number;
  count: number;
  by_category: { category: string; total: number; count: number; budget: number; remaining: number }[];
  top_merchants: { merchant: string; total: number; count: number }[];
  daily_trend: { day: number; total: number }[];
}

export interface DebtRow {
  id: string;
  date: string;       // YYYY-MM-DD
  time: string;       // HH:MM
  person_name: string;
  item: string;
  amount: number;
  currency: string;
}

interface SheetsConfig {
  spreadsheetId: string;
  serviceAccountKey: {
    client_email: string;
    private_key: string;
  };
}

// ── JWT Auth (pure fetch, no npm dependency in Edge Function) ─────────────────

function b64url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlFromBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(config: SheetsConfig): Promise<string> {
  const { client_email, private_key } = config.serviceAccountKey;
  const scope = "https://www.googleapis.com/auth/spreadsheets";
  const now = Math.floor(Date.now() / 1000);

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  }));

  const signingInput = `${header}.${payload}`;

  // Import the private key
  const pemKey = private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");

  const keyData = Uint8Array.from(atob(pemKey), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const sigB64 = b64urlFromBytes(new Uint8Array(signature));
  const jwt = `${signingInput}.${sigB64}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const tokenJson = await tokenRes.json();
  if (!tokenJson.access_token) {
    throw new Error(`Failed to get access token: ${JSON.stringify(tokenJson)}`);
  }
  return tokenJson.access_token;
}

// ── Sheets API fetch wrapper ──────────────────────────────────────────────────

async function sheetsGet(
  token: string,
  spreadsheetId: string,
  range: string
): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Sheets GET error: ${JSON.stringify(json)}`);
  return (json.values ?? []) as string[][];
}

async function sheetsAppend(
  token: string,
  spreadsheetId: string,
  range: string,
  values: (string | number)[][]
): Promise<void> {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Sheets APPEND error: ${JSON.stringify(json)}`);
}

async function sheetsBatchGet(
  token: string,
  spreadsheetId: string,
  ranges: string[]
): Promise<string[][][]> {
  const params = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Sheets batchGet error: ${JSON.stringify(json)}`);
  return (json.valueRanges ?? []).map((vr: { values?: string[][] }) => vr.values ?? []);
}

async function sheetsUpdate(
  token: string,
  spreadsheetId: string,
  range: string,
  values: (string | number)[][]
): Promise<void> {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}` +
    `?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Sheets UPDATE error: ${JSON.stringify(json)}`);
}

// ── WITA timezone helper ──────────────────────────────────────────────────────

function witaNow(): { date: string; time: string } {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000); // UTC+8
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 16);
  return { date, time };
}

function generateId(): string {
  return `txn_${Date.now()}`;
}

// Convert Excel serial date (e.g. 46109) to "YYYY-MM-DD"
// and serial time fraction (e.g. 0.53) to "HH:MM"
function parseSheetDate(val: unknown): string {
  if (typeof val === "number") {
    // Excel epoch: 1899-12-30
    const ms = (val - 25569) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return String(val ?? "");
}

function parseSheetTime(val: unknown): string {
  if (typeof val === "number") {
    const totalMinutes = Math.round(val * 1440);
    const h = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
    const m = String(totalMinutes % 60).padStart(2, "0");
    return `${h}:${m}`;
  }
  return String(val ?? "");
}

// ── SheetsService class ───────────────────────────────────────────────────────

export class SheetsService {
  private spreadsheetId: string;
  private config: SheetsConfig;
  private _token: string | null = null;
  private _tokenExpiry = 0;

  constructor(spreadsheetId: string, serviceAccountKey: SheetsConfig["serviceAccountKey"]) {
    this.spreadsheetId = spreadsheetId;
    this.config = { spreadsheetId, serviceAccountKey };
  }

  private async token(): Promise<string> {
    // Cache token for 50 minutes (expires in 60)
    if (this._token && Date.now() < this._tokenExpiry) return this._token;
    this._token = await getAccessToken(this.config);
    this._tokenExpiry = Date.now() + 50 * 60 * 1000;
    return this._token;
  }

  // ── addTransaction ──────────────────────────────────────────────────────────

  async addTransaction(data: Omit<TransactionRow, "id">): Promise<{ success: boolean; id: string; message: string }> {
    const token = await this.token();
    const id = generateId();
    const row = [
      id,
      data.date,
      data.time,
      data.category,
      data.subcategory,
      data.amount,
      data.currency || "IDR",
      data.merchant,
      data.note,
      data.source || "receipt_scan",
      data.raw_image_url,
    ];

    await sheetsAppend(token, this.spreadsheetId, "Transactions!A:K", [row]);
    console.log("[sheets] addTransaction:", id);
    return { success: true, id, message: `Transaction ${id} added` };
  }

  // ── getTransactions ─────────────────────────────────────────────────────────

  async getTransactions(filters: {
    month?: number;
    year?: number;
    category?: string;
    limit?: number;
  } = {}): Promise<TransactionRow[]> {
    const token = await this.token();
    const rows = await sheetsGet(token, this.spreadsheetId, "Transactions!A2:K10000");

    let transactions = rows
      .filter((r) => r.length >= 6 && r[0])
      .map((r): TransactionRow => ({
        id: String(r[0] ?? ""),
        date: parseSheetDate(r[1]),
        time: parseSheetTime(r[2]),
        category: String(r[3] ?? ""),
        subcategory: String(r[4] ?? ""),
        amount: Number(r[5]) || 0,
        currency: String(r[6] ?? "IDR"),
        merchant: String(r[7] ?? ""),
        note: String(r[8] ?? ""),
        source: String(r[9] ?? ""),
        raw_image_url: String(r[10] ?? ""),
      }));

    if (filters.month !== undefined && filters.year !== undefined) {
      transactions = transactions.filter((t) => {
        if (!t.date) return false;
        const d = new Date(t.date);
        return d.getMonth() + 1 === filters.month && d.getFullYear() === filters.year;
      });
    }

    if (filters.category) {
      transactions = transactions.filter(
        (t) => t.category.toLowerCase() === filters.category!.toLowerCase()
      );
    }

    // Most recent first
    transactions.sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`));

    if (filters.limit) transactions = transactions.slice(0, filters.limit);

    return transactions;
  }

  // ── getMonthlySummary ───────────────────────────────────────────────────────

  async getMonthlySummary(month: number, year: number): Promise<MonthlySummary> {
    const [transactions, categories] = await Promise.all([
      this.getTransactions({ month, year }),
      this.getCategories(),
    ]);

    const expenseTransactions = transactions.filter(
      (t) => t.category !== "Gaji" && t.category !== "Freelance"
    );

    const total = expenseTransactions.reduce((s, t) => s + t.amount, 0);
    const daysInMonth = new Date(year, month, 0).getDate();
    const average_per_day = total / daysInMonth;
    const count = expenseTransactions.length;

    // By category
    const categoryMap = new Map<string, { total: number; count: number }>();
    for (const t of expenseTransactions) {
      const cur = categoryMap.get(t.category) ?? { total: 0, count: 0 };
      categoryMap.set(t.category, { total: cur.total + t.amount, count: cur.count + 1 });
    }

    const by_category = Array.from(categoryMap.entries()).map(([category, data]) => {
      const catConfig = categories.find((c) => c.category === category);
      const budget = catConfig?.budget_per_month ?? 0;
      return { category, ...data, budget, remaining: budget - data.total };
    }).sort((a, b) => b.total - a.total);

    // Top merchants
    const merchantMap = new Map<string, { total: number; count: number }>();
    for (const t of expenseTransactions) {
      if (!t.merchant) continue;
      const cur = merchantMap.get(t.merchant) ?? { total: 0, count: 0 };
      merchantMap.set(t.merchant, { total: cur.total + t.amount, count: cur.count + 1 });
    }
    const top_merchants = Array.from(merchantMap.entries())
      .map(([merchant, data]) => ({ merchant, ...data }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);

    // Daily trend
    const dailyMap = new Map<number, number>();
    for (const t of expenseTransactions) {
      const day = new Date(t.date).getDate();
      dailyMap.set(day, (dailyMap.get(day) ?? 0) + t.amount);
    }
    const daily_trend = Array.from({ length: daysInMonth }, (_, i) => ({
      day: i + 1,
      total: dailyMap.get(i + 1) ?? 0,
    }));

    return { month, year, total, average_per_day, count, by_category, top_merchants, daily_trend };
  }

  // ── updateTransaction ───────────────────────────────────────────────────────

  async updateTransaction(
    id: string,
    updates: Partial<Omit<TransactionRow, "id">>
  ): Promise<{ success: boolean; message: string }> {
    const token = await this.token();
    // Fetch full column A:K (including header) so array index = sheet row index
    const allRows = await sheetsGet(token, this.spreadsheetId, "Transactions!A:K");

    let matchIndex = -1;
    for (let i = 1; i < allRows.length; i++) {
      if (allRows[i][0] === id) { matchIndex = i; break; }
    }
    if (matchIndex === -1) return { success: false, message: `Transaction ${id} not found` };

    const existing = allRows[matchIndex];
    const updated = [
      existing[0],                          // id (immutable)
      updates.date        ?? existing[1],
      updates.time        ?? existing[2],
      updates.category    ?? existing[3],
      updates.subcategory ?? existing[4],
      updates.amount      ?? existing[5],
      updates.currency    ?? existing[6],
      updates.merchant    ?? existing[7],
      updates.note        ?? existing[8],
      updates.source      ?? existing[9],
      updates.raw_image_url ?? existing[10],
    ];

    // matchIndex is the 0-based array index; sheet row number (1-based) = matchIndex + 1
    const sheetRow = matchIndex + 1;
    await sheetsUpdate(token, this.spreadsheetId, `Transactions!A${sheetRow}:K${sheetRow}`, [updated]);
    console.log("[sheets] updateTransaction:", id, "row:", sheetRow);
    return { success: true, message: `Transaction ${id} updated` };
  }

  // ── deleteTransaction ───────────────────────────────────────────────────────

  async deleteTransaction(id: string): Promise<{ success: boolean; message: string; deleted?: TransactionRow }> {
    const token = await this.token();

    // Fetch column A with row numbers to find the exact sheet row for this ID.
    // values.get can skip empty rows, making array index unreliable for deletion.
    // Using a MATCH-style lookup via the spreadsheet formula would be ideal, but
    // the simplest reliable approach: fetch IDs with row metadata.
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}/values/Transactions!A:K?valueRenderOption=UNFORMATTED_VALUE`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    if (!res.ok) throw new Error(`Sheets GET error: ${JSON.stringify(json)}`);
    const allRows: string[][] = json.values ?? [];

    // allRows[0] = header, allRows[1] = first data row (sheet row 2), etc.
    // allRows index i corresponds to sheet row i (0-based for deleteDimension)
    let matchIndex = -1;
    for (let i = 1; i < allRows.length; i++) {
      if (allRows[i][0] === id) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex === -1) return { success: false, message: `Transaction ${id} not found` };

    const r = allRows[matchIndex];
    const deleted: TransactionRow = {
      id: String(r[0] ?? ""),
      date: parseSheetDate(r[1]),
      time: parseSheetTime(r[2]),
      category: String(r[3] ?? ""),
      subcategory: String(r[4] ?? ""),
      amount: Number(r[5]) || 0,
      currency: String(r[6] ?? "IDR"),
      merchant: String(r[7] ?? ""),
      note: String(r[8] ?? ""),
      source: String(r[9] ?? ""),
      raw_image_url: String(r[10] ?? ""),
    };

    // Get Transactions sheet ID for deleteDimension
    const metaRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}?fields=sheets.properties`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const meta = await metaRes.json();
    const txSheet = meta.sheets?.find((s: { properties: { title: string } }) => s.properties.title === "Transactions");
    const sheetId = txSheet?.properties?.sheetId ?? 0;

    // matchIndex directly maps to the 0-based sheet row index
    // (allRows[0]=header=row0, allRows[1]=first data=row1, etc.)
    const deleteRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}:batchUpdate`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            deleteDimension: {
              range: { sheetId, dimension: "ROWS", startIndex: matchIndex, endIndex: matchIndex + 1 },
            },
          }],
        }),
      },
    );
    const deleteJson = await deleteRes.json();
    if (!deleteRes.ok) throw new Error(`Delete row error: ${JSON.stringify(deleteJson)}`);

    console.log("[sheets] deleteTransaction:", id, "sheetRow:", matchIndex);
    return { success: true, message: `Transaction ${id} deleted`, deleted };
  }

  // ── deleteLastTransaction ───────────────────────────────────────────────────

  async deleteLastTransaction(): Promise<{ success: boolean; message: string; deleted?: TransactionRow }> {
    const transactions = await this.getTransactions({ limit: 1 });
    if (transactions.length === 0) return { success: false, message: "No transactions found" };
    return this.deleteTransaction(transactions[0].id);
  }

  // ── getCategories ───────────────────────────────────────────────────────────

  async getCategories(): Promise<CategoryRow[]> {
    const token = await this.token();
    const rows = await sheetsGet(token, this.spreadsheetId, "Categories!A2:E20");

    return rows
      .filter((r) => r.length >= 1 && r[0])
      .map((r): CategoryRow => ({
        category: r[0] ?? "",
        emoji: r[1] ?? "📦",
        budget_per_month: Number(r[2]) || 0,
        color: r[3] ?? "#A3A3A3",
        icon_name: r[4] ?? "box",
      }));
  }

  // ── addDebt ─────────────────────────────────────────────────────────────────

  async addDebt(data: Omit<DebtRow, "id" | "date" | "time">): Promise<{ success: boolean; id: string; message: string }> {
    const token = await this.token();
    const { date, time } = witaNow();
    const id = `debt_${Date.now()}`;
    const row = [
      id,
      date,
      time,
      data.person_name,
      data.item,
      data.amount,
      data.currency || "IDR",
    ];

    await sheetsAppend(token, this.spreadsheetId, "Debt People!A:G", [row]);
    console.log("[sheets] addDebt:", id, data.person_name, data.item, data.amount);
    return { success: true, id, message: `Debt ${id} added` };
  }

  // ── getDebtsByPerson ────────────────────────────────────────────────────────

  async getDebtsByPerson(personName: string): Promise<DebtRow[]> {
    const token = await this.token();
    const rows = await sheetsGet(token, this.spreadsheetId, "Debt People!A2:G10000");

    const debts = rows
      .filter((r) => r.length >= 6 && r[0] && String(r[3] ?? "").toLowerCase() === personName.toLowerCase())
      .map((r): DebtRow => ({
        id: String(r[0] ?? ""),
        date: parseSheetDate(r[1]),
        time: parseSheetTime(r[2]),
        person_name: String(r[3] ?? ""),
        item: String(r[4] ?? ""),
        amount: Number(r[5]) || 0,
        currency: String(r[6] ?? "IDR"),
      }));

    // Most recent first
    debts.sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`));
    return debts;
  }

  // ── witaNow helper (exposed for Edge Function) ────────────────────────────

  static witaNow = witaNow;
  static generateId = generateId;
}
