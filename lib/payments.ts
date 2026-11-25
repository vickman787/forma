import {
  createPublicClient,
  http,
  parseAbi,
  decodeEventLog,
  isAddress,
  type Hex,
  type Address,
} from "viem";
import { config } from "./config";
import { availability } from "./capabilities";
import { terms, type Order } from "./domain";
import { database } from "./db";
import { assert, now, event } from "./security";
import { enqueue, ownedOrder } from "./orders";
import { reserveProviderCall } from "./provider-budget";
import { checkoutReadiness } from "./health";
export const escrowAbi = parseAbi([
  "function jobs(bytes32) view returns (address customer,uint256 amount,bytes32 termsHash,bytes32 manifestHash,uint64 fundingExpiry,uint64 deliveryDeadline,uint64 reviewDeadline,uint8 state)",
  "function asset() view returns (address)",
  "function treasury() view returns (address)",
  "function operator() view returns (address)",
  "function fundJob(bytes32)",
  "function acceptDelivery(bytes32)",
  "function claimLateRefund(bytes32)",
  "event JobFunded(bytes32 indexed jobId,address indexed customer,address indexed token,uint256 amount)",
  "event JobCreated(bytes32 indexed jobId,address indexed customer,uint256 amount,bytes32 termsHash,uint64 fundingExpiry)",
  "event JobReleased(bytes32 indexed jobId,address indexed treasury,uint256 amount)",
  "event DeliverySubmitted(bytes32 indexed jobId,bytes32 manifestHash,uint64 reviewDeadline)",
  "event JobRefunded(bytes32 indexed jobId,address indexed customer,uint256 amount)",
]);
export const tokenAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
export async function recordPendingPayment(o: Order, txHash: unknown) {
  assert(
    o.mode === "live" &&
      typeof txHash === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(txHash),
    400,
    "Valid live funding transaction required",
  );
  const db = await database();
  return db.transaction(async (tx) => {
    const [current] = await tx.query(
      "SELECT payment,tx_hash FROM orders WHERE id=$1 AND owner=$2 FOR UPDATE",
      [o.id, o.owner],
    );
    assert(
      current && ["unfunded", "pending", "unknown"].includes(current.payment),
      409,
      "This order cannot record another funding transaction",
    );
    assert(
      !current.tx_hash || current.tx_hash === txHash,
      409,
      "Reconcile the saved transaction before attempting another payment.",
    );
    await tx.query(
      "UPDATE orders SET payment='pending',tx_hash=$1,updated_at=$2 WHERE id=$3",
      [txHash, now(), o.id],
    );
    return { ok: true };
  });
}
const client = () =>
  createPublicClient({
    transport: http(
      process.env.QIE_RPC_URL || "https://rpc1mainnet.qie.digital",
      { timeout: 12000, retryCount: 1 },
    ),
  });
