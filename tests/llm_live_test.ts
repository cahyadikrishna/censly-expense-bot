/**
 * Live tests for llm.ts against the real DeepSeek API.
 * Never touches Google Sheets: only llm.ts is imported and network is limited to api.deepseek.com.
 *
 * Setup: DEEPSEEK_API_KEY in .env, receipt photos (jpg/png/webp) in tests/fixtures/
 * Run:   deno task test:live
 */

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.13";
import { parseDebt, parseExpenseImage, parseSplitBill, parseText } from "../llm.ts";
import type { PersonShare, SplitBillResult } from "../llm.ts";

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

// Known values for fixtures, matched by filename substring. Unknown fixtures get shape checks only.
const KNOWN_RECEIPTS: { match: string; amount: number; date: string; merchant: RegExp }[] = [
  { match: "4171e725", amount: 12800,  date: "2020-11-07", merchant: /indomaret/i },
  { match: "owAtJOHf", amount: 75400,  date: "2024-04-04", merchant: /indomaret/i },
  { match: "skye",     amount: 901450, date: "2015-08-03", merchant: /skye/i },
];

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

      const known = KNOWN_RECEIPTS.find((k) => path.toLowerCase().includes(k.match.toLowerCase()));
      if (known) {
        assertEquals(parsed.amount, known.amount, "amount (TOTAL after discounts)");
        assertEquals(parsed.date, known.date, "date");
        assertMatch(parsed.merchant, known.merchant);
      }
    },
  });
}

// ── Split bill (SKYE restaurant, 3 people) ────────────────────────────────────
// Items: Lamb Chops 265k, Roasted Chicken 135k, Al Tartufo 155k, Lemongrass tea 45k,
// Orange Jc 50k, Evian Large 95k. Subtotal 745k, Service 74.5k, PB1 81.95k, Total 901.450.

const splitImage = images.find((p) => /split/i.test(p));
const SPLIT_GRAND_TOTAL = 901450;

function findPerson(result: SplitBillResult, name: string): PersonShare {
  const p = result.people.find((x) => x.name.toLowerCase() === name);
  assert(p, `person "${name}" missing, got ${result.people.map((x) => x.name).join(", ")}`);
  return p;
}

function hasItem(person: PersonShare, pattern: RegExp): boolean {
  return person.items.some((i) => pattern.test(i.name));
}

function assertSplitConsistent(result: SplitBillResult) {
  assertEquals(result.grand_total, SPLIT_GRAND_TOTAL, "grand_total");
  assertEquals(result.people.length, 3, "people count");
  assertEquals(result.unassigned_items, [], "split.ts assigns everything");
  const sum = result.people.reduce((s, p) => s + p.total, 0);
  assertEquals(sum, SPLIT_GRAND_TOTAL, "people totals must add up to the receipt total exactly");
  const a = findPerson(result, "a"), b = findPerson(result, "b"), c = findPerson(result, "c");
  assert(hasItem(a, /lamb/i) && hasItem(a, /lemongrass/i), `a items: ${JSON.stringify(a.items)}`);
  assert(hasItem(b, /chicken/i) && hasItem(b, /orange/i), `b items: ${JSON.stringify(b.items)}`);
  assert(hasItem(c, /tartufo/i), `c items: ${JSON.stringify(c.items)}`);
  for (const p of [a, b, c]) assert(hasItem(p, /evian/i), `${p.name} should share Evian`);
  return { a, b, c };
}

/**
 * Expected total = own items + Evian/3 + tax/service share.
 * Tolerance Rp 1.500 absorbs a single-digit OCR misread on one line (e.g. 155.000 → 156.000);
 * the exact sum check above still guarantees the bill is fully covered.
 */
function assertTotalNear(person: PersonShare, expected: number) {
  assert(Math.abs(person.total - expected) <= 1500, `${person.name}: total ${person.total}, expected ≈${Math.round(expected)}`);
}

if (splitImage) {
  const EXTRAS = 74500 + 81950;    // service + PB1
  const EVIAN_SHARE = 95000 / 3;
  const OWN = { a: 265000 + 45000, b: 135000 + 50000, c: 155000 };

  Deno.test({
    name: `parseSplitBill: 3 people, tax/service equal (default)`,
    ignore,
    fn: async () => {
      const bytes = await Deno.readFile(splitImage);
      const caption =
        "split this bill\n" +
        "a: lamb chops, lemongrass tea\n" +
        "b: roasted chicken, orange juice\n" +
        "c: al tartufo\n" +
        "evian dibagi rata";
      const result = await timed("parseSplitBill equal", () => parseSplitBill(bytes, caption, TODAY));
      console.log("   →", JSON.stringify(result));
      const { a, b, c } = assertSplitConsistent(result);
      assertTotalNear(a, OWN.a + EVIAN_SHARE + EXTRAS / 3);
      assertTotalNear(b, OWN.b + EVIAN_SHARE + EXTRAS / 3);
      assertTotalNear(c, OWN.c + EVIAN_SHARE + EXTRAS / 3);
    },
  });

  Deno.test({
    name: `parseSplitBill: 3 people, tax/service proporsional`,
    ignore,
    fn: async () => {
      const bytes = await Deno.readFile(splitImage);
      const caption =
        "split this bill\n" +
        "a: lamb chops, lemongrass tea\n" +
        "b: roasted chicken, orange juice\n" +
        "c: al tartufo\n" +
        "evian dibagi rata\n" +
        "tax dan service proporsional";
      const result = await timed("parseSplitBill proportional", () => parseSplitBill(bytes, caption, TODAY));
      console.log("   →", JSON.stringify(result));
      const { a, b, c } = assertSplitConsistent(result);
      const ratio = 1 + EXTRAS / 745000;
      assertTotalNear(a, (OWN.a + EVIAN_SHARE) * ratio);
      assertTotalNear(b, (OWN.b + EVIAN_SHARE) * ratio);
      assertTotalNear(c, (OWN.c + EVIAN_SHARE) * ratio);
    },
  });
}
