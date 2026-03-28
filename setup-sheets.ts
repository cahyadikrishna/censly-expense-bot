/**
 * setup-sheets.ts
 * Run once to create and configure the Censly Google Sheets template.
 *
 * Usage:
 *   GOOGLE_SERVICE_ACCOUNT_KEY='<json>' GOOGLE_SPREADSHEET_ID='<id>' deno run --allow-net --allow-env setup-sheets.ts
 *
 * Or if creating a new spreadsheet, omit GOOGLE_SPREADSHEET_ID and it will be created.
 */

import { JWT } from "npm:google-auth-library";
import { google } from "npm:googleapis";

const SERVICE_ACCOUNT_KEY = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") ?? "{}");
const SPREADSHEET_ID = Deno.env.get("GOOGLE_SPREADSHEET_ID") ?? "";

// ── Auth ──────────────────────────────────────────────────────────────────────

const auth = new JWT({
  email: SERVICE_ACCOUNT_KEY.client_email,
  key: SERVICE_ACCOUNT_KEY.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getSpreadsheet(id: string) {
  const res = await sheets.spreadsheets.get({ spreadsheetId: id });
  return res.data;
}

async function batchUpdate(spreadsheetId: string, requests: object[]) {
  return sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

// ── Sheet IDs (will be filled after creation) ─────────────────────────────────

let SHEET_IDS = { transactions: 0, dashboard: 1, categories: 2, dashboardV2: 3 };

// ── 1. Ensure sheets exist with correct names ─────────────────────────────────

async function setupSheets(spreadsheetId: string) {
  const spreadsheet = await getSpreadsheet(spreadsheetId);
  const existing = (spreadsheet.sheets ?? []).map((s) => ({
    title: s.properties?.title ?? "",
    id: s.properties?.sheetId ?? 0,
  }));

  const needed = ["Transactions", "Dashboard", "Categories", "Dashboard v2"];
  const requests: object[] = [];

  for (const name of needed) {
    const found = existing.find((s) => s.title === name);
    if (!found) {
      requests.push({ addSheet: { properties: { title: name } } });
    }
  }

  if (requests.length > 0) {
    await batchUpdate(spreadsheetId, requests);
    console.log("✅ Created missing sheets");
  }

  // Re-fetch to get sheet IDs
  const updated = await getSpreadsheet(spreadsheetId);
  for (const sheet of updated.sheets ?? []) {
    const title = sheet.properties?.title ?? "";
    const id = sheet.properties?.sheetId ?? 0;
    if (title === "Transactions") SHEET_IDS.transactions = id;
    if (title === "Dashboard") SHEET_IDS.dashboard = id;
    if (title === "Categories") SHEET_IDS.categories = id;
    if (title === "Dashboard v2") SHEET_IDS.dashboardV2 = id;
  }

  console.log("📋 Sheet IDs:", SHEET_IDS);
}

// ── 2. Transactions sheet ─────────────────────────────────────────────────────

async function setupTransactionsSheet(spreadsheetId: string) {
  // Headers
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Transactions!A1:K1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        "id", "date", "time", "category", "subcategory",
        "amount", "currency", "merchant", "note", "source", "raw_image_url",
      ]],
    },
  });

  const sheetId = SHEET_IDS.transactions;

  await batchUpdate(spreadsheetId, [
    // Freeze header row
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    // Bold + background header
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 11 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.1, green: 0.1, blue: 0.1 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    },
    // Column widths
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 160 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 110 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 3 }, properties: { pixelSize: 80 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 3, endIndex: 4 }, properties: { pixelSize: 120 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 5, endIndex: 6 }, properties: { pixelSize: 120 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 7, endIndex: 8 }, properties: { pixelSize: 180 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 10, endIndex: 11 }, properties: { pixelSize: 240 }, fields: "pixelSize" } },
    // Data validation for category column (D)
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 10000, startColumnIndex: 3, endColumnIndex: 4 },
        rule: {
          condition: {
            type: "ONE_OF_LIST",
            values: [
              { userEnteredValue: "Makan" },
              { userEnteredValue: "Transport" },
              { userEnteredValue: "Belanja" },
              { userEnteredValue: "Tagihan" },
              { userEnteredValue: "Kesehatan" },
              { userEnteredValue: "Hiburan" },
              { userEnteredValue: "Gaji" },
              { userEnteredValue: "Freelance" },
              { userEnteredValue: "Lainnya" },
            ],
          },
          showCustomUi: true,
          strict: false,
        },
      },
    },
    // Amount column format (F) — number
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 10000, startColumnIndex: 5, endColumnIndex: 6 },
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    },
  ]);

  console.log("✅ Transactions sheet configured");
}

// ── 3. Categories sheet ───────────────────────────────────────────────────────

