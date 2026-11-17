// node dlmm_terminal/executor/test_flip.mjs — where a flip puts the new range, and when it may fire (no RPC).
import assert from "node:assert/strict";
import { flipRange, crossed, rentLamports } from "./flip.mjs";

// SOL is Y (the usual TOKEN/SOL pool): the token lives above the active bin.
// bid (SOL below the price) fell through -> ask: token-only range just above the price, same width
assert.deepEqual(flipRange({ to: "ask", activeId: 100, width: 70, gap: 1, tokenIsX: true }), { lo: 101, hi: 170 });
// ask ran up through -> bid: SOL-only range just below the price
assert.deepEqual(flipRange({ to: "bid", activeId: 100, width: 70, gap: 1, tokenIsX: true }), { lo: 30, hi: 99 });
// SOL is X: everything mirrors
assert.deepEqual(flipRange({ to: "ask", activeId: 100, width: 10, gap: 2, tokenIsX: false }), { lo: 89, hi: 98 });
assert.deepEqual(flipRange({ to: "bid", activeId: 100, width: 10, gap: 2, tokenIsX: false }), { lo: 102, hi: 111 });

// bid range 30..99 (below price 100). Price falls to 25: fully through -> ready to flip
assert.equal(crossed({ from: "bid", activeId: 25, lo: 30, hi: 99, tokenIsX: true }), true);
assert.equal(crossed({ from: "bid", activeId: 50, lo: 30, hi: 99, tokenIsX: true }), false, "still inside: not yet");
assert.equal(crossed({ from: "bid", activeId: 120, lo: 30, hi: 99, tokenIsX: true }), false, "price above a bid is just waiting");
// ask range 101..170, price runs to 180 -> all SOL -> flip back
assert.equal(crossed({ from: "ask", activeId: 180, lo: 101, hi: 170, tokenIsX: true }), true);
assert.equal(crossed({ from: "ask", activeId: 90, lo: 101, hi: 170, tokenIsX: true }), false);
// SOL is X: a bid sits above the active bin and fills when the active bin climbs past it
assert.equal(crossed({ from: "bid", activeId: 120, lo: 101, hi: 110, tokenIsX: false }), true);

assert.equal(rentLamports(70), 41_900_000);
assert.ok(rentLamports(140) > rentLamports(70));
console.log("flip tests ok");
