import { Address, dataSource, log } from "@graphprotocol/graph-ts";
import { Network, ZERO_ADDRESS } from "../../../src/constants";

//////////////////////////////
///// Ethereum Addresses /////
//////////////////////////////

export const USDC_TOKEN_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // ETH
export const USDC_POS_TOKEN_ADDRESS =
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"; // Polygon

/////////////////////////////
///// Protocol Specific /////
/////////////////////////////

export namespace Protocol {
  export const NAME = "Aave v2";
  export const SLUG = "aave-v2";
  export const SCHEMA_VERSION = "2.0.1";
  export const SUBGRAPH_VERSION = "1.2.15";
  export const METHODOLOGY_VERSION = "1.0.0";
}
export const AAVE_DECIMALS = 8;

////////////////////////////
///// Network Specific /////
////////////////////////////

export const AMM_ADDRESS = Address.fromString(
  "0xAcc030EF66f9dFEAE9CbB0cd1B25654b82cFA8d5"
);

export class NetworkSpecificConstant {
  constructor(
    public readonly protocolAddress: Address, // aka, LendingPoolAddressesProvider
    public readonly network: string
  ) {}
}

// TODO- figure out how to get different mainnet deployments to work (ie, arc, rwa, eth amm, eth)
export function getNetworkSpecificConstant(): NetworkSpecificConstant {
  const network = dataSource.network();
  if (equalsIgnoreCase(network, Network.MAINNET)) {
    return new NetworkSpecificConstant(
      Address.fromString("0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5"),
      Network.MAINNET
    );
  } else if (equalsIgnoreCase(network, Network.AVALANCHE)) {
    return new NetworkSpecificConstant(
      Address.fromString("0xb6A86025F0FE1862B372cb0ca18CE3EDe02A318f"),
      Network.AVALANCHE
    );
  } else if (equalsIgnoreCase(network, Network.MATIC)) {
    return new NetworkSpecificConstant(
      Address.fromString("0xd05e3E715d945B59290df0ae8eF85c1BdB684744"),
      Network.MATIC
    );
  } else {
    log.error("[getNetworkSpecificConstant] Unsupported network: {}", [
      network,
    ]);
    return new NetworkSpecificConstant(Address.fromString(ZERO_ADDRESS), "");
  }
}

export function equalsIgnoreCase(a: string, b: string): boolean {
  return a.replace("-", "_").toLowerCase() == b.replace("-", "_").toLowerCase();
}
