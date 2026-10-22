/**
 * Seeds a believable household so the demo has a life before you talk to it.
 * Run: npm run build && node dist/db/seed.js --reset
 */
import { getDb, insertMemory, insertService, openIssue, resolveIssue, addReminder, upsertAppliance, today } from "../db.js";

const RESET = process.argv.includes("--reset");

if (RESET) {
  const db = getDb();
  for (const table of ["turns", "reminders", "issues", "service_events", "memories", "appliances"]) {
    db.exec(`DELETE FROM ${table}`);
  }
  db.exec(`DELETE FROM memories_fts`);
  console.log("[seed] cleared");
}

const appliances = [
  { name: "Water heater", room: "utility closet", brand: "Rheem", model: "XG50T12HE40", purchased_at: "2024-06-02", warranty_months: 60, notes: "50 gal gas. Anode rod replaced once." },
  { name: "Refrigerator", room: "kitchen", brand: "Samsung", model: "RT38CG6000", purchased_at: "2024-12-15", warranty_months: 24, notes: "Two-year manufacturer warranty, receipt in Drive." },
  { name: "Dishwasher", room: "kitchen", brand: "Bosch", model: "SHS43M02UC", purchased_at: "2023-11-18", warranty_months: 24, notes: "Leaks under the door when the pump runs." },
  { name: "HVAC", room: "living room", brand: "Daikin", model: "FTKC35TVM4", purchased_at: "2023-04-21", warranty_months: 48, notes: "Split unit. Filter every 3 months. Landlord covers service." },
  { name: "Washing machine", room: "laundry", brand: "LG", model: "FC1409S3W", purchased_at: "2021-08-30", warranty_months: 24, notes: "Drain pump replaced 2026." },
  { name: "Garage door", room: "garage", brand: "Chamberlain", model: "B550", purchased_at: "2025-02-11", warranty_months: 24, notes: "Chain drive, belt service yearly." },
];

for (const a of appliances) upsertAppliance(a);

const services = [
  { appliance_name: "Water heater", performed_at: "2026-03-14", vendor: "Budi Plumbing", cost_cents: 8500, notes: "Replaced anode rod and flushed the tank; next flush in two years." },
  { appliance_name: "HVAC", performed_at: "2026-08-02", vendor: "self", cost_cents: 1800, notes: "Replaced filter, cleaned blower wheel." },
  { appliance_name: "Dishwasher", performed_at: "2026-09-21", vendor: "ServicePro", cost_cents: 0, notes: "Diagnosed pump seal leak, quoted $210 to replace, we deferred." },
  { appliance_name: "Washing machine", performed_at: "2026-06-11", vendor: "LG Service", cost_cents: 4500, notes: "Drain pump replaced." },
  { appliance_name: "Garage door", performed_at: "2026-01-18", vendor: "Overhead Co", cost_cents: 6000, notes: "Lubed chain, realigned safety sensors." },
  { appliance_name: "Water heater", performed_at: "2024-06-02", vendor: "Budi Plumbing", cost_cents: 120000, notes: "Installed new 50 gal unit, 5 year tank warranty." },
];

for (const s of services) insertService(s);

const memories = [
  { text: "The spare key is with Mrs. Chen in unit 4B.", subject: "spare key", room: "entry", tags: ["key", "neighbour"], happened_at: "2026-01-12" },
  { text: "Living room walls are Benjamin Moore Simply White; one spare gallon is in the garage.", subject: "paint colour", room: "living room", tags: ["paint", "renovation"], happened_at: "2025-11-08" },
  { text: "Main water shutoff valve is behind the laundry door on the left side.", subject: "water shutoff", room: "laundry", tags: ["emergency", "valve"], happened_at: "2026-05-20" },
  { text: "Landlord Pak Andi covers HVAC service — call him before paying for anything.", subject: "HVAC billing", room: "living room", tags: ["landlord", "hvac"], happened_at: "2026-02-03" },
  { text: "Dishwasher receipt and warranty PDF are in the appliances folder in Google Drive.", subject: "dishwasher receipt", room: "kitchen", tags: ["warranty", "documents"], happened_at: "2023-11-18" },
  { text: "Budi Plumbing answers fastest before 9am: +62 811 2345 678.", subject: "plumber contact", tags: ["vendor", "contact"], happened_at: "2026-03-14" },
  { text: "The plumber said the water heater tank is eight years old and should be replaced by 2028.", subject: "water heater lifespan", room: "utility closet", tags: ["replacement", "plumbing"], happened_at: "2026-03-14" },
  { text: "Guest room AC remote lives in the bedside drawer.", subject: "AC remote", room: "guest room", tags: ["remote"], happened_at: "2026-07-01" },
  { text: "Router is in the hall cupboard; restart it by unplugging for ten seconds.", subject: "wifi router", room: "hall", tags: ["wifi", "internet"], happened_at: "2026-04-11" },
  { text: "Dishwasher door seal part number is 00645523 and it fitted last time.", subject: "dishwasher part", room: "kitchen", tags: ["parts", "dishwasher"], happened_at: "2026-09-21" },
  { text: "Trash pickup is Monday and Thursday at 6am, recycling on Saturday.", subject: "trash schedule", tags: ["schedule"], happened_at: "2025-09-01" },
];

for (const m of memories) insertMemory({ ...m, kind: "fact" });

openIssue({
  title: "Dishwasher leaks under the door",
  appliance_name: "Dishwasher",
  notes: "ServicePro quoted $210 for the pump seal on 21 Sep. Decided to wait, leak is small.",
});
openIssue({
  title: "Guest room AC rattles on high fan",
  appliance_name: "HVAC",
  notes: "Only on highest fan speed. Landlord covers the service call.",
});
const resolved = openIssue({ title: "Bathroom exhaust fan buzzing", appliance_name: "Bathroom fan" });
resolveIssue(resolved!.id, "Replaced fan motor, $32 in parts.");

addReminder({ title: "Change HVAC filter", due_at: "2026-11-02", notes: "Filter is in the garage shelf." });
addReminder({ title: "Decide on dishwasher pump repair", due_at: "2026-10-30", notes: "$210 quote from ServicePro, expires end of month." });
addReminder({ title: "Flush water heater again", due_at: "2028-03-14" });
addReminder({ title: "Renew home insurance", due_at: "2026-12-01" });

console.log(`[seed] done for ${today()} — ${appliances.length} appliances, ${services.length} services, ${memories.length} memories`);
