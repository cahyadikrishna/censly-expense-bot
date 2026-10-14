/**
 * Offline unit tests for llm.ts — fetch is stubbed, no network permission granted.
 * Run: deno task test:unit
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { parseDebt, parseExpenseImage, parseText } from "../llm.ts";

const TODAY = "2026-10-15";

// deno-lint-ignore no-explicit-any
type Body = any;

function completion(content: string | null) {
  return new Response(
    JSON.stringify({
      id: "test",
      object: "chat.completion",
      created: 0,
      model: "deepseek-flash",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** Stub fetch with a queue of response contents; records request bodies and URLs. */
function stubFetch(contents: (string | null)[]) {
  const original = globalThis.fetch;
  const calls: { url: string; body: Body; auth: string | null }[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, body: await req.json(), auth: req.headers.get("authorization") });
    const next = contents.shift();
    if (next === undefined) throw new Error("unexpected extra fetch call");
    return completion(next);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function withEnv(fn: () => Promise<void>) {
  return async () => {
    Deno.env.set("DEEPSEEK_API_KEY", "sk-test");
    Deno.env.delete("DEEPSEEK_MODEL");
    Deno.env.delete("DEEPSEEK_BASE_URL");
    try { await fn(); } finally { Deno.env.delete("DEEPSEEK_API_KEY"); }
  };
}

Deno.test("parseText sends DeepSeek JSON-mode, non-thinking request", withEnv(async () => {
  const f = stubFetch([`{"action":"create","type":"expense","amount":45000,"category":"Makan"}`]);
  try {
    const parsed = await parseText("makan siang 45rb", TODAY);
    assertEquals(parsed.action, "create");
    assertEquals(parsed.amount, 45000);

    assertEquals(f.calls.length, 1);
    const { url, body, auth } = f.calls[0];
    assertEquals(url, "https://api.deepseek.com/chat/completions");
    assertEquals(auth, "Bearer sk-test");
    assertEquals(body.model, "deepseek-flash");
    assertEquals(body.response_format, { type: "json_object" });
    assertEquals(body.thinking, { type: "disabled" });
    assertEquals(body.temperature, 0);
    assertEquals(body.messages.length, 1);
    assertEquals(body.messages[0].role, "user");
    const text: string = body.messages[0].content[0].text;
    assert(text.includes("JSON"), "prompt must mention JSON for DeepSeek JSON mode");
    assert(text.includes(`today: ${TODAY}`));
    assert(text.includes(`Message: "makan siang 45rb"`));
  } finally { f.restore(); }
}));

Deno.test("parseExpenseImage attaches image as base64 data URL in user message", withEnv(async () => {
  const f = stubFetch([`{"category":"Makan","amount":50000,"merchant":"X","note":"","date":"${TODAY}"}`]);
  try {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const parsed = await parseExpenseImage(bytes, TODAY);
    assertEquals(parsed.amount, 50000);

    const content = f.calls[0].body.messages[0].content;
    assertEquals(content.length, 2);
    assertEquals(content[1].type, "image_url");
    assertEquals(content[1].image_url.url, "data:image/jpeg;base64,/9j/4A==");
  } finally { f.restore(); }
}));

Deno.test("respects DEEPSEEK_MODEL and DEEPSEEK_BASE_URL overrides", withEnv(async () => {
  Deno.env.set("DEEPSEEK_MODEL", "deepseek-v4-pro");
  Deno.env.set("DEEPSEEK_BASE_URL", "https://example.test/v1");
  const f = stubFetch([`{"person_name":"Widhi","item":"drink","amount":170000}`]);
  try {
    await parseDebt("deb widhi drink 170k", TODAY);
    assertEquals(f.calls[0].url, "https://example.test/v1/chat/completions");
    assertEquals(f.calls[0].body.model, "deepseek-v4-pro");
  } finally {
    f.restore();
    Deno.env.delete("DEEPSEEK_MODEL");
    Deno.env.delete("DEEPSEEK_BASE_URL");
  }
}));

Deno.test("strips markdown code fences", withEnv(async () => {
  const f = stubFetch(["```json\n{\"action\":\"summary\"}\n```"]);
  try {
    const parsed = await parseText("rekap", TODAY);
    assertEquals(parsed.action, "summary");
  } finally { f.restore(); }
}));

Deno.test("retries once on empty content", withEnv(async () => {
  const f = stubFetch(["", `{"action":"list"}`]);
  try {
    const parsed = await parseText("list", TODAY);
    assertEquals(parsed.action, "list");
    assertEquals(f.calls.length, 2);
  } finally { f.restore(); }
}));

Deno.test("retries once on null content", withEnv(async () => {
  const f = stubFetch([null, `{"action":"budget"}`]);
  try {
    const parsed = await parseText("budget", TODAY);
    assertEquals(parsed.action, "budget");
  } finally { f.restore(); }
}));

Deno.test("throws after two invalid responses", withEnv(async () => {
  const f = stubFetch(["not json", "{still not json"]);
  try {
    await assertRejects(() => parseText("??", TODAY), Error, "LLM failed after 2 attempts");
    assertEquals(f.calls.length, 2);
  } finally { f.restore(); }
}));

Deno.test("throws without API key and makes no request", async () => {
  Deno.env.delete("DEEPSEEK_API_KEY");
  const f = stubFetch([]);
  try {
    await assertRejects(() => parseText("x", TODAY), Error, "DEEPSEEK_API_KEY is not set");
    assertEquals(f.calls.length, 0);
  } finally { f.restore(); }
});
