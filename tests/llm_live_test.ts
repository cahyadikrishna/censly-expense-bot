/**
 * Live tests for llm.ts against the real DeepSeek API.
 * Never touches Google Sheets: only llm.ts is imported and network is limited to api.deepseek.com.
 *
 * Setup: DEEPSEEK_API_KEY in .env, receipt photos (jpg/png/webp) in tests/fixtures/
 * Run:   deno task test:live
 */

import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { parseDebt, parseExpenseImage, parseSplitBill, parseText } from "../llm.ts";

const TODAY = "2026-10-15";
const YESTERDAY = "2026-10-14";
const EXPENSE_CATEGORIES = ["Makan", "Transport", "Belanja", "Tagihan", "Kesehatan", "Hiburan", "Lainnya"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ignore = !Deno.env.get("DEEPSEEK_API_KEY");
if (ignore) console.warn("DEEPSEEK_API_KEY not set — live tests skipped");

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  console.log(`⏱  ${label}: ${Math.round(performance.now() - start)}ms`);
  return result;
}

function fixtures(): string[] {
  try {
    return [...Deno.readDirSync("tests/fixtures")]
      .filter((e) => e.isFile && /\.(jpe?g|png|webp)$/i.test(e.name))
      .map((e) => `tests/fixtures/${e.name}`)
      .sort();
  } catch {
    return [];
  }
}

// ── Text ──────────────────────────────────────────────────────────────────────

const TEXT_CASES: { input: string; expect: Record<string, unknown> }[] = [
  { input: "makan siang 45rb",  expect: { action: "create", type: "expense", amount: 45000, category: "Makan" } },
  { input: "gaji 8 juta",       expect: { action: "create", type: "income", amount: 8000000, category: "Gaji" } },
  { input: "bensin 80000",      expect: { action: "create", type: "expense", amount: 80000, category: "Transport" } },
  { input: "kemarin kopi 25rb", expect: { action: "create", type: "expense", amount: 25000, date: YESTERDAY } },
  { input: "rekap bulan ini",   expect: { action: "summary" } },
  { input: "hapus terakhir",    expect: { action: "delete_last" } },
  { input: "budget",            expect: { action: "budget" } },
  { input: "kategori",          expect: { action: "categories" } },
];

for (const { input, expect } of TEXT_CASES) {
  Deno.test({
    name: `parseText: "${input}"`,
    ignore,
    fn: async () => {
      const parsed = await timed(`parseText "${input}"`, () => parseText(input, TODAY));
      console.log("   →", JSON.stringify(parsed));
      for (const [key, value] of Object.entries(expect)) {
        assertEquals((parsed as unknown as Record<string, unknown>)[key], value, `field "${key}"`);
      }
    },
  });
}

// ── Debt ──────────────────────────────────────────────────────────────────────

Deno.test({
  name: `parseDebt: "deb widhi drink 170k"`,
  ignore,
  fn: async () => {
    const parsed = await timed("parseDebt", () => parseDebt("deb widhi drink 170k", TODAY));
    console.log("   →", JSON.stringify(parsed));
    assertEquals(parsed.person_name.toLowerCase(), "widhi");
    assertEquals(parsed.amount, 170000);
    assert(parsed.item.toLowerCase().includes("drink"));
  },
});

Deno.test({
  name: `parseDebt: "deb budi makan siang 85rb"`,
  ignore,
  fn: async () => {
    const parsed = await timed("parseDebt", () => parseDebt("deb budi makan siang 85rb", TODAY));
    console.log("   →", JSON.stringify(parsed));
    assertEquals(parsed.person_name.toLowerCase(), "budi");
    assertEquals(parsed.amount, 85000);
  },
});

// ── Receipt images ────────────────────────────────────────────────────────────

const images = fixtures();
if (!ignore && images.length === 0) console.warn("No receipt photos in tests/fixtures/ — image tests skipped");

for (const path of images) {
  Deno.test({
    name: `parseExpenseImage: ${path}`,
    ignore,
    fn: async () => {
      const bytes = await Deno.readFile(path);
      const parsed = await timed(`parseExpenseImage ${path}`, () => parseExpenseImage(bytes, TODAY));
      console.log("   →", JSON.stringify(parsed));
      assert(Number.isInteger(parsed.amount) && parsed.amount > 0, `amount should be positive integer, got ${parsed.amount}`);
      assert(EXPENSE_CATEGORIES.includes(parsed.category), `unexpected category ${parsed.category}`);
      assert(DATE_RE.test(parsed.date), `bad date ${parsed.date}`);
      assert(parsed.merchant, "merchant should not be empty");
    },
  });
}

if (images.length > 0) {
  Deno.test({
    name: `parseSplitBill: ${images[0]} (2 people, equal split)`,
    ignore,
    fn: async () => {
      const bytes = await Deno.readFile(images[0]);
      const caption = "split this bill\nandi dan budi, semua dibagi rata";
      const result = await timed("parseSplitBill", () => parseSplitBill(bytes, caption, TODAY));
      console.log("   →", JSON.stringify(result));
      assertEquals(result.people.length, 2);
      assert(result.grand_total > 0);
      const unassigned = result.unassigned_items.reduce((s, i) => s + i.price * i.quantity, 0);
      const sum = result.people.reduce((s, p) => s + p.total, 0);
      // Allow small rounding differences (≤ Rp 10 per person)
      assert(
        Math.abs(sum - (result.grand_total - unassigned)) <= 10 * result.people.length,
        `people totals ${sum} != grand_total ${result.grand_total} - unassigned ${unassigned}`,
      );
    },
  });
}
