/**
 * LPManager - Handles all LP position operations on Meteora DLMM/CLMM
 *
 * This module abstracts:
 * - Opening positions (with slippage control)
 * - Closing positions
 * - Reading accrued fees
 * - Token balance management
 * - Transaction retry logic
 */

const { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { BN } = require('bn.js');
const logger = require('./logger');
const bs58 = require('bs58');

// ── Constants ──────────────────────────────────────────────────────────────
const RPC_ENDPOINTS = [
  process.env.SOLANA_RPC_URL,
  'https://api.mainnet-beta.solana.com',
].filter(Boolean);

const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS || '50'); // 0.5%
const MAX_RETRIES   = 3;
const RETRY_DELAY   = 2000;

class LPManager {
  constructor() {
    this.connection = null;
    this.wallet = null;
    this.rpcIndex = 0;
    this.dlmmProgram = null;
  }

  async initialize() {
    logger.info('Initializing LPManager...');

    // Connect to Solana
    this.connection = new Connection(RPC_ENDPOINTS[0], {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });

    // Load wallet from private key in .env
    const privateKeyStr = process.env.WALLET_PRIVATE_KEY;
    if (!privateKeyStr) throw new Error('WALLET_PRIVATE_KEY not set in .env');

    try {
      const secretKey = bs58.decode(privateKeyStr);
      this.wallet = Keypair.fromSecretKey(secretKey);
      logger.info(`Wallet loaded: ${this.wallet.publicKey.toBase58()}`);
    } catch {
      throw new Error('Invalid WALLET_PRIVATE_KEY format (must be base58)');
    }

    // Verify connection
    const slot = await this.connection.getSlot();
    logger.info(`Connected to Solana. Current slot: ${slot}`);

    // Initialize Meteora DLMM SDK (requires @meteora-ag/dlmm)
    await this._initMeteoraSdk();

    logger.info('LPManager ready');
  }

  async _initMeteoraSdk() {
    try {
      // Dynamic import of Meteora DLMM SDK
      const DLMM = require('@meteora-ag/dlmm');
      this.dlmmModule = DLMM;
      logger.info('Meteora DLMM SDK loaded');
    } catch (err) {
      logger.warn('Meteora DLMM SDK not available - running in simulation mode:', err.message);
      this.simulationMode = true;
    }
  }

  // ── Rotate to backup RPC on failure ────────────────────────────────────
  async _rotateRPC() {
    this.rpcIndex = (this.rpcIndex + 1) % RPC_ENDPOINTS.length;
    const url = RPC_ENDPOINTS[this.rpcIndex];
    if (!url) return;
    this.connection = new Connection(url, { commitment: 'confirmed' });
    logger.info(`Rotated to RPC: ${url}`);
  }

