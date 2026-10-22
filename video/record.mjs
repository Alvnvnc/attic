/**
 * Records the demo: four title/architecture scenes from video/scenes.html and
 * one continuous take of the live app. Writes .webm clips plus a JSON file with
 * the timestamps of each question so narration can be aligned exactly.
 *
 *   node video/record.mjs            # writes to /tmp/attic-video
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const EXEC = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const OUT = process.env.OUT ?? "/tmp/attic-video";
const APP = process.env.APP_URL ?? "http://localhost:8788";
const SCENES = process.env.SCENES_URL ?? "http://localhost:8099/video/scenes.html";
const VIEWPORT = { width: 1600, height: 900 };

const durations = { s1: 16, s2: 38.5, s4: 34, s5: 9.5 };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "raw"), { recursive: true });

const browser = await chromium.launch({ executablePath: EXEC, args: ["--force-color-profile=srgb"] });

async function recordStatic(name, seconds) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: join(OUT, "raw"), size: VIEWPORT },
  });
  const page = await ctx.newPage();
  await page.goto(`${SCENES}?s=${name.replace("s", "")}`, { waitUntil: "load" });
  await page.waitForTimeout(seconds * 1000);
  const path = await page.video().path();
  await ctx.close();
  console.log(`[scene] ${name} ${seconds}s → ${path}`);
  return path;
}

async function recordDemo() {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: join(OUT, "raw"), size: VIEWPORT },
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERR", String(e)));

  await page.goto(APP, { waitUntil: "networkidle" });
  const t0 = Date.now();
  const at = (ms) => Math.max(0, t0 + ms - Date.now());

  const idle = async () => {
    await page.waitForFunction(() => !document.querySelector(".send[disabled]"), null, { timeout: 60_000 });
  };

  const ask = async (text) => {
    await idle();
    const submitted = (Date.now() - t0) / 1000;
    await page.fill("#prompt", text);
    await page.press("#prompt", "Enter");
    await page.waitForFunction(
      () => {
        const turns = document.querySelectorAll(".turn");
        const last = turns[turns.length - 1];
        const a = last?.querySelector(".a");
        return a && a.textContent.trim().length > 12 && !a.classList.contains("is-typing");
      },
      null,
      { timeout: 60_000 },
    );
    const answered = (Date.now() - t0) / 1000;
    return { submitted, answered };
  };

  const events = {};

  await page.waitForTimeout(at(6500));
  events.intro_end = (Date.now() - t0) / 1000;

  events.q1 = await ask("When did we last service the water heater?");
  await page.waitForTimeout(at(events.q1.answered * 1000 + 5200));

  events.q2 = await ask("When does the fridge warranty expire?");
  await page.waitForTimeout(at(events.q2.answered * 1000 + 5000));

  events.q3 = await ask("The dishwasher leak is fixed, ServicePro replaced the pump for 210.");
  await page.waitForTimeout(at(events.q3.answered * 1000 + 6000));

  events.q4 = await ask("What is still broken in the house?");
  await page.waitForTimeout(at(events.q4.answered * 1000 + 6000));

  // linger on the final state, then show the ledger for three seconds
  await page.waitForTimeout(1500);
  await page.goto(`${APP}/#ledger`, { waitUntil: "networkidle" });
  await page.waitForTimeout(4200);
  events.end = (Date.now() - t0) / 1000;

  const path = await page.video().path();
  await ctx.close();
  writeFileSync(join(OUT, "s3-events.json"), JSON.stringify(events, null, 2));
  console.log(`[demo] ${events.end.toFixed(1)}s → ${path}`);
  return path;
}

const clips = {
  s1: await recordStatic("s1", durations.s1),
  s2: await recordStatic("s2", durations.s2),
  s4: await recordStatic("s4", durations.s4),
  s5: await recordStatic("s5", durations.s5),
};

const demo = await recordDemo();
clips.s3 = demo;

await browser.close();
writeFileSync(join(OUT, "clips.json"), JSON.stringify(clips, null, 2));
console.log("[done]", clips);