export async function reconcilePayment(o: Order, txHash: unknown) {
  assert(
    o.mode === "live" &&
      typeof txHash === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(txHash),
    400,
    "Valid live funding transaction required",
  );
  const db = await database();
  if (
    ["pending", "unknown"].includes(o.payment) &&
    o.tx_hash &&
    o.tx_hash !== txHash
  )
    throw new Error(
      "Reconcile the saved transaction before attempting another payment.",
    );
  if (o.payment === "unfunded" || o.payment === "unknown")
    await db.query(
      "UPDATE orders SET payment=$1,tx_hash=$2,updated_at=$3 WHERE id=$4 AND payment IN ($5,$6)",
      ["pending", txHash, now(), o.id, "unfunded", "unknown"],
    );
  try {
    return await verifiedFunding(o, txHash);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown RPC outcome";
    const knownInvalid =
      /did not succeed|does not match|event not found|configuration mismatch|network mismatch/.test(
        message,
      );
    await db.query(
      "UPDATE orders SET payment=$1,tx_hash=$2,updated_at=$3 WHERE id=$4 AND payment=$5",
      [
        knownInvalid
          ? "unfunded"
          : message.includes("Waiting for three")
            ? "pending"
            : "unknown",
        knownInvalid ? null : txHash,
        now(),
        o.id,
        "pending",
      ],
    );
    throw e;
  }
}
export async function reconcileRegistration(o: Order, txHash: unknown) {
  assert(o.mode === "live", 409, "A live order is required");
  const { r, rpc, escrow, logs } = await receipt(o, txHash);
  const db = await database();
  const [q] = await db.query(
    "SELECT q.terms_hash,c.wallet FROM quotes q JOIN customers c ON c.id=q.owner WHERE q.id=$1 AND q.owner=$2",
    [o.quote_id, o.owner],
  );
  assert(q?.wallet, 409, "Matching customer quote not found");
  const l = logs.find(
    (l) =>
      l.eventName === "JobCreated" && (l.args as any).jobId === o.chain_job,
  );
  assert(l, 409, "Matching registration event not found");
  const a = l.args as any;
  const expiry = BigInt(Math.floor(Date.parse(o.funding_expires) / 1000));
  assert(
    a.customer.toLowerCase() === q.wallet.toLowerCase() &&
      a.amount === 1000000n &&
      a.termsHash === `0x${q.terms_hash}` &&
      a.fundingExpiry === expiry,
    409,
    "Registration does not match the frozen quote",
  );
  const job = await rpc.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "jobs",
    args: [o.chain_job as Hex],
  });
  assert(
    job[0].toLowerCase() === q.wallet.toLowerCase() &&
      job[1] === a.amount &&
      job[2] === a.termsHash &&
      job[4] === expiry &&
      job[7] > 0,
    409,
    "On-chain registration state mismatch",
  );
  await db.transaction(async (tx) => {
    const [old] = await tx.query(
      "SELECT id FROM chain_events WHERE chain_id=1990 AND tx_hash=$1 AND log_index=$2",
      [r.transactionHash, l.logIndex],
    );
    if (old) return;
    await tx.query(
      "INSERT INTO chain_events(id,chain_id,tx_hash,log_index,block_number,block_hash,action,order_id) VALUES($1,1990,$2,$3,$4,$5,$6,$7)",
      [
        `${r.transactionHash}:${l.logIndex}`,
        r.transactionHash,
        l.logIndex,
        String(r.blockNumber),
        r.blockHash,
        "registered",
        o.id,
      ],
    );
    await event(
      tx,
      o.id,
      "payment",
      "Matching quote registration confirmed on QIE. Customer funding is still required.",
    );
  });
  return ownedOrder(o.id, o.owner);
}
export async function reconcileDelivery(o: Order, txHash: unknown) {
  assert(
    o.mode === "live" && o.payment === "funded" && o.manifest_hash,
    409,
    "A checked, funded live delivery is required",
  );
  const { r, rpc, escrow, logs } = await receipt(o, txHash),
    l = logs.find(
      (l) =>
        l.eventName === "DeliverySubmitted" &&
        (l.args as any).jobId === o.chain_job,
    );
  assert(l, 409, "Matching delivery event not found");
  const a = l.args as any;
  assert(
    a.manifestHash === "0x" + o.manifest_hash,
    409,
    "Delivery manifest commitment mismatch",
  );
  const job = await rpc.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "jobs",
    args: [o.chain_job as Hex],
  });
  assert(
    job[7] === 3 && job[3] === a.manifestHash && job[6] === a.reviewDeadline,
    409,
    "On-chain delivery state mismatch",
  );
  const db = await database();
  await db.transaction(async (tx) => {
    const existing = await tx.query(
      "SELECT id FROM chain_events WHERE chain_id=1990 AND tx_hash=$1 AND log_index=$2",
      [r.transactionHash, l.logIndex],
    );
    if (existing.length) return;
    await tx.query(
      "INSERT INTO chain_events(id,chain_id,tx_hash,log_index,block_number,block_hash,action,order_id) VALUES($1,1990,$2,$3,$4,$5,$6,$7)",
      [
        `${r.transactionHash}:${l.logIndex}`,
        r.transactionHash,
        l.logIndex,
        String(r.blockNumber),
        r.blockHash,
        "delivered",
        o.id,
      ],
    );
    await tx.query(
      "UPDATE orders SET work=$1,review_due=$2,updated_at=$3 WHERE id=$4",
      ["delivered", new Date(Number(job[6]) * 1000).toISOString(), now(), o.id],
    );
    await event(
      tx,
      o.id,
      "deliver",
      "Manifest commitment confirmed on QIE. Customer review window is open.",
    );
  });
  return ownedOrder(o.id, o.owner);
}
export async function verifiedConfig() {
  assert(
    config().mode === "live",
    409,
    "Mainnet reconciliation requires live configuration.",
  );
  const escrow = process.env.ESCROW_ADDRESS;
  assert(escrow && isAddress(escrow), 503, "Escrow is not configured.");
  const rpc = client();
  assert((await rpc.getChainId()) === 1990, 503, "RPC network mismatch");
  const [asset, treasury, decimals, operator] = await Promise.all([
    rpc.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "asset",
    }),
    rpc.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "treasury",
    }),
    rpc.readContract({
      address: terms.token as Address,
      abi: tokenAbi,
      functionName: "decimals",
    }),
    rpc.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "operator",
    }),
  ]);
  assert(
    asset.toLowerCase() === terms.token.toLowerCase() &&
      decimals === 6 &&
      treasury.toLowerCase() === process.env.TREASURY_ADDRESS?.toLowerCase() &&
      operator.toLowerCase() === process.env.OPERATOR_ADDRESS?.toLowerCase(),
    503,
    "Escrow/token configuration mismatch",
  );
  return { rpc, escrow: escrow as Address };
}
export async function paymentInfo(o: Order) {
  const c = config();
  const localValidation = c.localOnly && c.localCheckoutOrder === o.id;
  const ready = availability(o.brief.service, o.generation, o.id);
  const settlementOnly = ["funded", "released", "refunded"].includes(o.payment);
  if (!ready.enabled && !settlementOnly)
    return { mode: o.mode, enabled: false, reason: ready.reason, terms };

  if (!c.liveEnabled && !localValidation && !settlementOnly)
    return {
      mode: "live",
      enabled: false,
      reason: "Live checkout awaits deployment and settlement verification.",
    };
  if (!settlementOnly && !localValidation) {
    const operational=await checkoutReadiness();
    if(!operational.enabled) return {mode:"live",...operational,terms};
  }
  const { rpc, escrow } = await verifiedConfig();
  const job = await rpc.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "jobs",
    args: [o.chain_job as Hex],
  });
  const db = await database(),
    [q] = await db.query(
      "SELECT q.terms_hash,c.wallet FROM quotes q JOIN customers c ON c.id=q.owner WHERE q.id=$1",
      [o.quote_id],
    );
  assert(q?.wallet, 409, "Matching customer quote not found");
  if (job[7] === 0)
    return {
      mode: "live",
      enabled: false,
      registrationPending: true,
      reason: "Registering your quote on QIE. This page checks automatically.",
      terms,
    };
  assert(
    job[0].toLowerCase() === q.wallet.toLowerCase() &&
      job[1] === 1000000n &&
      job[2] === "0x" + q.terms_hash &&
      job[4] === BigInt(Math.floor(Date.parse(o.funding_expires) / 1000)) &&
      job[7] > 0,
    409,
    "Operator has not registered the matching quote on chain.",
  );
  if (!settlementOnly && job[7] === 1 && Number(job[4]) * 1000 > Date.now()) {
    try {
      await reserveProviderCall(o.id);
    } catch {
      return {
        mode: "live",
        enabled: false,
        reason:
          "Generation capacity is currently full. Your wallet has not been charged. Please try again later.",
        terms,
      };
    }
  }
  return {
    mode: "live",
    enabled:
      settlementOnly || (job[7] === 1 && Number(job[4]) * 1000 > Date.now()),
    reason: settlementOnly
      ? undefined
      : job[7] > 1
        ? "Funding is already recorded on chain. Reconcile the saved transaction before paying again."
        : Number(job[4]) * 1000 <= Date.now()
          ? "This quote has expired. Request a fresh quote."
          : undefined,
    escrow,
    treasury: process.env.TREASURY_ADDRESS,
    token: terms.token,
    chainId: 1990,
    amount: "1000000",
    state: job[7],
    fundingExpires: new Date(Number(job[4]) * 1000).toISOString(),
    terms,
  };
}
async function receipt(o: Order, txHash: unknown) {
  assert(
    typeof txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(txHash),
    400,
    "Invalid transaction hash",
  );
  const { rpc, escrow } = await verifiedConfig();
  const r = await rpc.getTransactionReceipt({ hash: txHash as Hex });
  assert(
    r.status === "success" && r.to?.toLowerCase() === escrow.toLowerCase(),
    409,
    "Transaction did not succeed at this escrow",
  );
  assert(
    (await rpc.getBlockNumber()) >= r.blockNumber + 2n,
    409,
    "Waiting for three block confirmations. Recheck shortly.",
  );
  const block = await rpc.getBlock({ blockNumber: r.blockNumber });
  assert(block.hash === r.blockHash, 409, "Receipt is no longer canonical.");
  const logs = r.logs
    .filter((l) => l.address.toLowerCase() === escrow.toLowerCase())
    .flatMap((l) => {
      try {
        return [
          {
            ...decodeEventLog({
              abi: escrowAbi,
              data: l.data,
              topics: l.topics,
            }),
            logIndex: l.logIndex,
          },
        ];
      } catch {
        return [];
      }
    });
  return { r, rpc, escrow, logs };
}
async function verifiedFunding(o: Order, txHash: unknown) {
  assert(o.mode === "live", 403, "Not a live order");
  const { r, rpc, escrow, logs } = await receipt(o, txHash);
  const db = await database(),
    [customer] = await db.query(
      "SELECT c.wallet,q.terms_hash FROM customers c JOIN quotes q ON q.owner=c.id WHERE c.id=$1 AND q.id=$2",
      [o.owner, o.quote_id],
    );
  assert(customer?.wallet, 409, "Matching funding customer not found");
  const l = logs.find(
    (l) => l.eventName === "JobFunded" && (l.args as any).jobId === o.chain_job,
  );
  assert(l, 409, "Matching funding event not found");
  const a = l.args as any;
  assert(
    a.customer.toLowerCase() === customer.wallet &&
      a.token.toLowerCase() === terms.token.toLowerCase() &&
      a.amount === 1000000n,
    409,
    "Funding event does not match this order",
  );
  const job = await rpc.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "jobs",
    args: [o.chain_job as Hex],
  });
  assert(job[7] === 2, 409, "Job is no longer in funded state");
  assert(
    job[0].toLowerCase() === customer.wallet.toLowerCase() &&
      job[1] === 1000000n &&
      job[2] === `0x${customer.terms_hash}` &&
      job[4] === BigInt(Math.floor(Date.parse(o.funding_expires) / 1000)),
    409,
    "Funding job does not match the frozen quote",
  );
  await db.transaction(async (tx) => {
    const [old] = await tx.query(
      "SELECT id FROM chain_events WHERE chain_id=1990 AND tx_hash=$1 AND log_index=$2",
      [r.transactionHash, l.logIndex],
    );
    if (old) return;
    const current = await ownedOrder(o.id, o.owner, tx);
    assert(
      ["unfunded", "pending", "unknown"].includes(current.payment),
      409,
      "Order already settled or funded",
    );
    await tx.query(
      "INSERT INTO chain_events(id,chain_id,tx_hash,log_index,block_number,block_hash,action,order_id) VALUES($1,1990,$2,$3,$4,$5,$6,$7)",
      [
        `${r.transactionHash}:${l.logIndex}`,
        r.transactionHash,
        l.logIndex,
        String(r.blockNumber),
        r.blockHash,
        "funded",
        o.id,
      ],
    );
    await tx.query(
      "UPDATE orders SET payment=$1,work=$2,delivery_due=$3,tx_hash=$4,updated_at=$5 WHERE id=$6",
      [
        "funded",
        "queued",
        new Date(Number(job[5]) * 1000).toISOString(),
        r.transactionHash,
        now(),
        o.id,
      ],
    );
    await enqueue(tx, o.id);
    await event(
      tx,
      o.id,
      "payment",
      "QUSDC funding verified on QIE mainnet with three confirmations.",
    );
  });
  return ownedOrder(o.id, o.owner);
}
export async function reconcileDecision(o: Order, txHash: unknown) {
  assert(o.mode === "live", 409, "A live order is required");
  const { r, rpc, escrow, logs } = await receipt(o, txHash);
  const db = await database(),
    [c] = await db.query("SELECT wallet FROM customers WHERE id=$1", [o.owner]);
  const l = logs.find(
    (l) =>
      ["JobReleased", "JobRefunded"].includes(l.eventName) &&
      (l.args as any).jobId === o.chain_job,
  );
  assert(l, 409, "No matching settlement event");
  const a = l.args as any;
  assert(a.amount === 1000000n, 409, "Settlement amount mismatch");
  const released = l.eventName === "JobReleased";
  assert(
    (released ? a.treasury : a.customer).toLowerCase() ===
      (released ? process.env.TREASURY_ADDRESS : c.wallet)?.toLowerCase(),
    409,
    "Settlement recipient mismatch",
  );
  const job = await rpc.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "jobs",
    args: [o.chain_job as Hex],
  });
  assert(job[7] === (released ? 4 : 5), 409, "Settlement state mismatch");
  if (released)
    assert(
      o.manifest_hash && job[3] === "0x" + o.manifest_hash,
      409,
      "Delivery commitment mismatch",
    );
  await db.transaction(async (tx) => {
    const [old] = await tx.query(
      "SELECT id FROM chain_events WHERE chain_id=1990 AND tx_hash=$1 AND log_index=$2",
      [r.transactionHash, l.logIndex],
    );
    if (old) return;
    await tx.query(
      "INSERT INTO chain_events(id,chain_id,tx_hash,log_index,block_number,block_hash,action,order_id) VALUES($1,1990,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
      [
        `${r.transactionHash}:${l.logIndex}`,
        r.transactionHash,
        l.logIndex,
        String(r.blockNumber),
        r.blockHash,
        released ? "released" : "refunded",
        o.id,
      ],
    );
    await tx.query(
      "UPDATE orders SET work=$1,payment=$2,updated_at=$3 WHERE id=$4",
      ["closed", released ? "released" : "refunded", now(), o.id],
    );
    await event(
      tx,
      o.id,
      "settled",
      released
        ? "Treasury release confirmed on QIE."
        : "Refund to customer confirmed on QIE.",
    );
  });
  return ownedOrder(o.id, o.owner);
}
