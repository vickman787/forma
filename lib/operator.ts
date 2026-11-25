import { encodeFunctionData, isAddress, parseAbi, type Hex } from "viem";
import type { Order } from "./domain";
export const operatorActions = [
  "create",
  "deliver",
  "refund",
  "release",
] as const;
export type OperatorAction = (typeof operatorActions)[number];
const abi = parseAbi([
  "function createJob(bytes32,address,uint256,bytes32,uint64)",
  "function submitDelivery(bytes32,bytes32)",
  "function refundJob(bytes32)",
  "function claimReviewRelease(bytes32)",
]);
const bytes32 = (value: string) => /^0x[0-9a-fA-F]{64}$/.test(value);
const address = (value: string) =>
  isAddress(value) && !/^0x0{40}$/i.test(value);
export function validateDeliveryState(
  order: Order,
  quote: { wallet: string; terms_hash: string },
  job: readonly [
    string,
    bigint,
    string,
    string,
    bigint,
    bigint,
    bigint,
    number,
  ],
  clock = Date.now(),
) {
  if (
    job[7] !== 2 ||
    job[0].toLowerCase() !== quote.wallet.toLowerCase() ||
    job[1] !== 1000000n ||
    job[2].toLowerCase() !== `0x${quote.terms_hash}`.toLowerCase() ||
    job[4] !== BigInt(Math.floor(Date.parse(order.funding_expires) / 1000)) ||
    !order.delivery_due ||
    job[5] !== BigInt(Math.floor(Date.parse(order.delivery_due) / 1000)) ||
    Number(job[5]) * 1000 <= clock
  )
    throw new Error(
      "On-chain funded job does not match the delivery's frozen customer, amount, terms or deadline",
    );
}
export function operatorPlan(
  o: Order,
  quote: { wallet: string; terms_hash: string },
  action: OperatorAction,
  settings: { escrow: string; operator: string },
  clock = Date.now(),
) {
  if (!operatorActions.includes(action))
    throw new Error("Unknown operator action.");
  if (o.mode !== "live") throw new Error("A live order is required.");
  if (
    !address(settings.escrow) ||
    !address(settings.operator) ||
    !address(quote.wallet)
  )
    throw new Error(
      "Nonzero escrow, operator and customer addresses are required.",
    );
  if (!bytes32(o.chain_job) || !bytes32(`0x${quote.terms_hash}`))
    throw new Error("Invalid job or terms commitment.");
  const job = o.chain_job as Hex;
  let data: Hex;
  if (action === "create") {
    const expiry = Math.floor(Date.parse(o.funding_expires) / 1000),
      current = Math.floor(clock / 1000);
    if (
      o.payment !== "unfunded" ||
      o.work !== "awaiting_funding" ||
      !Number.isFinite(expiry) ||
      expiry <= current ||
      expiry > current + 1800
    )
      throw new Error(
        "Quote is not fundable within its original funding window.",
      );
    data = encodeFunctionData({
      abi,
      functionName: "createJob",
      args: [
        job,
        quote.wallet as Hex,
        1000000n,
        `0x${quote.terms_hash}`,
        BigInt(expiry),
      ],
    });
  } else if (action === "deliver") {
    if (
      o.payment !== "funded" ||
      o.work !== "checking" ||
      !o.manifest_hash ||
      !bytes32(`0x${o.manifest_hash}`) ||
      !o.delivery_due ||
      !(Date.parse(o.delivery_due) > clock)
    )
      throw new Error(
        "A checked manifest, verified funding and unexpired delivery deadline are required.",
      );
    data = encodeFunctionData({
      abi,
      functionName: "submitDelivery",
      args: [job, `0x${o.manifest_hash}`],
    });
  } else if (action === "release") {
    if (
      o.payment !== "funded" ||
      o.work !== "delivered" ||
      !o.review_due ||
      !(Date.parse(o.review_due) <= clock)
    )
      throw new Error(
        "The funded delivery review deadline has not been reached.",
      );
    data = encodeFunctionData({
      abi,
      functionName: "claimReviewRelease",
      args: [job],
    });
  } else {
    if (o.payment !== "funded" || o.work === "closed")
      throw new Error("Only funded, unsettled work may be refunded.");
    data = encodeFunctionData({ abi, functionName: "refundJob", args: [job] });
  }
  return {
    unsigned: true,
    requiresExplicitUserAuthorization: true,
    chainId: 1990,
    from: settings.operator,
    to: settings.escrow,
    value: "0",
    action,
    orderId: o.id,
    data,
  };
}
