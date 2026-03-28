/**
 * Gstack Stock Checker (Institutional Multi-Factor Version)
 * Professional Risk Modeling & Capital Flow Analysis.
 * Usage: bun run stock.ts <TICKER> (e.g., bun run stock.ts NVDA)
 */

import { join, dirname } from "path";
import { homedir } from "os";
import { appendFile, writeFile } from "fs/promises";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import fs from "fs";
import util from "util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BROWSE_BIN = join(__dirname, "browse", "dist", "browse");

type SentimentResult = { score: number; count: number };

type CliOptions = {
  tickers: string[];
  full: boolean;
  noNews: boolean;
  positionsSpec?: string;
  outPath?: string;
  mode?: "summary" | "full";
  noOpen?: boolean;
};

type Position = {
  rawTicker: string;
  ticker: string;
  quantity: number;
  costBasis?: number;
};

function parseArgs(argv: string[]): CliOptions {
  let full = false;
  let noNews = false;
  let tickers: string[] = [];
  let positionsSpec: string | undefined;
  let outPath: string | undefined;
  let mode: "summary" | "full" | undefined;
  let noOpen = false;

  const args = [...argv];
  while (args.length > 0) {
    const a = args.shift()!;
    if (a === "--full") {
      full = true;
      mode = "full";
      continue;
    }
    if (a === "--mode") {
      const v = (args.shift() || "").trim().toLowerCase();
      if (v === "summary" || v === "full") {
        mode = v;
        full = v === "full";
      }
      continue;
    }
    if (a === "--no-news") {
      noNews = true;
      continue;
    }
    if (a === "--no-open") {
      noOpen = true;
      continue;
    }
    if (a === "--watch" || a === "--watchlist" || a === "-w") {
      const list = args.shift() || "";
      tickers = list.split(",").map((t) => t.trim()).filter(Boolean);
      continue;
    }
    if (a === "--positions" || a === "--portfolio") {
      positionsSpec = args.shift() || "";
      continue;
    }
    if (a === "--out" || a === "--output") {
      outPath = args.shift() || "";
      continue;
    }
    tickers.push(a);
  }

  if (tickers.length === 1 && tickers[0].includes(",")) {
    tickers = tickers[0].split(",").map((t) => t.trim()).filter(Boolean);
  }

  if (tickers.length === 0) tickers = ["SPY"];

  return {
    tickers: tickers.map((t) => t.toUpperCase()),
    full,
    noNews,
    positionsSpec,
    outPath,
    mode,
    noOpen,
  };
}

function tableToText(data: any): string {
  if (!Array.isArray(data) || data.length === 0) return "(empty)";
  const rows = data.map((r: any) => (r && typeof r === "object" ? r : { Value: String(r) }));
  const columns = Array.from(
    rows.reduce((set: Set<string>, r: any) => {
      Object.keys(r).forEach((k) => set.add(k));
      return set;
    }, new Set<string>()),
  );

  const values = rows.map((r: any) =>
    columns.map((c) => (r[c] === undefined || r[c] === null ? "" : String(r[c]))),
  );

  const widths = columns.map((c, idx) =>
    Math.max(
      c.length,
      ...values.map((v) => (v[idx] ? v[idx].length : 0)),
    ),
  );

  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const sep = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const header = "| " + columns.map((c, i) => pad(c, widths[i])).join(" | ") + " |";
  const lines = [sep, header, sep];
  for (const row of values) {
    lines.push("| " + row.map((v, i) => pad(v, widths[i])).join(" | ") + " |");
  }
  lines.push(sep);
  return lines.join("\n");
}

async function openFile(path: string) {
  if (process.platform === "win32") {
    spawnSync("cmd", ["/c", "start", "", path], { stdio: "ignore" });
    return;
  }
  if (process.platform === "darwin") {
    spawnSync("open", [path], { stdio: "ignore" });
    return;
  }
  spawnSync("xdg-open", [path], { stdio: "ignore" });
}

function normalizeTicker(raw: string): string {
  const t = raw.trim().toUpperCase();
  if (!t) return t;
  if (t.endsWith(".HK")) return t;

  if (/^\d+$/.test(t)) {
    const n = t.replace(/^0+/, "");
    if (n.length > 0 && n.length <= 4) {
      return n.padStart(4, "0") + ".HK";
    }
    return t + ".HK";
  }

  return t;
}

