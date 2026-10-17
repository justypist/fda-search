// 拼 feed 地址用的路径前缀, 形如 <RSS_BASE>/<feed-id>/rss.xml。该目录本身返回 404,
// 但每个子路径均实测 200, 不要改成"订阅总览页"(换成它会把所有 feed 拼成 404)。
export const RSS_BASE = "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds";

// 给人看的订阅总览页, 列出全部 16 个 feed (上方 FEEDS 与之保持一致)。
export const RSS_INDEX_URL = "https://www.fda.gov/about-fda/contact-fda/subscribe-podcasts-and-news-feeds";

export const FEEDS: string[] = [
  "press-releases",
  "recalls",
  "medwatch",
  "consumers",
  "drugs",
  "biologics",
  "food-safety-recalls",
  "fda-outbreaks",
  "food-allergies",
  "health-fraud",
  "tainted-dietary-supplements",
  "oci-press-releases",
  "ora-foia-electronic-reading-room",
  "disco",
  "drug-safety-podcast",
  "rss-podcast-QA-FDA",
];

const ENFORCEMENT_SUMMARY = ["reason_for_recall", "recalling_firm", "classification", "distribution_pattern"];

export const OPENFDA_DATASETS: {
  name: string;
  dateField: string;
  idField: string;
  titleField: string;
  summaryFields: string[];
  dateFormat: "compact" | "dashed";
  sortDesc: boolean;
  lookbackDays: number;
  maxRequests: number;
  itemUrl: string;
}[] = [
  {
    name: "drug/enforcement",
    dateField: "report_date",
    idField: "recall_number",
    titleField: "product_description",
    summaryFields: ENFORCEMENT_SUMMARY,
    dateFormat: "compact",
    sortDesc: true,
    lookbackDays: 90,
    maxRequests: 20,
    itemUrl: "https://www.accessdata.fda.gov/scripts/ires/index.cfm?Event={event_id}",
  },
  {
    name: "device/enforcement",
    dateField: "report_date",
    idField: "recall_number",
    titleField: "product_description",
    summaryFields: ENFORCEMENT_SUMMARY,
    dateFormat: "compact",
    sortDesc: true,
    lookbackDays: 90,
    maxRequests: 20,
    itemUrl: "https://www.accessdata.fda.gov/scripts/ires/index.cfm?Event={event_id}",
  },
  {
    name: "food/enforcement",
    dateField: "report_date",
    idField: "recall_number",
    titleField: "product_description",
    summaryFields: ENFORCEMENT_SUMMARY,
    dateFormat: "compact",
    sortDesc: true,
    lookbackDays: 90,
    maxRequests: 20,
    itemUrl: "https://www.accessdata.fda.gov/scripts/ires/index.cfm?Event={event_id}",
  },
  {
    name: "device/recall",
    dateField: "event_date_posted",
    idField: "res_event_number",
    titleField: "product_description",
    summaryFields: ["reason_for_recall", "recalling_firm", "product_res_number"],
    dateFormat: "dashed",
    sortDesc: true,
    lookbackDays: 90,
    maxRequests: 20,
    itemUrl: "https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfRes/res.cfm?ID={res_event_number}",
  },
  {
    name: "device/510k",
    dateField: "decision_date",
    idField: "k_number",
    titleField: "device_name",
    summaryFields: ["applicant", "product_code", "decision_description", "clearance_type"],
    dateFormat: "dashed",
    sortDesc: true,
    lookbackDays: 90,
    maxRequests: 20,
    itemUrl: "https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfPMN/pmn.cfm?ID={k_number}",
  },
  {
    name: "drug/event",
    dateField: "receivedate",
    idField: "safetyreportid",
    titleField: "patient.drug.medicinalproduct",
    summaryFields: ["serious", "receivedate", "occurcountry"],
    dateFormat: "compact",
    sortDesc: true,
    lookbackDays: 30,
    maxRequests: 20,
    itemUrl: "https://api.fda.gov/drug/event.json?search=safetyreportid:%22{safetyreportid}%22",
  },
  {
    name: "food/event",
    dateField: "date_created",
    idField: "report_number",
    titleField: "products.name_brand",
    summaryFields: ["reactions", "outcomes", "consumer.age", "consumer.gender"],
    dateFormat: "compact",
    sortDesc: true,
    lookbackDays: 30,
    maxRequests: 20,
    itemUrl: "https://api.fda.gov/food/event.json?search=report_number:%22{report_number}%22",
  },
  {
    name: "animalandveterinary/event",
    dateField: "original_receive_date",
    idField: "unique_aer_id_number",
    titleField: "animal.species",
    summaryFields: ["reaction.veddra_term_name", "primary_reporter", "number_of_animals_affected"],
    dateFormat: "compact",
    sortDesc: true,
    lookbackDays: 30,
    maxRequests: 20,
    itemUrl: "https://api.fda.gov/animalandveterinary/event.json?search=unique_aer_id_number:%22{unique_aer_id_number}%22",
  },
];

export const KEYWORDS: {
  name: string;
  any: string[];
  all: string[];
  none: string[];
  regex: string[];
  caseSensitive: boolean;
  sources: ("rss" | "openfda" | "sitemap")[];
}[] = [
  {
    name: "listeria",
    any: ["listeria", "listeriosis"],
    all: [],
    none: [],
    regex: [],
    caseSensitive: false,
    sources: ["rss", "openfda", "sitemap"],
  },
];

export const SITEMAP_DEFAULT_INCLUDE = [
  "/safety/",
  "/news-events/",
  "/drugs/",
  "/medical-devices/",
  "/food/",
  "/biologics/",
  "/vaccines-blood-biologics/",
  "/inspections-compliance-enforcement-and-criminal-investigations/",
  "/tobacco-products/",
];
export const SITEMAP_DEFAULT_EXCLUDE = ["/media/", "/download"];
