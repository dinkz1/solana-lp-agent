/**
 * PriceMonitor - Real-time price feeds from Jupiter + Birdeye + on-chain fallback
 * Tracks SOL-USDC and HYPE-USDC prices with volatility calculation
 */

const axios = require('axios');
const logger = require('./logger');

// Token mint addresses on Solana
const TOKENS = {
  SOL:  'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  HYPE: process.env.HYPE_MINT || 'YOUR_HYPE_MINT_ADDRESS_HERE', // Set in .env
};

const POOLS = {
  'SOL-USDC':  process.env.SOL_USDC_POOL  || 'YOUR_SOL_USDC_METEORA_POOL',
  'HYPE-USDC': process.env.HYPE_USDC_POOL || 'YOUR_HYPE_USDC_METEORA_POOL',
};

class PriceMonitor {
  constructor() {
    this.prices = {};
    this.priceHistory = { 'SOL-USDC': [], 'HYPE-USDC': [] };
    this.volatility = {};
    this.historyWindow = 60; // keep 60 samples (~30 min at 30s interval)
  }

  async initialize() {
    logger.info('Initializing PriceMonitor...');
    await this.fetchAllPrices();
    logger.info('PriceMonitor ready. Initial prices:', this.prices);
  }

  // ── Primary: Jupiter Price API v6 ──────────────────────────────────────
  async fetchJupiterPrice(inputMint, outputMint) {
    const url = `https://price.jup.ag/v6/price?ids=${inputMint}&vsToken=${outputMint}`;
    const resp = await axios.get(url, { timeout: 5000 });
    const data = resp.data?.data?.[inputMint];
    if (!data?.price) throw new Error('No Jupiter price data');
    return parseFloat(data.price);
  }

  // ── Secondary: Birdeye API ──────────────────────────────────────────────
  async fetchBirdeyePrice(mintAddress) {
    const apiKey = process.env.BIRDEYE_API_KEY;
    if (!apiKey) throw new Error('No Birdeye API key');
    const url = `https://public-api.birdeye.so/public/price?address=${mintAddress}`;
    const resp = await axios.get(url, {
      headers: { 'X-API-KEY': apiKey },
      timeout: 5000
    });
    const price = resp.data?.data?.value;
    if (!price) throw new Error('No Birdeye price data');
    return parseFloat(price);
  }

  // ── Tertiary: CoinGecko (SOL only, no API key needed) ──────────────────
  async fetchCoinGeckoSOL() {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
    const resp = await axios.get(url, { timeout: 8000 });
    return resp.data?.solana?.usd;
  }

  // ── Fetch with fallback chain ───────────────────────────────────────────
  async fetchPrice(pool) {
    const [base] = pool.split('-');
    const baseMint = TOKENS[base];

    const attempts = [
      () => this.fetchJupiterPrice(baseMint, TOKENS.USDC),
      () => this.fetchBirdeyePrice(baseMint),
      base === 'SOL' ? () => this.fetchCoinGeckoSOL() : null,
    ].filter(Boolean);

    let lastErr;
    for (const attempt of attempts) {
      try {
        const price = await attempt();
        if (price && price > 0) return price;
      } catch (err) {
        lastErr = err;
        logger.debug(`Price fetch fallback for ${pool}: ${err.message}`);
      }
    }
    throw lastErr || new Error(`Failed to fetch price for ${pool}`);
  }

  async fetchAllPrices() {
    const results = {};
    for (const pool of ['SOL-USDC', 'HYPE-USDC']) {
      try {
        const price = await this.fetchPrice(pool);
        results[pool] = price;
        this.recordPrice(pool, price);
      } catch (err) {
        logger.error(`Failed to fetch price for ${pool}:`, err.message);
        // Use last known price as fallback
        results[pool] = this.prices[pool] || null;
      }
    }
    this.prices = results;
    return results;
  }

  recordPrice(pool, price) {
    const history = this.priceHistory[pool];
    history.push({ price, ts: Date.now() });
    if (history.length > this.historyWindow) history.shift();

    // Recalculate volatility (standard deviation of % changes)
    if (history.length >= 5) {
      const changes = [];
      for (let i = 1; i < history.length; i++) {
        changes.push((history[i].price - history[i-1].price) / history[i-1].price);
      }
      const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
      const variance = changes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / changes.length;
      this.volatility[pool] = Math.sqrt(variance) * 100; // as %
    }
  }

  getPrice(pool) {
    return this.prices[pool];
  }

  getVolatility(pool) {
    return this.volatility[pool] || 1.0; // default 1% if not enough data
  }

  // Returns price change % over last N samples
  getPriceChange(pool, samples = 10) {
    const history = this.priceHistory[pool];
    if (history.length < 2) return 0;
    const recent = history.slice(-Math.min(samples, history.length));
    const oldest = recent[0].price;
    const newest = recent[recent.length - 1].price;
    return ((newest - oldest) / oldest) * 100;
  }

  // Returns high/low over recent window for optimal range calculation
  getPriceRange(pool, samples = 20) {
    const history = this.priceHistory[pool];
    if (history.length < 2) {
      const p = this.prices[pool] || 1;
      return { high: p * 1.02, low: p * 0.98, mid: p };
    }
    const recent = history.slice(-Math.min(samples, history.length));
    const prices = recent.map(h => h.price);
    return {
      high: Math.max(...prices),
      low: Math.min(...prices),
      mid: prices[prices.length - 1]
    };
  }

  getPoolAddress(pool) {
    return POOLS[pool];
  }

  getSummary() {
    return Object.fromEntries(
      Object.entries(this.prices).map(([pool, price]) => [pool, {
        price,
        volatility: (this.volatility[pool] || 0).toFixed(4) + '%',
        change1h: this.getPriceChange(pool, 120).toFixed(3) + '%'
      }])
    );
  }
}

module.exports = PriceMonitor;
