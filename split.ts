/**
 * split.ts — Deterministic bill split math for Censly.
 * The LLM only extracts receipt lines and who ordered what; all money math happens here
 * so that people's totals always add up to the receipt's grand total.
 */

import type { BillItem, PersonShare, SplitBillResult } from "./llm.ts";

export interface ExtractedItem {
  name: string;
  price: number;          // line total as printed (already × quantity)
  quantity: number;
  assigned_to: string[];  // empty = shared among everyone
}

export interface SplitExtraction {
  store_name: string;
  date: string;
  items: ExtractedItem[];
  subtotal: number;
  tax: number;
  service: number;
  grand_total: number;
  people: string[];
  tax_split: "equal" | "proportional";
}

const DEFAULT_PERSON = "Kamu";

/**
 * Split `total` into integers following `weights`, using the largest-remainder method
 * so the parts always sum exactly to `total`.
 */
export function allocate(total: number, weights: number[]): number[] {
  const sumW = weights.reduce((s, w) => s + w, 0);
  if (weights.length === 0) return [];
  const w = sumW > 0 ? weights : weights.map(() => 1);
  const sw = sumW > 0 ? sumW : w.length;

  const raw = w.map((x) => (total * x) / sw);
  const parts = raw.map(Math.floor);
  let remainder = total - parts.reduce((s, p) => s + p, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) parts[order[k].i]++;
  return parts;
}

function toInt(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? v : 0;
}

export function computeSplit(x: SplitExtraction): SplitBillResult {
  // Normalise people (case-insensitive, keep first spelling)
  const people: string[] = [];
  for (const p of x.people ?? []) {
    const name = String(p ?? "").trim();
    if (name && !people.some((q) => q.toLowerCase() === name.toLowerCase())) people.push(name);
  }
  if (people.length === 0) people.push(DEFAULT_PERSON);
  const idx = (name: string) => people.findIndex((p) => p.toLowerCase() === name.trim().toLowerCase());

  const items: BillItem[] = (x.items ?? []).map((it) => ({
    name: String(it.name ?? ""),
    price: toInt(it.price),
    quantity: Math.max(1, toInt(it.quantity) || 1),
  }));
  const itemsSum = items.reduce((s, i) => s + i.price, 0);

  // 1. Item shares: assigned people split the line equally; unknown/empty → everyone
  const shares = people.map(() => ({ items: [] as { name: string; price: number }[], subtotal: 0 }));
  (x.items ?? []).forEach((it, n) => {
    const owners = [...new Set((it.assigned_to ?? []).map(idx).filter((i) => i >= 0))];
    const targets = owners.length > 0 ? owners : people.map((_, i) => i);
    const parts = allocate(items[n].price, targets.map(() => 1));
    targets.forEach((p, k) => {
      const label = targets.length > 1 ? `${items[n].name} (1/${targets.length})` : items[n].name;
      shares[p].items.push({ name: label, price: parts[k] });
      shares[p].subtotal += parts[k];
    });
  });

  // 2. Tax & service: equal by default, or proportional to each person's subtotal
  const grandTotal = toInt(x.grand_total) || itemsSum + toInt(x.tax) + toInt(x.service);
  const tax = toInt(x.tax);
  const service = toInt(x.service);
  const weights = x.tax_split === "proportional" ? shares.map((s) => s.subtotal) : shares.map(() => 1);
  const taxParts = allocate(tax, weights);
  const serviceParts = allocate(service, weights);

  // 3. Anything left (discounts, rounding, small misreads) follows item subtotals
  //    so that people's totals add up exactly to the receipt grand total.
  const adjustment = grandTotal - itemsSum - tax - service;
  const adjParts = adjustment >= 0
    ? allocate(adjustment, shares.map((s) => s.subtotal))
    : allocate(-adjustment, shares.map((s) => s.subtotal)).map((v) => -v);

  const result: PersonShare[] = people.map((name, i) => ({
    name,
    items: shares[i].items,
    subtotal: shares[i].subtotal + adjParts[i],
    tax: taxParts[i],
    service: serviceParts[i],
    total: shares[i].subtotal + adjParts[i] + taxParts[i] + serviceParts[i],
  }));

  return {
    store_name: String(x.store_name ?? ""),
    date: String(x.date ?? ""),
    items,
    subtotal: toInt(x.subtotal) || itemsSum,
    tax,
    service,
    grand_total: grandTotal,
    people: result,
    unassigned_items: [],
  };
}