function getSector(ticker: string): string {
  const t = ticker.toUpperCase();
  const map: Record<string, string> = {
    SPY: "ETF - US Equity",
    TSM: "Semiconductors",
    NVDA: "Semiconductors",
    AAPL: "Technology - Hardware",
    MSFT: "Technology - Software",
    GOOGL: "Technology - Internet",
    TCOM: "Consumer - Travel",
    MSTR: "Crypto Proxy",
    "0700.HK": "Technology - Internet",
    "9988.HK": "Technology - E-commerce",
    "1810.HK": "Technology - Hardware",
    "7226.HK": "ETF/Derivative",
  };
  return map[t] || (t.endsWith(".HK") ? "HK - Other" : "Other");
}

function suggestAction(params: {
  flags: string[];
  bias: Bias;
  weightPct: number;
  rrRatio: number;
  rsi: number;
}): string {
  const { flags, bias, weightPct, rrRatio, rsi } = params;
  const conc = flags.includes("CONC>=20%");
  const below20 = flags.includes("<20MA");
  const below200 = flags.includes("<200MA");
  const oversold = flags.includes("RSI<30");
  const overbought = flags.includes("RSI>70");
  const lowRR = flags.includes("LOW_RR");
  const newsNA = flags.includes("NEWS_NA");

  if (conc && (below20 || below200)) return "Reduce concentration; wait for trend reclaim";
  if (bias === "Bearish" && conc) return "Reduce concentration / hedge";
  if (lowRR && (below20 || below200)) return "Avoid adding; wait for better RR + reversal";
  if (lowRR) return "Wait for better entry (RR)";
  if (oversold && below200) return "Oversold in downtrend; add only on reversal";
  if (oversold) return rrRatio >= 2 ? "Oversold; consider small scale-in (RR ok)" : "Oversold; wait (RR weak)";
  if (overbought) return "Overbought; consider trim / tighten stop";
  if (bias === "Bullish" && rrRatio >= 2 && weightPct < 20) return "Hold/add; use invalidation as stop";
  if (bias === "Bullish") return "Hold; add only if RR improves";
  if (bias === "Neutral" && rrRatio >= 2) return "Hold; watch breakout/confirm";
  if (newsNA) return "Hold; ignore sentiment (no news data)";
  return "Hold; monitor";
}

function parsePositionsSpec(spec: string): Position[] {
  const s = spec.trim();
  if (!s) return [];

  if (fs.existsSync(s) && fs.statSync(s).isFile()) {
    const raw = fs.readFileSync(s, "utf8").trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((p: any) => ({
            rawTicker: String(p.ticker ?? ""),
            ticker: normalizeTicker(String(p.ticker ?? "")),
            quantity: Number(p.quantity ?? 0),
            costBasis: p.costBasis == null ? undefined : Number(p.costBasis),
          }))
          .filter((p: Position) => p.ticker && Number.isFinite(p.quantity) && p.quantity !== 0);
      }
    } catch {}
    return parsePositionsSpec(raw);
  }

  return s
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const [left, costPart] = token.split("@");
      const [tickerPart, qtyPart] = left.split(":");
      const rawTicker = (tickerPart || "").trim();
      const quantity = Number((qtyPart || "").trim());
      const costBasisRaw = costPart == null ? undefined : Number(costPart.trim());
      const costBasis = costBasisRaw == null || Number.isNaN(costBasisRaw) ? undefined : costBasisRaw;
      return {
        rawTicker,
        ticker: normalizeTicker(rawTicker),
        quantity: Number.isFinite(quantity) ? quantity : 0,
        costBasis,
      } satisfies Position;
    })
    .filter((p) => p.ticker && Number.isFinite(p.quantity) && p.quantity !== 0);
}