async function setupCategoriesSheet(spreadsheetId: string) {
  const categories = [
    ["Makan",     "🍜", "2000000",  "#F87171", "food"],
    ["Transport", "🚗", "1000000",  "#FB923C", "car"],
    ["Belanja",   "🛍️", "1500000",  "#A78BFA", "shopping-bag"],
    ["Tagihan",   "💡", "500000",   "#60A5FA", "zap"],
    ["Kesehatan", "💊", "500000",   "#34D399", "heart"],
    ["Hiburan",   "🎮", "500000",   "#F472B6", "gamepad"],
    ["Gaji",      "💰", "0",        "#4ADE80", "banknote"],
    ["Freelance", "💻", "0",        "#4ADE80", "laptop"],
    ["Lainnya",   "📦", "500000",   "#A3A3A3", "box"],
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Categories!A1:E1",
    valueInputOption: "RAW",
    requestBody: { values: [["category", "emoji", "budget_per_month", "color", "icon_name"]] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Categories!A2:E${categories.length + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: categories },
  });

  const sheetId = SHEET_IDS.categories;

  await batchUpdate(spreadsheetId, [
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 5 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.1, green: 0.1, blue: 0.1 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 130 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 3 }, properties: { pixelSize: 140 }, fields: "pixelSize" } },
  ]);

  console.log("✅ Categories sheet configured");
}

// ── 4. Dashboard v2 sheet ─────────────────────────────────────────────────────
// Uses SUMIFS/COUNTIFS instead of SUMPRODUCT (robust with sparse data/empty cells)
// Uses VALUE() on VLOOKUP to coerce text budget values to numbers

