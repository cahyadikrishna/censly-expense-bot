/**
 * Offline tests for split.ts — pure math, no network.
 * Run: deno task test:unit
 */

import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { allocate, computeSplit } from "../split.ts";
import type { SplitExtraction } from "../split.ts";

// SKYE Menara BCA receipt: subtotal 745.000, service 74.500, PB1 81.950, total 901.450
function skye(overrides: Partial<SplitExtraction> = {}): SplitExtraction {
  return {
    store_name: "SKYE",
    date: "2015-08-03",
    items: [
      { name: "Lamb Chops",      price: 265000, quantity: 1, assigned_to: ["a"] },
      { name: "Roasted Chicken", price: 135000, quantity: 1, assigned_to: ["b"] },
      { name: "Al Tartufo",      price: 155000, quantity: 1, assigned_to: ["c"] },
      { name: "Lemongrass tea",  price: 45000,  quantity: 1, assigned_to: ["a"] },
      { name: "Orange Jc",       price: 50000,  quantity: 1, assigned_to: ["b"] },
      { name: "Evian Large",     price: 95000,  quantity: 1, assigned_to: [] },
    ],
    subtotal: 745000,
    tax: 81950,
    service: 74500,
    grand_total: 901450,
    people: ["a", "b", "c"],
    tax_split: "equal",
    ...overrides,
  };
}

const totals = (r: ReturnType<typeof computeSplit>) => r.people.map((p) => p.total);
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

Deno.test("allocate always sums exactly to total", () => {
  assertEquals(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assertEquals(sum(allocate(95000, [1, 1, 1])), 95000);
  assertEquals(sum(allocate(81950, [310000, 185000, 155000])), 81950);
  assertEquals(allocate(10, [0, 0]), [5, 5], "zero weights fall back to equal");
  assertEquals(allocate(0, [1, 2]), [0, 0]);
});

Deno.test("SKYE: equal tax/service, shared Evian", () => {
  const r = computeSplit(skye());
  // own + Evian 31667/31667/31666 + PB1 27317/27317/27316 + service 24834/24833/24833
  assertEquals(totals(r), [393818, 268817, 238815]);
  assertEquals(sum(totals(r)), 901450);
  assertEquals(r.unassigned_items, []);
  assertEquals(r.people[0].tax + r.people[1].tax + r.people[2].tax, 81950);
  assertEquals(r.people[0].service + r.people[1].service + r.people[2].service, 74500);
  assert(r.people[2].items.some((i) => i.name === "Evian Large (1/3)"));
});

Deno.test("SKYE: proportional tax/service", () => {
  const r = computeSplit(skye({ tax_split: "proportional" }));
  assertEquals(sum(totals(r)), 901450);
  // a has the highest subtotal so pays the most tax
  assert(r.people[0].tax > r.people[1].tax && r.people[1].tax > r.people[2].tax);
  for (const [i, expected] of [413417, 262167, 225867].entries()) {
    // ±3 for per-component rounding
    assert(Math.abs(r.people[i].total - expected) <= 3, `${r.people[i].name}: ${r.people[i].total} vs ${expected}`);
  }
});

Deno.test("small price misread still sums to the printed grand total", () => {
  const s = skye();
  s.items[2].price = 156000; // model misread Al Tartufo
  const r = computeSplit(s);
  assertEquals(sum(totals(r)), 901450);
});

Deno.test("discount (total below items + tax) is shared by subtotal", () => {
  const r = computeSplit({
    store_name: "X", date: "2026-10-15",
    items: [
      { name: "A", price: 60000, quantity: 1, assigned_to: ["andi"] },
      { name: "B", price: 40000, quantity: 1, assigned_to: ["budi"] },
    ],
    subtotal: 100000, tax: 10000, service: 0, grand_total: 90000,
    people: ["andi", "budi"], tax_split: "equal",
  });
  assertEquals(sum(totals(r)), 90000);
  // items 60k/40k − discount 20k by subtotal (12k/8k) + tax 5k each
  assertEquals(totals(r), [53000, 37000]);
});

Deno.test("no people named → one person pays everything", () => {
  const r = computeSplit(skye({ people: [], items: skye().items.map((i) => ({ ...i, assigned_to: [] })) }));
  assertEquals(r.people.length, 1);
  assertEquals(r.people[0].name, "Kamu");
  assertEquals(r.people[0].total, 901450);
});

Deno.test("unknown assignee and case differences are handled", () => {
  const s = skye({ people: ["A", "b", "c", "a"] });
  s.items[0].assigned_to = ["A"];
  s.items[1].assigned_to = ["zoe"]; // not a known person → shared
  const r = computeSplit(s);
  assertEquals(r.people.map((p) => p.name), ["A", "b", "c"]);
  assertEquals(sum(totals(r)), 901450);
  assert(r.people[1].items.some((i) => i.name === "Roasted Chicken (1/3)"));
});

Deno.test("item shared by a subset of people", () => {
  const s = skye();
  s.items[5].assigned_to = ["a", "b"]; // Evian only for a & b
  const r = computeSplit(s);
  assertEquals(sum(totals(r)), 901450);
  assert(!r.people[2].items.some((i) => i.name.startsWith("Evian")));
  assert(r.people[0].items.some((i) => i.name === "Evian Large (1/2)"));
});