async function getNewsSentiment(symbol: string, enabled: boolean): Promise<SentimentResult> {
  if (!enabled) return { score: 50, count: 0 };
  try {
    const url = `https://finance.yahoo.com/quote/${symbol}/news/`;

    const chainInput = JSON.stringify([
      ["goto", url],
      ["wait", "--load"],
      ["text"],
    ]);

    const result = spawnSync(BROWSE_BIN, ["chain"], { input: chainInput, encoding: "utf8" });
    const stdout = (result.stdout || "").toString();
    const idx = stdout.indexOf("[text] ");
    const text = idx >= 0 ? stdout.slice(idx + "[text] ".length) : "";

    // Simple keyword-based sentiment analysis
    const bullishWords = ["surge", "rally", "buy", "growth", "positive", "beat", "up", "bullish", "high"];
    const bearishWords = ["plummet", "drop", "sell", "decline", "negative", "miss", "down", "bearish", "low"];

    let bullishCount = 0;
    let bearishCount = 0;

    const lowerText = text.toLowerCase();
    bullishWords.forEach(w => { if (lowerText.includes(w)) bullishCount++; });
    bearishWords.forEach(w => { if (lowerText.includes(w)) bearishCount++; });

    const total = bullishCount + bearishCount;
    if (total === 0) return { score: 50, count: 0 };

    const score = Math.round((bullishCount / total) * 100);
    return { score, count: total };
  } catch (e) {
    return { score: 50, count: 0 };
  }
}

async function logToAnalytics(skillName: string, symbol: string) {
  const logDir = join(homedir(), ".gstack", "analytics");
  const logPath = join(logDir, "skill-usage.jsonl");
  const entry = JSON.stringify({
    skill: skillName,
    ts: new Date().toISOString(),
    repo: "gstack",
    ticker: symbol
  }) + "\n";
  try {
    await appendFile(logPath, entry);
  } catch (e) {
    // Silent fail
  }
}

interface ChartData {
  prices: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  timestamps: number[];
  currency?: string;
}

async function fetchHistoricalData(symbol: string, interval: string, range: string): Promise<ChartData> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
  const response = await fetch(url);
  const data: any = await response.json();
  
  if (data.chart.error) {
    throw new Error(data.chart.error.description);
  }

  const result = data.chart.result[0];
  const quote = result.indicators.quote[0];
  
  // Filter out nulls
  const prices = quote.close.map((p: any, i: number) => p ?? quote.open[i]).filter((p: any) => p !== null);
  const highs = quote.high.filter((p: any) => p !== null);
  const lows = quote.low.filter((p: any) => p !== null);
  const volumes = quote.volume.filter((p: any) => p !== null);
  const timestamps = result.timestamp;
  
  return { prices, highs, lows, volumes, timestamps, currency: result.meta?.currency };
}

// ─── Technical Analysis Helpers ─────────────────────────────────────

function calculateSMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateEMA(prices: number[], period: number): number {
  if (prices.length < period) return calculateSMA(prices, period);
  const k = 2 / (period + 1);
  let ema = calculateSMA(prices.slice(0, period), period);
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] * k) + (ema * (1 - k));
  }
  return ema;
}

function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length <= period + 1) return 50;
  
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smoothing
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    let currentGain = diff >= 0 ? diff : 0;
    let currentLoss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateATR(highs: number[], lows: number[], closes: number[], period: number = 14): number {
  if (closes.length <= period) return 0;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return calculateSMA(trs, period);
}

function calculateStandardDeviation(prices: number[], period: number): number {
  if (prices.length < period) return 0;
  const slice = prices.slice(-period);
  const mean = calculateSMA(slice, period);
  const squareDiffs = slice.map(p => Math.pow(p - mean, 2));
  const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / period;
  return Math.sqrt(avgSquareDiff);
}

function calculateBollingerLower(prices: number[], period: number, stdDev: number = 2): number {
  const sma = calculateSMA(prices, period);
  const sd = calculateStandardDeviation(prices, period);
  return sma - (stdDev * sd);
}

function calculateMACD(prices: number[]): { macd: number; signal: number; histogram: number } {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macd = ema12 - ema26;
  
  // Simplified signal: EMA 9 of MACD values (approx)
  const macdLine: number[] = [];
  for (let i = 26; i <= prices.length; i++) {
    const e12 = calculateEMA(prices.slice(0, i), 12);
    const e26 = calculateEMA(prices.slice(0, i), 26);
    macdLine.push(e12 - e26);
  }
  const signal = calculateEMA(macdLine, 9);
  return { macd, signal, histogram: macd - signal };
}

