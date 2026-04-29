import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// ─── Constants ────────────────────────────────────────────────────────────────
const MONROE        = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const BASE_USDC     = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_USDT     = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2';
const CHAIN_ID      = 8453;
const HIVE_TAKE_BPS = 8;
const HMAC_SECRET   = process.env.HMAC_SECRET || 'hive-stable-router-dev-secret';
const PORT          = process.env.PORT || 3000;
const SETTLEMENTS   = '/tmp/router_settlements.jsonl';

// ─── Uniswap v3 USDC/USDT 0.01% pool slot0 (Base mainnet) ────────────────────
// Pool address: 0xd0b53D9277642d899DF5C87A3966A349A798F224 (USDC/USDT 100 fee)
const UNI_V3_POOL   = '0xd0b53D9277642d899DF5C87A3966A349A798F224';
const BASE_RPC      = 'https://mainnet.base.org';

async function fetchSlot0Rate() {
  // slot0() ABI selector: 0x3850c7bd
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [
      { to: UNI_V3_POOL, data: '0x3850c7bd' },
      'latest'
    ]
  };
  const res = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(4000)
  });
  const json = await res.json();
  if (!json.result || json.result === '0x') throw new Error('empty slot0');
  // sqrtPriceX96 is the first 32 bytes of result (uint160)
  const sqrtPriceX96 = BigInt('0x' + json.result.slice(2, 66));
  const Q96 = BigInt(2) ** BigInt(96);
  // price = (sqrtPriceX96 / 2^96)^2  — token1/token0
  // pool: token0=USDC(6), token1=USDT(6) — same decimals, no adjustment needed
  const priceRaw = Number(sqrtPriceX96 * sqrtPriceX96) / Number(Q96 * Q96);
  return priceRaw;
}

let cachedRate = { rate: 1.0001, ts: 0, source: 'hardcoded-fallback' };

async function getSpotRate() {
  const now = Date.now();
  if (now - cachedRate.ts < 60_000) return cachedRate; // 60s TTL
  try {
    const r = await fetchSlot0Rate();
    if (r > 0.99 && r < 1.01) {
      cachedRate = { rate: r, ts: now, source: 'uniswap-v3-slot0' };
    } else {
      cachedRate = { rate: 1.0001, ts: now, source: 'hardcoded-fallback' };
    }
  } catch (_) {
    cachedRate = { rate: 1.0001, ts: now, source: 'hardcoded-fallback' };
  }
  return cachedRate;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeQuoteId(from, to, amount, nonce) {
  return crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(`${from}:${to}:${amount}:${nonce}`)
    .digest('hex')
    .slice(0, 32);
}

function contractFor(asset) {
  if (asset === 'USDC') return BASE_USDC;
  if (asset === 'USDT') return BASE_USDT;
  return null;
}

function atomicAmount(amount, decimals = 6) {
  return Math.round(Number(amount) * 10 ** decimals);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'hive-stable-router', version: '1.0.0' })
);

// Root
app.get('/', (_req, res) =>
  res.json({
    service: 'Hive Stable Router',
    description: 'USDC↔USDT atomic routing on Base. 8 bps take.',
    version: '1.0.0',
    phase: 'Phase 1 — quote + ledger',
    endpoints: {
      quote: 'GET /v1/stable-router/quote',
      swap:  'POST /v1/stable-router/swap  (402-gated)',
      status:'GET /v1/stable-router/status/:id',
      mcp:   'POST /mcp (JSON-RPC 2.0)'
    },
    docs: 'https://github.com/srotzin/hive-stable-router'
  })
);

// Agent card (Monroe)
app.get('/.well-known/agent.json', (_req, res) =>
  res.json({
    name: 'Hive Stable Router',
    description: 'USDC↔USDT stablecoin routing on Base. 8 bps. Phase 1.',
    version: '1.0.0',
    url: process.env.PUBLIC_URL || 'https://hive-stable-router.onrender.com',
    provider: {
      name: 'The Hivery',
      url: 'https://thehiveryiq.com'
    },
    capabilities: {
      payments: {
        '402': true,
        networks: ['base'],
        assets: ['USDC', 'USDT']
      }
    },
    payment_address: {
      address: MONROE,
      network: 'base',
      chain_id: CHAIN_ID
    },
    tools: ['get_quote', 'swap', 'get_status']
  })
);