async function setupDashboardV2Sheet(spreadsheetId: string) {
  const sheetId = SHEET_IDS.dashboardV2;
  const S = "'Dashboard v2'"; // sheet name for self-references in formulas
  const now = new Date();

  // Helper: date range start/end for selected month/year
  // NOTE: All formulas use ; as separator (Indonesian locale)
  const START = `DATE(B2;B1;1)`;
  const END   = `EOMONTH(DATE(B2;B1;1);0)`;

  // Static labels + month/year selectors + overview formulas
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        // Month + year selectors
        { range: `${S}!A1`, values: [["Bulan"]] },
        { range: `${S}!B1`, values: [[now.getMonth() + 1]] },
        { range: `${S}!A2`, values: [["Tahun"]] },
        { range: `${S}!B2`, values: [[now.getFullYear()]] },
        // Section: Overview
        { range: `${S}!A4`,  values: [["📊 OVERVIEW"]] },
        { range: `${S}!A5`,  values: [["Total Pengeluaran"]] },
        { range: `${S}!A6`,  values: [["Total Pemasukan"]] },
        { range: `${S}!A7`,  values: [["Rata-rata per Hari"]] },
        { range: `${S}!A8`,  values: [["Jumlah Transaksi"]] },
        // Overview formulas — SUMIFS-based (handles empty cells natively)
        // All formulas use ; separator for Indonesian locale
        {
          range: `${S}!B5`,
          values: [[
            `=IFERROR(SUMIFS(Transactions!F:F;Transactions!B:B;">="&${START};Transactions!B:B;"<="&${END};Transactions!D:D;"<>Gaji";Transactions!D:D;"<>Freelance");0)`,
          ]],
        },
        {
          range: `${S}!B6`,
          values: [[
            `=IFERROR(SUMIFS(Transactions!F:F;Transactions!B:B;">="&${START};Transactions!B:B;"<="&${END};Transactions!D:D;"Gaji")+SUMIFS(Transactions!F:F;Transactions!B:B;">="&${START};Transactions!B:B;"<="&${END};Transactions!D:D;"Freelance");0)`,
          ]],
        },
        {
          range: `${S}!B7`,
          values: [[`=IFERROR(B5/DAY(${END});0)`]],
        },
        {
          range: `${S}!B8`,
          values: [[
            `=IFERROR(COUNTIFS(Transactions!B:B;">="&${START};Transactions!B:B;"<="&${END});0)`,
          ]],
        },
        // Section: By Category
        { range: `${S}!A10`, values: [["📂 PER KATEGORI"]] },
        { range: `${S}!A11`, values: [["Kategori"]] },
        { range: `${S}!B11`, values: [["Spent"]] },
        { range: `${S}!C11`, values: [["%"]] },
        { range: `${S}!D11`, values: [["Qty"]] },
        { range: `${S}!E11`, values: [["Budget"]] },
        { range: `${S}!F11`, values: [["Sisa"]] },
        { range: `${S}!G11`, values: [["Bar"]] },
      ],
    },
  });

  // Category rows (rows 12–20)
  const cats = ["Makan","Transport","Belanja","Tagihan","Kesehatan","Hiburan","Gaji","Freelance","Lainnya"];
  const catData = cats.map((cat, i) => {
    const row = 12 + i;
    return {
      range: `${S}!A${row}:G${row}`,
      values: [[
        cat,
        // Spent (SUMIFS — robust)
        `=IFERROR(SUMIFS(Transactions!F:F;Transactions!B:B;">="&${START};Transactions!B:B;"<="&${END};Transactions!D:D;"${cat}");0)`,
        // % of total expense
        `=IFERROR(B${row}/B5;0)`,
        // Count
        `=IFERROR(COUNTIFS(Transactions!B:B;">="&${START};Transactions!B:B;"<="&${END};Transactions!D:D;"${cat}");0)`,
        // Budget — VALUE() to coerce text strings from Categories sheet
        `=IFERROR(VALUE(VLOOKUP("${cat}";Categories!A:C;3;FALSE));0)`,
        // Remaining
        `=IFERROR(E${row}-B${row};0)`,
        // Sparkline bar (skip for zero-budget / income categories)
        `=IF(E${row}=0;"";IFERROR(SPARKLINE(B${row}/E${row};{"charttype"\\"bar";"max"\\1;"color1"\\IF(B${row}>E${row};"#F87171";"#4ADE80")});""))`,
      ]],
    };
  });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: "USER_ENTERED", data: catData },
  });

  // Top 5 merchants section (rows 22–28)
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: `${S}!A22`, values: [["🏪 TOP MERCHANTS"]] },
        { range: `${S}!A23`, values: [["Merchant"]] },
        { range: `${S}!B23`, values: [["Total"]] },
        {
          range: `${S}!A24`,
          values: [[
            `=IFERROR(SORTN(QUERY({Transactions!H2:H\\Transactions!F2:F\\Transactions!B2:B};"select Col1, sum(Col2) where Col1<>'' and month(Col3)+1="&B1&" and year(Col3)="&B2&" group by Col1 order by sum(Col2) desc label Col1 '', sum(Col2) ''";0);5;0;2;0);"No data")`,
          ]],
        },
      ],
    },
  });

  // Formatting + validation via batchUpdate
  await batchUpdate(spreadsheetId, [
    // Freeze rows 1-2
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 2 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    // Bold section headers (rows 4, 10, 22)
    ...([4, 10, 22]).map((row) => ({
      repeatCell: {
        range: { sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 0, endColumnIndex: 7 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
            textFormat: { bold: true },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    })),
    // Bold table header row 11
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 10, endRowIndex: 11, startColumnIndex: 0, endColumnIndex: 7 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat.textFormat",
      },
    },
    // Overview values B5:B8 — currency
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 4, endRowIndex: 8, startColumnIndex: 1, endColumnIndex: 2 },
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: '"Rp "#,##0' } } },
        fields: "userEnteredFormat.numberFormat",
      },
    },
    // Category Spent + Budget + Sisa columns — currency (B12:B20, E12:F20)
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 11, endRowIndex: 21, startColumnIndex: 1, endColumnIndex: 2 },
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: '"Rp "#,##0' } } },
        fields: "userEnteredFormat.numberFormat",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 11, endRowIndex: 21, startColumnIndex: 4, endColumnIndex: 6 },
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: '"Rp "#,##0' } } },
        fields: "userEnteredFormat.numberFormat",
      },
    },
    // % column (C12:C20)
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 11, endRowIndex: 21, startColumnIndex: 2, endColumnIndex: 3 },
        cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0.0%" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    },
    // Conditional format: over budget → red bg
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 11, endRowIndex: 21, startColumnIndex: 0, endColumnIndex: 7 }],
          booleanRule: {
            condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: "=AND($E12>0;$B12>$E12)" }] },
            format: { backgroundColor: { red: 1, green: 0.9, blue: 0.9 } },
          },
        },
        index: 0,
      },
    },
    // Month dropdown (B1)
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
        rule: {
          condition: {
            type: "ONE_OF_LIST",
            values: Array.from({ length: 12 }, (_, i) => ({ userEnteredValue: String(i + 1) })),
          },
          showCustomUi: true,
          strict: true,
        },
      },
    },
    // Year dropdown (B2)
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 2 },
        rule: {
          condition: {
            type: "ONE_OF_LIST",
            values: [2024, 2025, 2026, 2027, 2028, 2029, 2030].map((y) => ({ userEnteredValue: String(y) })),
          },
          showCustomUi: true,
          strict: true,
        },
      },
    },
    // Column widths
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 160 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 140 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, properties: { pixelSize: 130 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 5, endIndex: 6 }, properties: { pixelSize: 130 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 6, endIndex: 7 }, properties: { pixelSize: 180 }, fields: "pixelSize" } },
  ]);

  console.log("✅ Dashboard v2 sheet configured");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!SPREADSHEET_ID) {
    console.error("❌ Set GOOGLE_SPREADSHEET_ID env var");
    Deno.exit(1);
  }
  if (!SERVICE_ACCOUNT_KEY.client_email) {
    console.error("❌ Set GOOGLE_SERVICE_ACCOUNT_KEY env var");
    Deno.exit(1);
  }

  console.log("🚀 Setting up Censly Google Sheets template...");
  console.log("📄 Spreadsheet ID:", SPREADSHEET_ID);

  await setupSheets(SPREADSHEET_ID);
  await setupTransactionsSheet(SPREADSHEET_ID);
  await setupCategoriesSheet(SPREADSHEET_ID);
  // Old Dashboard left as-is (broken formulas); new v2 replaces it
  await setupDashboardV2Sheet(SPREADSHEET_ID);

  console.log("\n✅ Setup complete!");
  console.log(`🔗 https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`);
}

main().catch(console.error);
