# Hive Stable Router

**USDC ↔ USDT atomic routing on Base mainnet. 8 bps Hive take.**

> Phase 1: quote + route ledger. Phase 2: on-chain Uniswap v3 liquidity routing (pending user-authorized routing wallet deployment — regulatory caution).

[![MCP](https://img.shields.io/badge/MCP-2024--11--05-C08D23)](https://github.com/srotzin/hive-stable-router)
[![Network](https://img.shields.io/badge/network-Base%208453-0052FF)](https://base.org)
[![Phase](https://img.shields.io/badge/phase-1%20quote%20%2B%20ledger-C08D23)](#phase-disclosure)

---

## Overview

Hive Stable Router quotes and logs USDC↔USDT swaps on Base mainnet. Rate sourced from the Uniswap v3 USDC/USDT 0.01% pool (`slot0`), with 8 basis point Hive markup applied to the destination side. Payments flow to Monroe (`0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`) in the source asset via HTTP 402 challenge.

**Settlement assets (Base mainnet):**

| Asset | Contract |
|-------|----------|
| USDC  | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| USDT  | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` |

**Monroe (payment address):** `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`

---

## Phase Disclosure

**Phase 1 (current):** This server quotes rates and maintains a swap ledger. It does not autonomously execute on-chain transactions. The 402 challenge demands payment in the source asset to Monroe. On payment confirmation, a settlement record is logged and returned. Destination asset transfer is manual pending Phase 2.

**Phase 2 (roadmap):** On-chain liquidity routing via Uniswap v3 USDC/USDT 0.01% pool on Base, triggered by verified on-chain payment. Requires deployment of a user-authorized routing wallet and associated compliance review.

---

## Pricing

8 basis points on source notional. Rate = Uniswap v3 slot0 spot + 8 bps markup.

| Notional | Hive Take (8 bps) | Est. Received |
|----------|-------------------|---------------|
| $100     | $0.08             | $99.92        |
| $1,000   | $0.80             | $999.20       |
| $10,000  | $8.00             | $9,992.00     |
| $100,000 | $80.00            | $99,920.00    |

*Spot rate from Uniswap v3 USDC/USDT 0.01% pool (Base). Fallback: 1.0001 hardcoded if RPC unavailable.*

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health |
| GET | `/` | Service manifest |
| GET | `/.well-known/agent.json` | Monroe agent card |
| POST | `/mcp` | MCP JSON-RPC 2.0 |
| GET | `/v1/stable-router/quote` | Get swap quote |
| POST | `/v1/stable-router/swap` | Initiate swap (402-gated) |
| GET | `/v1/stable-router/status/:id` | Settlement status |

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_quote` | Quote USDC↔USDT. Returns rate, 8 bps take, atomic amounts, quote_id, expires_at. |
| `swap` | Initiate swap via 402 payment challenge. Requires quote_id + recipient_address. |
| `get_status` | Retrieve settlement record by settlement_id. |

### Connect (MCP)

```json
{
  "mcpServers": {
    "hive-stable-router": {
      "url": "https://hive-stable-router.onrender.com/mcp",
      "transport": "streamable-http"
    }
  }
}
```

---

## Usage

### Get a Quote

```bash
curl "https://hive-stable-router.onrender.com/v1/stable-router/quote?from=USDT&to=USDC&amount=10000"
```

Response:
```json
{
  "quote_id": "a1b2c3d4e5f6...",
  "from": "USDT",
  "to": "USDC",
  "amount_src": 10000,
  "spot_rate": 1.0001,
  "effective_rate": 1.000908,
  "hive_take_bps": 8,
  "hive_take_atomic": 80000,
  "est_destination_atomic": 9920000,
  "est_destination": 9.92,
  "expires_at": "2025-01-01T00:01:00Z",
  "payment_required": {
    "asset": "USDT",
    "contract": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    "network": "base",
    "chain_id": 8453,
    "pay_to": "0x15184bf50b3d3f52b60434f8942b7d52f2eb436e",
    "amount_atomic": 10000000000
  }
}
```

### Initiate Swap (402 Flow)

```bash
# Step 1 — get 402 challenge
curl -X POST "https://hive-stable-router.onrender.com/v1/stable-router/swap" \
  -H "Content-Type: application/json" \
  -d '{"quote_id":"<id>","recipient_address":"0xYOUR_ADDRESS"}'
# → 402 with payment challenge

# Step 2 — pay source asset to Monroe on Base, then retry with receipt
curl -X POST "https://hive-stable-router.onrender.com/v1/stable-router/swap" \
  -H "Content-Type: application/json" \
  -H "X-Payment: <erc20-transfer-receipt>" \
  -d '{"quote_id":"<id>","recipient_address":"0xYOUR_ADDRESS"}'
# → settlement_id + logged record
```

---

## Rate Source

The spot rate is queried from the Uniswap v3 USDC/USDT 0.01% pool on Base (`0xd0b53D9277642d899DF5C87A3966A349A798F224`) via `slot0()`. If the RPC call fails or returns an out-of-range value, the server falls back to `1.0001` and notes `"source":"hardcoded-fallback"` in the quote response. Cache TTL: 60 seconds.

---

## Smithery

[https://smithery.ai/server/srotzin/hive-stable-router](https://smithery.ai/server/srotzin/hive-stable-router)

---

## Legal

MIT License. Phase 1 is a ledger primitive — not a registered money transmitter, exchange, or broker-dealer. On-chain liquidity routing (Phase 2) will deploy only with appropriate compliance review.


---

## Hive Civilization

Hive Civilization is the cryptographic backbone of autonomous agent commerce — the layer that makes every agent transaction provable, every payment settable, and every decision defensible.

This repository is part of the **PROVABLE · SETTABLE · DEFENSIBLE** pillar.

- thehiveryiq.com
- hiveagentiq.com
- agent-card: https://hivetrust.onrender.com/.well-known/agent-card.json