// ─── MCP JSON-RPC ─────────────────────────────────────────────────────────────
app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') return res.status(400).json({ error: 'bad jsonrpc' });

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        tools: [
          {
            name: 'get_quote',
            description: 'Get a USDC↔USDT swap quote with 8 bps Hive take. Returns quote_id, rate, and payment details.',
            inputSchema: {
              type: 'object',
              properties: {
                from:   { type: 'string', enum: ['USDC', 'USDT'], description: 'Source asset' },
                to:     { type: 'string', enum: ['USDC', 'USDT'], description: 'Destination asset' },
                amount: { type: 'number', description: 'Source amount (human-readable, e.g. 10000 for $10,000)' }
              },
              required: ['from', 'to', 'amount']
            }
          },
          {
            name: 'swap',
            description: 'Initiate a USDC↔USDT swap (402-gated). Requires prior quote_id and recipient_address. Returns settlement_id.',
            inputSchema: {
              type: 'object',
              properties: {
                quote_id:          { type: 'string', description: 'Quote ID from get_quote' },
                recipient_address: { type: 'string', description: 'Base address to receive destination asset' }
              },
              required: ['quote_id', 'recipient_address']
            }
          },
          {
            name: 'get_status',
            description: 'Retrieve status of a swap by settlement_id.',
            inputSchema: {
              type: 'object',
              properties: {
                settlement_id: { type: 'string', description: 'Settlement ID from swap response' }
              },
              required: ['settlement_id']
            }
          }
        ]
      }
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    if (toolName === 'get_quote') {
      const { from, to, amount } = toolArgs;
      const result = await buildQuote(from, to, amount);
      if (result.error) return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    }

    if (toolName === 'swap') {
      // Return 402 info as text since MCP doesn't have 402 natively
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              note: 'Use POST /v1/stable-router/swap directly — 402 payment challenge required',
              docs: 'https://github.com/srotzin/hive-stable-router#swap'
            })
          }]
        }
      });
    }

    if (toolName === 'get_status') {
      const { settlement_id } = toolArgs;
      const record = findSettlement(settlement_id);
      return res.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(record || { error: 'not_found' }) }] }
      });
    }

    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }

  return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});

// ─── Quote ────────────────────────────────────────────────────────────────────
async function buildQuote(from, to, amount) {
  if (!['USDC', 'USDT'].includes(from) || !['USDC', 'USDT'].includes(to))
    return { error: 'from/to must be USDC or USDT' };
  if (from === to) return { error: 'from and to must differ' };
  const amt = Number(amount);
  if (!amt || amt <= 0) return { error: 'invalid amount' };

  const spot = await getSpotRate();
  // Apply 8 bps markup: customer pays slightly more
  const hiveTakeFraction = HIVE_TAKE_BPS / 10000;
  const effectiveRate = spot.rate * (1 + hiveTakeFraction);

  const srcAtomic  = atomicAmount(amt);
  const hiveTakeAtomic = Math.round(srcAtomic * hiveTakeFraction);
  const destAtomic = Math.round(srcAtomic * spot.rate - hiveTakeAtomic);

  const nonce    = crypto.randomBytes(8).toString('hex');
  const quoteId  = makeQuoteId(from, to, amount, nonce);
  const expiresAt = new Date(Date.now() + 60_000).toISOString(); // 60s TTL

  return {
    quote_id:              quoteId,
    from,
    to,
    amount_src:            amt,
    amount_src_atomic:     srcAtomic,
    spot_rate:             spot.rate,
    spot_rate_source:      spot.source,
    effective_rate:        effectiveRate,
    hive_take_bps:         HIVE_TAKE_BPS,
    hive_take_atomic:      hiveTakeAtomic,
    est_destination_atomic: destAtomic,
    est_destination:       destAtomic / 1e6,
    expires_at:            expiresAt,
    payment_required: {
      asset:    from,
      contract: contractFor(from),
      network:  'base',
      chain_id: CHAIN_ID,
      pay_to:   MONROE,
      amount_atomic: srcAtomic
    }
  };
}

// ─── BOGO redemption middleware (X-Hive-BOGO-Token) ─────────────────────
// Phase 1: calls hive-gamification /v1/bogo/redeem; bypasses 402 on consumed:true.
// Phase 2 (planned): zero-trust redemption with token-bound HMAC.
async function bogoRedeemMiddleware(req, res, next) {
  const token = req.headers['x-hive-bogo-token'];
  if (!token) return next();
  try {
    const r = await fetch('https://hive-gamification.onrender.com/v1/bogo/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, mechanic_id: 'stable-router-quote' }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const j = await r.json();
      if (j.consumed === true) {
        req._bogo_redeemed = true;
        import('fs').then(({ appendFileSync }) => {
          try { appendFileSync('/tmp/stable_router_bogo_redemptions.jsonl', JSON.stringify({ token: token.slice(0, 12), mechanic_id: 'stable-router-quote', ts: Date.now() }) + '\n'); } catch (_) {}
        });
        return next();
      }
    }
  } catch (_) {}
  return next();
}

