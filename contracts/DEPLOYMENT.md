# Forma ServiceEscrow — QIE Mainnet

Deployed November 24, 2026, after the owner's explicit authorization with a 0.0031 QIE maximum fee.

| Field | Value |
| --- | --- |
| Chain | QIE Mainnet, chain ID 1990 |
| Contract | `0xbf0bd3c5231872006ecbf3557e7aa730ec797032` |
| Deployment transaction | `0x5e69423462806fa2051372fdf188c87c8b85a656b7a8f6cf6145283a115a417e` |
| Block | 12142771 |
| Deployer / treasury / operator | `0xC137afa61B212D1492ad70B34b614aD7Aab9A873` |
| Asset | QUSDC, `0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5`, six decimals |
| Compiler | `0.8.39+commit.ce47f2c8` |
| Settings | Shanghai EVM, optimizer enabled, 200 runs |
| Standard input SHA-256 | `acb800af3c382860e065e2b84eaa22ac3138e819a6d9dc5b87b4aa3bd2ae4694` |
| Gas used | 1,067,437 |
| Actual deployment fee | 0.001200866625 QIE |

[Contract explorer](https://mainnet.qie.digital/address/0xbf0bd3c5231872006ecbf3557e7aa730ec797032?tab=contract) · [Deployment receipt](https://mainnet.qie.digital/tx/0x5e69423462806fa2051372fdf188c87c8b85a656b7a8f6cf6145283a115a417e)

The receipt succeeded with at least three canonical confirmations. The deployed runtime matches the compiled artifact after masking compiler-declared immutable slots. Separate on-chain reads confirm the asset, treasury and operator; initial liabilities are zero. QIE omitted `effectiveGasPrice` in its receipt, so the fee was calculated from gas used and the legacy transaction's fixed gas price.

After separate owner approval to publish source, the QIE explorer verified ServiceEscrow with compiler `v0.8.39+commit.ce47f2c8`. Its published primary source matches the local source. Source verification and bytecode matching are not an independent audit. The original deployment approval covered deployment alone. Separately authorized payment/delivery/acceptance verification and public app cutover have since completed; operational spending remains bounded by configured approval policies.

Private deployment evidence and standard JSON build input are in ignored `.forma/contracts/`. The private key remains in ignored `.env`, and must never be included in source verification, repository publication or screenshots.

`scripts/contract-deploy.ts` refuses a second run when a deployment record exists. `scripts/contract-confirm.ts` reconciles that existing transaction with read-only RPC calls. Never delete the deployment record to retry an ambiguous broadcast.