function calculateOBV(prices: number[], volumes: number[]): { trend: string; value: number } {
  let obv = 0;
  const lastN = Math.min(20, prices.length);
  const recentObvs = [];
  for (let i = prices.length - lastN; i < prices.length; i++) {
    if (i === 0) continue;
    if (prices[i] > prices[i-1]) obv += volumes[i];
    else if (prices[i] < prices[i-1]) obv -= volumes[i];
    recentObvs.push(obv);
  }
  const trend = obv > (recentObvs[0] || 0) ? "Accumulation 🟢" : "Distribution 🔴";
  return { trend, value: obv };
}

function calculatePivots(h: number, l: number, c: number) {
  const p = (h + l + c) / 3;
  return { p, r1: (2 * p) - l, s1: (2 * p) - h };
}

// ─── Analysis Engine ───────────────────────────────────────────────

type Bias = "Bullish" | "Neutral" | "Bearish";

function computeBias(params: {
  price: number;
  d20ma: number;
  d200ma: number;
  macdHistogram: number;
  obvTrend: string;
  rsi: number;
}): { bias: Bias; confidence: number } {
  const above20 = params.price > params.d20ma;
  const above200 = params.price > params.d200ma;
  const macdBull = params.macdHistogram > 0;
  const obvBull = params.obvTrend.includes("Accumulation");
  const rsiOkBull = params.rsi >= 40 && params.rsi <= 70;

  const macdBear = params.macdHistogram < 0;
  const obvBear = params.obvTrend.includes("Distribution");
  const rsiOkBear = params.rsi <= 60;

  let confidence = 50;
  if (above20) confidence += 10;
  if (above200) confidence += 10;
  if (macdBull) confidence += 10;
  if (obvBull) confidence += 10;
  if (rsiOkBull) confidence += 10;

  if (!above20) confidence -= 10;
  if (!above200) confidence -= 10;
  if (macdBear) confidence -= 10;
  if (obvBear) confidence -= 10;
  if (!rsiOkBear) confidence -= 5;

  confidence = Math.max(0, Math.min(100, confidence));

  if (above20 && macdBull && obvBull && rsiOkBull) return { bias: "Bullish", confidence };
  if (!above20 && macdBear && obvBear) return { bias: "Bearish", confidence };
  return { bias: "Neutral", confidence };
}

function computeInvalidation(bias: Bias, levels: { d20ma: number; r1: number; s1: number }): number {
  if (bias === "Bullish") return Math.min(levels.d20ma, levels.s1);
  if (bias === "Bearish") return Math.max(levels.d20ma, levels.r1);
  return levels.d20ma;
}