// ─── Quote (x402-gated, $0.10 USDC) ─────────────────────────────────
app.get('/v1/stable-router/quote', bogoRedeemMiddleware, async (req, res) => {
  // BOGO bypass or check for x402 payment
  if (!req._bogo_redeemed) {
    const paymentHeader = req.headers['x-payment'] || req.headers['x-payment-receipt'];
    if (!paymentHeader) {
      return res.status(402).json({
        x402Version: 1,
        error: 'Payment required',
        accepts: [{
          scheme: 'exact',
          network: 'base',
          chainId: CHAIN_ID,
          asset: 'USDC',
          contract: BASE_USDC,
          maxAmountRequired: '100000', // $0.10 USDC atomic
          payTo: MONROE,
          resource: '/v1/stable-router/quote',
          description: 'Stable router quote — $0.10 USDC on Base mainnet',
          mimeType: 'application/json',
        }],
        bogo: {
          first_use_free: true,
          claim_endpoint: 'https://hive-gamification.onrender.com/v1/bogo/claim',
          redeem_header: 'X-Hive-BOGO-Token',
          mechanic_id: 'stable-router-quote',
        },
      });
    }
  }
  const { from, to, amount } = req.query;
  const result = await buildQuote(from, to, amount);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// ─── Swap (402-gated) ─────────────────────────────────────────────────────────
app.post('/v1/stable-router/swap', async (req, res) => {
  const { quote_id, recipient_address } = req.body || {};

  if (!quote_id || !recipient_address) {
    return res.status(400).json({ error: 'quote_id and recipient_address required' });
  }

  // Check for 402 payment proof header
  const paymentHeader = req.headers['x-payment'] || req.headers['x-payment-receipt'] || req.headers['x-402-payment'];

  if (!paymentHeader) {
    // Issue 402 challenge
    // Reconstruct the source asset from the quote_id prefix or require a query param
    const srcAsset = req.query.from || req.body.from || 'USDC';
    const srcAmt   = req.body.amount_atomic || req.query.amount_atomic || 1000000; // default $1 if not provided

    return res.status(402).json({
      x402Version: 1,
      error: 'Payment required',
      accepts: [
        {
          scheme:  'exact',
          network: 'base',
          chainId: CHAIN_ID,
          asset:   srcAsset,
          contract: contractFor(srcAsset),
          amount:  String(srcAmt),
          payTo:   MONROE,
          mimeType: 'application/json',
          description: `Pay ${srcAmt} atomic ${srcAsset} to Monroe to initiate stable swap`
        }
      ],
      instructions: 'Include X-Payment header with ERC-20 transfer receipt after on-chain payment.'
    });
  }

  // Payment header present — log settlement
  const settlementId = 'stl_' + crypto.randomBytes(12).toString('hex');
  const record = {
    settlement_id:     settlementId,
    quote_id,
    recipient_address,
    payment_header:    paymentHeader,
    source_tx_logged:  new Date().toISOString(),
    destination_tx:    'phase2-pending',
    status:            'phase1-logged',
    phase:             1,
    note:              'Phase 1: quote and route ledger. Phase 2: on-chain liquidity routing via Uniswap v3.',
    logged_at:         new Date().toISOString()
  };

  fs.appendFileSync(SETTLEMENTS, JSON.stringify(record) + '\n');

  return res.json(record);
});

// ─── Status ───────────────────────────────────────────────────────────────────
function findSettlement(id) {
  try {
    const lines = fs.readFileSync(SETTLEMENTS, 'utf8').trim().split('\n').filter(Boolean);
    for (const l of lines) {
      const r = JSON.parse(l);
      if (r.settlement_id === id) return r;
    }
  } catch (_) {}
  return null;
}

app.get('/v1/stable-router/status/:settlement_id', (req, res) => {
  const record = findSettlement(req.params.settlement_id);
  if (!record) return res.status(404).json({ error: 'not_found' });
  res.json(record);
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`hive-stable-router v1.0.0 listening on :${PORT}`)
);
