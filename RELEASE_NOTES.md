# v1.0.0 — Hive Stable Router MCP Server

**USDC ↔ USDT atomic routing on Base mainnet. 8 bps Hive take.**

## What's Included

### MCP Tools (3)

| Tool | Description |
|------|-------------|
| `get_quote` | Quote USDC↔USDT swap. Returns rate from Uniswap v3 USDC/USDT 0.01% pool + 8 bps Hive markup, atomic amounts, quote_id, expires_at. |
| `swap` | Initiate swap via HTTP 402 challenge. Source asset paid to Monroe. Returns settlement_id + ledger record. |
| `get_status` | Retrieve settlement record by settlement_id. |

### Backend Endpoint

`https://hive-stable-router.onrender.com`

### Settlement Rails

| Asset | Base Contract |
|-------|---------------|
| USDC  | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| USDT  | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` |

**Monroe (payment address):** `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`

### Phase Disclosure

**Phase 1:** Quote + route ledger. 402 challenge fires in source asset. Settlement record logged to JSONL. No autonomous on-chain routing.

**Phase 2 (roadmap):** On-chain Uniswap v3 routing, pending user-authorized routing wallet.

### Pricing

8 basis points on notional. Rate from Uniswap v3 USDC/USDT 0.01% pool (Base). Fallback: 1.0001.

### Council Provenance

Ad-hoc launch. Real rails: Base USDC + Base USDT mainnet.

---

*Brand: Hive Gold #C08D23 — The Hivery*