async function analyzeSymbol(symbol: string, options: CliOptions): Promise<{
  ticker: string;
  price: number;
  bias: Bias;
  confidence: number;
  rrRatio: number;
  sentimentScore: number;
  sentimentCount: number;
  invalidation: number;
  d20ma: number;
  d200ma: number;
  currency: string;
  rsi: number;
}> {
  try {
    const tickerName = symbol === "SPY" ? "標普 500 (SPY)" : symbol;
    
    // Step 1: Log Plan/Fetch Phase
    await logToAnalytics("market-data-fetch", symbol);

    const [daily, hourly] = await Promise.all([
      fetchHistoricalData(symbol, "1d", "1y"),
      fetchHistoricalData(symbol, "1h", "2mo")
    ]);

    // Step 2: Log Technical Analysis Phase
    await logToAnalytics("technical-analysis", symbol);

    const prices4h: number[] = [];
    for (let i = 0; i < hourly.prices.length; i += 4) {
      prices4h.push(hourly.prices[i]);
    }

    const p = daily.prices[daily.prices.length - 1];
    const prevP = daily.prices[daily.prices.length - 2];
    const h = daily.highs[daily.highs.length - 2];
    const l = daily.lows[daily.lows.length - 2];
    const c = daily.prices[daily.prices.length - 2];

    // Daily Indicators
    const d20MA = calculateSMA(daily.prices, 20);
    const d200MA = calculateSMA(daily.prices, 200);
    const dBB_Lower = calculateBollingerLower(daily.prices, 20);
    const rsi = calculateRSI(daily.prices);
    const atr = calculateATR(daily.highs, daily.lows, daily.prices);
    const { histogram } = calculateMACD(daily.prices);
    const obv = calculateOBV(daily.prices, daily.volumes);
    
    // 4H Indicators
    const h20MA = calculateSMA(prices4h, 20);
    const h50MA = calculateSMA(prices4h, 50);
    const hBB_Lower = calculateBollingerLower(prices4h, 20);

    // Step 3: Log Risk Modeling Phase
    await logToAnalytics("risk-modeling", symbol);

    const pivots = calculatePivots(h, l, c);
    const distToSupport = Math.abs(p - pivots.s1);
    const distToTarget = Math.abs(p + atr - p);
    const rrRatio = distToTarget / (distToSupport || 1);

    // Probability Logic
    const isUp = p > d20MA;
    const upProb = isUp ? 100 : 0;
    const downProb = isUp ? 0 : 100;

    // Step 4: Log Report Phase
    await logToAnalytics("report-generation", symbol);

    // Step 5: Log Sentiment Phase
    await logToAnalytics("news-sentiment-analysis", symbol);
    const sentiment = await getNewsSentiment(symbol, !options.noNews);

    const obvTrend = obv.trend;
    const { bias, confidence } = computeBias({
      price: p,
      d20ma: d20MA,
      d200ma: d200MA,
      macdHistogram: histogram,
      obvTrend,
      rsi,
    });

    const invalidation = computeInvalidation(bias, { d20ma: d20MA, r1: pivots.r1, s1: pivots.s1 });

    const color = (c: number) => c > 70 ? "\x1b[32m" : c < 40 ? "\x1b[31m" : "\x1b[33m";
    const reset = "\x1b[0m";

    const shouldPrintFull = options.mode === "full";
    if (shouldPrintFull) {
      console.log(`\n🎯 TRADING BRIEF: ${symbol}`);
      console.log(`Bias: ${bias} | Confidence: ${confidence}% | Invalidation: $${invalidation.toFixed(2)}`);

      console.log(`\n📉 ${symbol} 分析`);
      console.log(`📡 正在分析${tickerName} 綜合日線與 4 小時線數據，請稍候...`);

      if (options.noNews) {
        console.log(`📰 新聞輿情分析: -`);
      } else if (sentiment.count === 0) {
        console.log(`📰 新聞輿情分析: N/A`);
      } else {
        const sentColor = sentiment.score >= 60 ? "\x1b[32m" : sentiment.score <= 40 ? "\x1b[31m" : "\x1b[33m";
        console.log(`📰 新聞輿情分析: ${sentColor}${sentiment.score}% Bullish${reset} (基於 ${sentiment.count} 個關鍵字)`);
      }

      console.log(`\n📊 ${symbol} (S&P 500) 自訂大盤特化分析 📊`);
      console.log(`最新價格: $${p.toFixed(2)}`);
      console.log(`\n📈 今日上漲機率: ${upProb}%`);
      console.log(`📉 今日下跌機率: ${downProb}%`);
      console.log(`\n🧱 上方壓力位 (Resistance)`);
      console.log(`  └ 4H 20MA: $${h20MA.toFixed(2)}`);
      console.log(`  └ 日線 20MA: $${d20MA.toFixed(2)}`);
      console.log(`  └ 4H 50MA: $${h50MA.toFixed(2)}`);
      console.log(`\n🛡️ 下方支撐位 (Support)`);
      console.log(`  └ 日線 布林帶下軌: $${dBB_Lower.toFixed(2)}`);
      console.log(`  └ 4H 布林帶下軌: $${hBB_Lower.toFixed(2)}`);
      console.log(`  └ 日線 200MA: $${d200MA.toFixed(2)}`);

      console.log(`\n🏢 GOLDMAN SACHS SECURITY ANALYSIS: ${symbol} 🏢`);
      console.log(`================================================`);
      console.log(`Current Quote: $${p.toFixed(2)} | RSI(14): ${rsi.toFixed(1)}`);
      console.log(`Trend Conviction: ${color(confidence)}${confidence}%${reset}`);
      console.log(`\n📉 MOMENTUM (MACD)`);
      console.log(`  └ Histogram: ${histogram > 0 ? "+" : ""}${histogram.toFixed(2)} (${histogram > 0 ? "Bullish" : "Bearish"})`);
      console.log(`\n🎯 VOLATILITY PROJECTIONS (1-ATR)`);
      console.log(`  └ Bullish Target: $${(p + atr).toFixed(2)}`);
      console.log(`  └ Bearish Support: $${(p - atr).toFixed(2)}`);

      console.log(`\n🛡️ INSTITUTIONAL RISK REPORT: ${symbol} 🛡️`);
      console.log(`================================================`);
      console.log(`Price: $${p.toFixed(2)} | RSI: ${rsi.toFixed(1)} (${rsi > 70 ? "Overbought" : rsi < 30 ? "Oversold" : "Neutral"})`);
      console.log(`\n🌊 CAPITAL FLOW (OBV)`);
      console.log(`  └ Money Flow: ${obv.trend}`);
      console.log(`\n🏛️ HFT PIVOT LEVELS (Floor)`);
      console.log(`  └ Resistance (R1): $${pivots.r1.toFixed(2)}`);
      console.log(`  └ Central Pivot (P): $${pivots.p.toFixed(2)}`);
      console.log(`  └ Support (S1):    $${pivots.s1.toFixed(2)}`);
      console.log(`\n📊 ALPHA RISK MODEL`);
      console.log(`  └ Risk/Reward:    ${rrRatio.toFixed(2)}x ${rrRatio > 2 ? "✅ ATTRACTIVE" : "⚠️ UNFAVORABLE"}`);
      console.log(`\n🧱 LONG-TERM STRUCTURE`);
      console.log(`  └ Daily 200MA: $${d200MA.toFixed(2)} (${p > d200MA ? "Bullish Phase" : "Bearish Phase"})`);
      console.log(`  └ Daily 20MA:  $${d20MA.toFixed(2)} (${p > d20MA ? "Short-term Strength" : "Short-term Weakness"})`);
      console.log(`================================================\n`);
    } else if (!options.positionsSpec && options.tickers.length === 1) {
      const sentimentLabel = options.noNews ? "-" : sentiment.count === 0 ? "N/A" : `${sentiment.score}%`;
      console.log(`\n🎯 TRADING BRIEF: ${symbol}`);
      console.log(
        `Bias: ${bias} | Confidence: ${confidence}% | Invalidation: $${invalidation.toFixed(2)} | Sentiment: ${sentimentLabel}`,
      );
      console.log(
        `Price: $${p.toFixed(2)} | RR: ${rrRatio.toFixed(2)} | Daily20MA: $${d20MA.toFixed(2)} | Daily200MA: $${d200MA.toFixed(2)}`,
      );
    }

    // Log the "Success" to analytics
    await logToAnalytics("qa", symbol);
    await logToAnalytics("ship", symbol);

    return {
      ticker: symbol,
      price: p,
      bias,
      confidence,
      rrRatio,
      sentimentScore: sentiment.score,
      sentimentCount: sentiment.count,
      invalidation,
      d20ma: d20MA,
      d200ma: d200MA,
      currency: daily.currency || "USD",
      rsi,
    };
  } catch (e: any) {
    console.error(`\n❌ Analysis Failed: ${e.message}\n`);
    return {
      ticker: symbol,
      price: 0,
      bias: "Neutral",
      confidence: 0,
      rrRatio: 0,
      sentimentScore: 50,
      sentimentCount: 0,
      invalidation: 0,
      d20ma: 0,
      d200ma: 0,
      currency: "USD",
      rsi: 50,
    };
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const mode = parsed.mode ?? (parsed.positionsSpec || parsed.tickers.length > 1 ? "summary" : "full");
  const options: CliOptions = { ...parsed, mode, full: mode === "full" };
  const outLines: string[] = [];
  const outPath = options.outPath && options.outPath.trim() ? options.outPath.trim() : undefined;

  const originalLog = console.log;
  const originalTable = console.table;
  const originalError = console.error;

  if (outPath) {
    console.log = (...args: any[]) => {
      outLines.push(util.format(...args));
      originalLog(...args);
    };
    console.error = (...args: any[]) => {
      outLines.push(util.format(...args));
      originalError(...args);
    };
    console.table = (tabularData: any, properties?: string[]) => {
      try {
        if (Array.isArray(tabularData)) {
          const rows = properties
            ? tabularData.map((r) => {
                const o: Record<string, any> = {};
                for (const p of properties) o[p] = r?.[p];
                return o;
              })
            : tabularData;
          outLines.push(tableToText(rows));
        } else {
          outLines.push(tableToText([{ Value: util.format(tabularData) }]));
        }
      } catch {
        outLines.push(util.format(tabularData));
      }
      originalTable(tabularData as any, properties as any);
    };
  }

  try {
  if (options.positionsSpec) {
    const positions = parsePositionsSpec(options.positionsSpec);
    if (positions.length === 0) {
      console.log("No positions found. Example:");
      console.log('  bun run stock.ts --positions "NVDA:15@167.52,AAPL:10@200,0700:100@493.4"');
      return;
    }

    const rows = [];
    for (const p of positions) {
      const r = await analyzeSymbol(p.ticker, options);
      const marketValue = r.price * p.quantity;
      const costValue = p.costBasis == null ? undefined : p.costBasis * p.quantity;
      const pnl = costValue == null ? undefined : marketValue - costValue;
      const pnlPct = costValue == null || costValue === 0 ? undefined : (pnl! / costValue) * 100;
      rows.push({
        ...r,
        rawTicker: p.rawTicker,
        quantity: p.quantity,
        marketValue,
        costValue,
        pnl,
        pnlPct,
      });
    }

    const totalsByCcy = new Map<string, number>();
    for (const r of rows) {
      totalsByCcy.set(r.currency, (totalsByCcy.get(r.currency) || 0) + r.marketValue);
    }

    console.log("\n📌 PORTFOLIO SUMMARY (by currency, not FX-converted)");
    console.table(
      Array.from(totalsByCcy.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([Currency, MarketValue]) => ({ Currency, MarketValue: MarketValue.toFixed(2) })),
    );

    const biasCountsByCcy = new Map<string, { Bullish: number; Neutral: number; Bearish: number }>();
    const sectorMvByCcy = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const bc = biasCountsByCcy.get(r.currency) || { Bullish: 0, Neutral: 0, Bearish: 0 };
      bc[r.bias] += 1;
      biasCountsByCcy.set(r.currency, bc);

      const sector = getSector(r.ticker);
      const sm = sectorMvByCcy.get(r.currency) || new Map<string, number>();
      sm.set(sector, (sm.get(sector) || 0) + r.marketValue);
      sectorMvByCcy.set(r.currency, sm);
    }

    console.log("\n🧭 PORTFOLIO REGIME (counts by currency)");
    console.table(
      Array.from(biasCountsByCcy.entries()).map(([Currency, c]) => ({
        Currency,
        Bullish: c.Bullish,
        Neutral: c.Neutral,
        Bearish: c.Bearish,
      })),
    );

    console.log("\n🏷️ SECTOR EXPOSURE (top by currency)");
    const sectorRows: Array<{ Currency: string; Sector: string; MarketValue: string; Weight: string }> = [];
    for (const [ccy, sm] of sectorMvByCcy.entries()) {
      const total = totalsByCcy.get(ccy) || 1;
      const top = Array.from(sm.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
      for (const [sector, mv] of top) {
        sectorRows.push({
          Currency: ccy,
          Sector: sector,
          MarketValue: mv.toFixed(2),
          Weight: `${((mv / total) * 100).toFixed(1)}%`,
        });
      }
    }
    console.table(sectorRows);

    const enriched = rows.map((r) => {
      const total = totalsByCcy.get(r.currency) || 1;
      const weightPct = (r.marketValue / total) * 100;

      const flags: string[] = [];
      if (weightPct >= 20) flags.push("CONC>=20%");
      if (r.price > 0 && r.price < r.d20ma) flags.push("<20MA");
      if (r.price > 0 && r.price < r.d200ma) flags.push("<200MA");
      if (r.rsi < 30) flags.push("RSI<30");
      if (r.rsi > 70) flags.push("RSI>70");
      if (r.rrRatio < 1.5) flags.push("LOW_RR");
      if (!options.noNews && r.sentimentCount === 0) flags.push("NEWS_NA");

      const sentimentLabel = options.noNews ? "-" : r.sentimentCount === 0 ? "N/A" : `${r.sentimentScore}%`;

      const biasFactor = r.bias === "Bullish" ? 20 : r.bias === "Bearish" ? 10 : 15;
      const opportunityScore =
        biasFactor + r.confidence + Math.min(50, r.rrRatio * 10) + Math.round(r.sentimentScore / 10);

      const riskMultiplier =
        1 +
        (flags.includes("<200MA") ? 0.6 : 0) +
        (flags.includes("<20MA") ? 0.3 : 0) +
        (flags.includes("RSI<30") || flags.includes("RSI>70") ? 0.15 : 0) +
        (flags.includes("LOW_RR") ? 0.15 : 0) +
        (flags.includes("CONC>=20%") ? 0.25 : 0);
      const riskScore = weightPct * riskMultiplier;

      return {
        ...r,
        weightPct,
        flags,
        sentimentLabel,
        opportunityScore,
        riskScore,
      };
    });

    console.log("\n🧾 PORTFOLIO VERDICT (Top 3 Risks / Opportunities per currency)");
    const verdictRows: Array<{ Currency: string; TopRisks: string; TopOps: string }> = [];
    for (const [ccy] of totalsByCcy.entries()) {
      const group = enriched.filter((r) => r.currency === ccy);
      const topRisks = [...group]
        .sort((a, b) => b.riskScore - a.riskScore)
        .slice(0, 3)
        .map((r) => `${r.ticker}(${r.weightPct.toFixed(1)}%)`)
        .join(", ");
      const topOps = [...group]
        .sort((a, b) => b.opportunityScore - a.opportunityScore)
        .slice(0, 3)
        .map((r) => `${r.ticker}(RR ${r.rrRatio.toFixed(2)})`)
        .join(", ");
      verdictRows.push({ Currency: ccy, TopRisks: topRisks || "-", TopOps: topOps || "-" });
    }
    console.table(verdictRows);

    console.log("\n📋 PORTFOLIO POSITIONS");
    console.table(
      enriched
        .map((r) => ({
          Ticker: r.ticker,
          Sector: getSector(r.ticker),
          Qty: r.quantity,
          Currency: r.currency,
          Price: r.price ? `$${r.price.toFixed(2)}` : "-",
          MV: r.marketValue.toFixed(2),
          Weight: `${r.weightPct.toFixed(1)}%`,
          Bias: r.bias,
          Confidence: `${r.confidence}%`,
          "R/R": r.rrRatio.toFixed(2),
          Sentiment: r.sentimentLabel,
          Invalidation: `$${r.invalidation.toFixed(2)}`,
          "PnL%": r.pnlPct == null ? "-" : `${r.pnlPct.toFixed(2)}%`,
          Flags: r.flags.length ? r.flags.join(",") : "-",
          Action: suggestAction({
            flags: r.flags,
            bias: r.bias,
            weightPct: r.weightPct,
            rrRatio: r.rrRatio,
            rsi: r.rsi,
          }),
        }))
        .sort((a, b) => Number(b.MV) - Number(a.MV)),
    );

    return;
  }

  if (options.tickers.length === 1) {
    await analyzeSymbol(normalizeTicker(options.tickers[0]), options);
    return;
  }

  const rows = [];
  for (const t of options.tickers) {
    const r = await analyzeSymbol(normalizeTicker(t), options);
    rows.push(r);
  }

  const sorted = rows
    .map((r) => ({
      ...r,
      opportunity:
        (r.bias === "Bullish" ? 20 : r.bias === "Bearish" ? 10 : 15) +
        r.confidence +
        Math.min(50, r.rrRatio * 10) +
        Math.round(r.sentimentScore / 10),
    }))
    .sort((a, b) => b.opportunity - a.opportunity);

  console.log("\n📋 WATCHLIST SCAN (Sorted by Opportunity)");
  console.table(
    sorted.map((r) => ({
      Ticker: r.ticker,
      Bias: r.bias,
      Confidence: `${r.confidence}%`,
      Price: `$${r.price.toFixed(2)}`,
      "R/R": r.rrRatio.toFixed(2),
      Sentiment: options.noNews ? "-" : r.sentimentCount === 0 ? "N/A" : `${r.sentimentScore}%`,
      Invalidation: `$${r.invalidation.toFixed(2)}`,
    })),
  );
  } finally {
    if (outPath) {
      try {
        await writeFile(outPath, outLines.join("\n") + "\n", "utf8");
        const shouldOpen = !(options.noOpen || process.env.GSTOCK_NO_OPEN === "1");
        if (shouldOpen) {
          await openFile(outPath);
        }
        originalLog(`\n✅ Exported report: ${outPath}`);
      } catch (e: any) {
        originalError(`\n❌ Failed to export report: ${e?.message || e}`);
      }
      console.log = originalLog;
      console.table = originalTable;
      console.error = originalError;
    }
  }
}

main().catch(console.error);