  // ── Retry wrapper for transactions ─────────────────────────────────────
  async _withRetry(fn, label = 'tx') {
    let lastErr;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        logger.warn(`${label} attempt ${i+1} failed: ${err.message}`);
        if (i < MAX_RETRIES - 1) {
          await this._sleep(RETRY_DELAY * (i + 1));
          if (err.message.includes('timeout') || err.message.includes('503')) {
            await this._rotateRPC();
          }
        }
      }
    }
    throw lastErr;
  }

  // ── Open multiple positions from a strategy config ─────────────────────
  async openPositions(strategyConfig) {
    const { pool, positions, currentPrice } = strategyConfig;
    const poolAddress = new PublicKey(process.env[`${pool.replace('-','_')}_POOL`]);
    const openedPositions = [];

    // Get total available capital for this pool
    const totalCapitalUSD = await this._getPoolCapital(pool);
    logger.info(`Opening ${positions.length} positions for ${pool} with $${totalCapitalUSD} capital`);

    for (const posConfig of positions) {
      try {
        const capitalUSD = totalCapitalUSD * posConfig.capitalPct;

        // Simulate APR feasibility check
        if (!strategyConfig.estimatedAPR?.feasible) {
          logger.warn(`Skipping ${posConfig.name} position - APR too low`);
          continue;
        }

        const pos = await this._withRetry(
          () => this._openSinglePosition(pool, poolAddress, posConfig, capitalUSD, currentPrice),
          `open-${posConfig.name}`
        );

        openedPositions.push(pos);
        logger.info(`✅ Opened ${posConfig.name} position: ${pos.id}`);

        // Small delay between position opens to avoid congestion
        await this._sleep(1500);
      } catch (err) {
        logger.error(`Failed to open ${posConfig.name} position:`, err);
      }
    }

    return openedPositions;
  }

  async _openSinglePosition(pool, poolAddress, posConfig, capitalUSD, currentPrice) {
    if (this.simulationMode) {
      return this._simulateOpenPosition(pool, posConfig, capitalUSD, currentPrice);
    }

    const dlmmPool = await this.dlmmModule.DLMM.create(this.connection, poolAddress);

    // Convert USD capital to token amounts
    const { tokenAAmount, tokenBAmount } = await this._calcTokenAmounts(
      pool, capitalUSD, currentPrice, posConfig
    );

    // Get bin IDs for the price range
    const lowerBinId = dlmmPool.getBinIdFromPrice(posConfig.lowerPrice, true);
    const upperBinId = dlmmPool.getBinIdFromPrice(posConfig.upperPrice, false);

    logger.info(`${posConfig.name}: bins ${lowerBinId}→${upperBinId}, capital: $${capitalUSD.toFixed(2)}`);

    // Build add liquidity transaction
    const newPosition = Keypair.generate();
    const { tx, signers } = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newPosition.publicKey,
      user: this.wallet.publicKey,
      totalXAmount: new BN(tokenAAmount),
      totalYAmount: new BN(tokenBAmount),
      strategy: {
        maxBinId: upperBinId,
        minBinId: lowerBinId,
        strategyType: this.dlmmModule.StrategyType.SpotBalanced,
      },
      slippage: SLIPPAGE_BPS / 10000,
    });

    // Sign and send
    const txHash = await this._sendTransaction(tx, [this.wallet, newPosition, ...signers]);

    return {
      id: newPosition.publicKey.toBase58(),
      pool,
      type: posConfig.type,
      name: posConfig.name,
      lowerPrice: posConfig.lowerPrice,
      upperPrice: posConfig.upperPrice,
      capitalUSD,
      txHash,
      openedAt: Date.now(),
      inRange: true,
      feesEarnedUSD: 0,
      tokenAAmount,
      tokenBAmount,
    };
  }

  // ── Close a position ───────────────────────────────────────────────────
  async closePosition(position) {
    if (this.simulationMode) {
      logger.info(`[SIM] Closed position ${position.id}`);
      return { success: true, feesCollected: position.feesEarnedUSD };
    }

    return this._withRetry(async () => {
      const poolAddress = new PublicKey(process.env[`${position.pool.replace('-','_')}_POOL`]);
      const dlmmPool = await this.dlmmModule.DLMM.create(this.connection, poolAddress);
      const posPublicKey = new PublicKey(position.id);

      const posData = await dlmmPool.getPosition(posPublicKey);

      // Claim fees first
      const claimTx = await dlmmPool.claimAllSwapFee({
        owner: this.wallet.publicKey,
        positions: [posData],
      });
      await this._sendTransaction(claimTx, [this.wallet]);

      // Remove all liquidity
      const binIds = posData.positionData.positionBinData.map(b => b.binId);
      const removeTx = await dlmmPool.removeLiquidity({
        position: posPublicKey,
        user: this.wallet.publicKey,
        binIds,
        liquiditiesBpsToRemove: binIds.map(() => new BN(10000)), // 100%
        shouldClaimAndClose: true,
      });

      const txHash = await this._sendTransaction(removeTx, [this.wallet]);
      logger.info(`Closed position ${position.id} | tx: ${txHash}`);

      return { success: true, txHash };
    }, `close-${position.id}`);
  }

  // ── Get accrued fees for a position ───────────────────────────────────
  async getAccruedFees(position) {
    if (this.simulationMode) {
      // Simulate fee accrual for testing
      const hoursOpen = (Date.now() - position.openedAt) / 3600000;
      const hourlyRate = position.capitalUSD * 0.001; // 0.1%/hr sim
      return {
        tokenA: 0,
        tokenB: 0,
        totalUSD: hourlyRate * hoursOpen,
        hourlyRate,
      };
    }

    try {
      const poolAddress = new PublicKey(process.env[`${position.pool.replace('-','_')}_POOL`]);
      const dlmmPool = await this.dlmmModule.DLMM.create(this.connection, poolAddress);
      const posPublicKey = new PublicKey(position.id);
      const posData = await dlmmPool.getPosition(posPublicKey);

      const feeX = posData.positionData.feeX.toNumber() / 1e9;  // SOL/HYPE decimals
      const feeY = posData.positionData.feeY.toNumber() / 1e6;  // USDC decimals

      // Get current price for USD conversion
      const price = parseFloat(position.currentPrice || 1);
      const [base] = position.pool.split('-');
      const feeXinUSD = base === 'SOL' ? feeX * price : feeX * price;
      const totalUSD = feeXinUSD + feeY;

      const hoursOpen = (Date.now() - position.openedAt) / 3600000;
      const hourlyRate = hoursOpen > 0 ? totalUSD / hoursOpen : 0;

      return { tokenA: feeX, tokenB: feeY, totalUSD, hourlyRate };
    } catch (err) {
      logger.debug(`Fee fetch error for ${position.id}: ${err.message}`);
      return { tokenA: 0, tokenB: 0, totalUSD: 0, hourlyRate: 0 };
    }
  }

  // ── Get wallet balances ────────────────────────────────────────────────
  async getBalances() {
    const solBalance = await this.connection.getBalance(this.wallet.publicKey);
    const usdcMint = new PublicKey(process.env.USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

    let usdcBalance = 0;
    try {
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint: usdcMint }
      );
      if (tokenAccounts.value.length > 0) {
        usdcBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
      }
    } catch {}

    return {
      SOL: solBalance / 1e9,
      USDC: usdcBalance,
    };
  }

  // ── Internal helpers ──────────────────────────────────────────────────
  async _calcTokenAmounts(pool, capitalUSD, currentPrice, posConfig) {
    // For a position centered on current price, split capital 50/50
    const tokenBAmount = Math.floor((capitalUSD / 2) * 1e6); // USDC (6 decimals)
    const [base] = pool.split('-');
    const decimals = base === 'SOL' ? 1e9 : 1e6; // SOL=9, HYPE=6 (check actual)
    const tokenAAmount = Math.floor((capitalUSD / 2 / currentPrice) * decimals);
    return { tokenAAmount, tokenBAmount };
  }

  async _getPoolCapital(pool) {
    const envKey = `MAX_CAPITAL_${pool.replace('-', '_')}`;
    return parseFloat(process.env[envKey] || '1000');
  }

  async _sendTransaction(tx, signers) {
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.wallet.publicKey;

    const txHash = await sendAndConfirmTransaction(
      this.connection,
      tx,
      signers,
      { commitment: 'confirmed', maxRetries: 3 }
    );
    return txHash;
  }

  _simulateOpenPosition(pool, posConfig, capitalUSD, currentPrice) {
    const id = `sim_${Date.now()}_${posConfig.name}`;
    logger.info(`[SIM] Opened ${posConfig.name} position ${id} for ${pool}`);
    return {
      id,
      pool,
      type: posConfig.type,
      name: posConfig.name,
      lowerPrice: posConfig.lowerPrice,
      upperPrice: posConfig.upperPrice,
      capitalUSD,
      txHash: 'simulated',
      openedAt: Date.now(),
      inRange: true,
      feesEarnedUSD: 0,
    };
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = LPManager;
