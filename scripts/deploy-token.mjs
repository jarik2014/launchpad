#!/usr/bin/env node
/**
 * Launch one token through the factory.
 *
 * This is a single atomic `deploy_token` call: the factory creates the contract
 * and initializes it in the same invocation, so a launch either fully happens
 * or does not happen at all. It replaces the old build-upload-deploy-initialize
 * sequence, which could leave a deployed-but-uninitialized token behind if the
 * second transaction failed.
 *
 *   node scripts/deploy-token.mjs --network testnet --source alice \
 *     --name "My Token" --symbol MTK --supply 1000000
 *
 * Requires a factory: run scripts/bootstrap-network.mjs first.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `
Usage:
  node scripts/deploy-token.mjs --network testnet --source <identity> \\
    --name "My Token" --symbol MTK --supply 1000000

Flags:
  --network      Network to launch on                              [required]
  --source       stellar-cli identity or secret key                [required]
  --name         Token name                                        [required]
  --symbol       Token symbol                                      [required]
  --supply       Initial supply, in whole tokens (e.g. 1000000)    [required]
  --factory      Factory address (default: read from .env.local)   [optional]
  --admin        Token admin (default: --source's address)         [optional]
  --max-supply   Hard cap, in whole tokens                         [optional]
  --decimals     Decimal precision (default: 7, max 18)            [optional]
  --compliance-node  Compliance contract address                   [optional]
  --auth-required    Holders must be authorized before receiving   [optional]
  --auth-revocable   Admin may revoke holder authorization         [optional]
  --fee-bps      Transfer fee in basis points (0-1000)             [required]
  --fee-recipient  Fee recipient address                           [required]
`.trim();

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { args[key] = next; i++; } else { args[key] = true; }
  }
  return args;
}

/**
 * Scale a decimal string into base units with integer arithmetic.
 *
 * Mirrors toBaseUnits in frontend/lib/utils.ts. Deliberately never touches
 * Number: 1e7 * 0.1 is not 1000000 in floating point, and this is the amount
 * that becomes someone's balance.
 */
function toBaseUnits(display, decimals) {
  const text = String(display).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`"${display}" is not a positive decimal number`);
  }
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    throw new Error(`"${display}" has ${fraction.length} decimal places but the token supports ${decimals}`);
  }
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

function readFactoryFromEnv(network) {
  for (const file of ["frontend/.env.local", ".env.local", "frontend/.env"]) {
    let text;
    try { text = readFileSync(resolve(ROOT, file), "utf-8"); } catch { continue; }
    for (const key of [`NEXT_PUBLIC_FACTORY_ADDRESS_${network.toUpperCase()}`,
                       "NEXT_PUBLIC_FACTORY_ADDRESS"]) {
      const hit = text.match(new RegExp(`^${key}=(.+)$`, "m"));
      if (hit && hit[1].trim()) return hit[1].trim();
    }
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }

  for (const flag of ["network", "source", "name", "symbol", "supply", "fee-bps", "fee-recipient"]) {
    if (typeof args[flag] !== "string") {
      console.error(`Error: --${flag} is required.\n\n${USAGE}`);
      process.exit(1);
    }
  }

  const { network, source, name, symbol } = args;
  const decimals = Number(args.decimals ?? 7);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    console.error("Error: --decimals must be an integer between 0 and 18.");
    process.exit(1);
  }
  // Validate fee-bps
  const feeBps = Number(args["fee-bps"]);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) {
    console.error("Error: --fee-bps must be an integer between 0 and 1000.");
    process.exit(1);
  }

  // Validate fee-recipient
  const feeRecipient = args["fee-recipient"];
  if (!/^G[A-Z2-7]{55}$/.test(feeRecipient)) {
    console.error("Error: --fee-recipient must be a valid Stellar address.");
    process.exit(1);
  }
  const factory = (typeof args.factory === "string" && args.factory) || readFactoryFromEnv(network);
  if (!factory) {
    console.error(
      `Error: no factory configured for ${network}.\n` +
      `Pass --factory C..., or set NEXT_PUBLIC_FACTORY_ADDRESS_${network.toUpperCase()} in frontend/.env.local.\n` +
      `Deploy one with: node scripts/bootstrap-network.mjs --network ${network} --source ${source}`);
    process.exit(1);
  }

  let initialSupply, maxSupply = null;
  try {
    initialSupply = toBaseUnits(args.supply, decimals);
    if (typeof args["max-supply"] === "string") {
      maxSupply = toBaseUnits(args["max-supply"], decimals);
      if (maxSupply < initialSupply) {
        console.error("Error: --max-supply must be >= --supply.");
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const complianceNode = typeof args["compliance-node"] === "string" ? args["compliance-node"] : null;
  if (complianceNode && !/^C[A-Z2-7]{55}$/.test(complianceNode)) {
    console.error("Error: --compliance-node must be a valid contract address.");
    process.exit(1);
  }

  const deployer = execFileSync("stellar", ["keys", "address", source],
                                { cwd: ROOT, encoding: "utf-8" }).trim();
  const admin = typeof args.admin === "string" ? args.admin : deployer;

  const config = {
    admin,
    authorization_required: args["auth-required"] === true,
    authorization_revocable: args["auth-revocable"] === true,
    compliance_node: complianceNode,
    decimal: decimals,
    initial_supply: initialSupply.toString(),
    max_supply: maxSupply === null ? null : maxSupply.toString(),
    name,
    symbol,
    fee_bps: feeBps,
    fee_recipient: feeRecipient,
  };

  console.log(`\nLaunching ${name} (${symbol}) on ${network} via factory ${factory}\n`);
  const out = execFileSync("stellar", [
    "contract", "invoke", "--id", factory, "--source", source, "--network", network,
    "--", "deploy_token",
    "--deployer", deployer,
    "--salt", randomBytes(32).toString("hex"),
    "--config", JSON.stringify(config),
  ], { cwd: ROOT, encoding: "utf-8" });

  const contractId = out.trim().split("\n").pop().replaceAll('"', "");
  console.log(`
=== Launched ===

Contract:  ${contractId}
Token:     ${name} (${symbol})
Decimals:  ${decimals}
Supply:    ${args.supply} (${initialSupply} base units)${maxSupply === null ? "" : `
Max:       ${args["max-supply"]} (${maxSupply} base units)`}
Admin:     ${admin}

Explorer:  https://stellar.expert/explorer/${network}/contract/${contractId}
Dashboard: /dashboard/${contractId}
`);
}

main();
