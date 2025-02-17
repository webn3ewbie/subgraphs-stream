import { Address, BigInt, Bytes, ethereum, log } from "@graphprotocol/graph-ts";
import {
  RoyaltyPayment,
  TakerAsk,
  TakerBid,
} from "../generated/LooksRareExchange/LooksRareExchange";
import { ExecutionStrategy } from "../generated/LooksRareExchange/ExecutionStrategy";
import { ERC165 } from "../generated/LooksRareExchange/ERC165";
import { NftMetadata } from "../generated/LooksRareExchange/NftMetadata";
import { RoyaltyFeeUpdate } from "../generated/RoyaltyFeeRegistry/RoyaltyFeeRegistry";
import {
  Collection,
  CollectionDailySnapshot,
  Marketplace,
  MarketplaceDailySnapshot,
  Trade,
  _Item,
  _ExecutionStrategy,
} from "../generated/schema";
import {
  BIGDECIMAL_HUNDRED,
  BIGDECIMAL_MAX,
  BIGDECIMAL_ZERO,
  BIGINT_ZERO,
  ERC1155_INTERFACE_IDENTIFIER,
  ERC721_INTERFACE_IDENTIFIER,
  MANTISSA_FACTOR,
  max,
  min,
  NftStandard,
  SaleStrategy,
  SECONDS_PER_DAY,
  STRATEGY_ANY_ITEM_FROM_COLLECTION_ADDRESSES,
  STRATEGY_PRIVATE_SALE_ADDRESSES,
  STRATEGY_STANDARD_SALE_ADDRESSES,
  WETH_ADDRESS,
} from "./helper";
import { NetworkConfigs } from "../configurations/configure";

export function handleTakerBid(event: TakerBid): void {
  if (event.params.currency != WETH_ADDRESS) {
    return;
  }
  handleMatch(
    event,
    event.params.maker.toHexString(),
    event.params.taker.toHexString(),
    event.params.strategy.toHexString(),
    event.params.collection.toHexString(),
    event.params.tokenId,
    event.params.price,
    event.params.amount
  );
}

export function handleTakerAsk(event: TakerAsk): void {
  if (event.params.currency != WETH_ADDRESS) {
    return;
  }
  handleMatch(
    event,
    event.params.taker.toHexString(),
    event.params.maker.toHexString(),
    event.params.strategy.toHexString(),
    event.params.collection.toHexString(),
    event.params.tokenId,
    event.params.price,
    event.params.amount
  );
}

export function handleRoyaltyPayment(event: RoyaltyPayment): void {
  if (event.params.currency != WETH_ADDRESS) {
    return;
  }
  const collection = getOrCreateCollection(
    event.params.collection.toHexString()
  );
  const deltaCreatorRevenueETH = event.params.amount
    .toBigDecimal()
    .div(MANTISSA_FACTOR);
  collection.creatorRevenueETH = collection.creatorRevenueETH.plus(
    deltaCreatorRevenueETH
  );
  collection.totalRevenueETH = collection.totalRevenueETH.plus(
    deltaCreatorRevenueETH
  );
  collection.save();

  const marketplace = getOrCreateMarketplace(
    NetworkConfigs.getMarketplaceAddress()
  );
  marketplace.creatorRevenueETH = marketplace.creatorRevenueETH.plus(
    deltaCreatorRevenueETH
  );
  marketplace.totalRevenueETH = marketplace.totalRevenueETH.plus(
    deltaCreatorRevenueETH
  );
  marketplace.save();
}

export function handleRoyaltyFeeUpdate(event: RoyaltyFeeUpdate): void {
  const collection = getOrCreateCollection(
    event.params.collection.toHexString()
  );
  collection.royaltyFee = event.params.fee
    .toBigDecimal()
    .div(BIGDECIMAL_HUNDRED);
  collection.save();
}

function handleMatch(
  event: ethereum.Event,
  seller: string,
  buyer: string,
  strategyAddr: string,
  collectionAddr: string,
  tokenId: BigInt,
  price: BigInt,
  amount: BigInt
): void {
  const priceETH = price.toBigDecimal().div(MANTISSA_FACTOR);
  const volumeETH = amount.toBigDecimal().times(priceETH);
  const strategy = getOrCreateExecutionStrategy(
    Address.fromString(strategyAddr)
  );

  //
  // new trade
  //
  const trade = new Trade(
    event.transaction.hash
      .toHexString()
      .concat("-")
      .concat(event.logIndex.toString())
  );
  trade.transactionHash = event.transaction.hash.toHexString();
  trade.logIndex = event.logIndex.toI32();
  trade.timestamp = event.block.timestamp;
  trade.blockNumber = event.block.number;
  trade.isBundle = false;
  trade.collection = collectionAddr;
  trade.tokenId = tokenId;
  trade.priceETH = priceETH;
  trade.amount = amount;
  trade.strategy = strategy.saleStrategy;
  trade.buyer = buyer;
  trade.seller = seller;
  trade.save();

  //
  // update collection
  //
  const collection = getOrCreateCollection(collectionAddr);
  collection.tradeCount += 1;
  const buyerCollectionAccountID = "COLLECTION_ACCOUNT-BUYER-"
    .concat(collection.id)
    .concat("-")
    .concat(buyer);
  let buyerCollectionAccount = _Item.load(buyerCollectionAccountID);
  if (!buyerCollectionAccount) {
    buyerCollectionAccount = new _Item(buyerCollectionAccountID);
    buyerCollectionAccount.save();
    collection.buyerCount += 1;
  }
  const sellerCollectionAccountID = "COLLECTION_ACCOUNT-SELLER-"
    .concat(collection.id)
    .concat("-")
    .concat(seller);
  let sellerCollectionAccount = _Item.load(sellerCollectionAccountID);
  if (!sellerCollectionAccount) {
    sellerCollectionAccount = new _Item(sellerCollectionAccountID);
    sellerCollectionAccount.save();
    collection.sellerCount += 1;
  }
  collection.cumulativeTradeVolumeETH =
    collection.cumulativeTradeVolumeETH.plus(volumeETH);
  const deltaMarketplaceRevenueETH = volumeETH.times(
    strategy.protocolFee.div(BIGDECIMAL_HUNDRED)
  );
  collection.marketplaceRevenueETH = collection.marketplaceRevenueETH.plus(
    deltaMarketplaceRevenueETH
  );
  collection.totalRevenueETH = collection.totalRevenueETH.plus(
    deltaMarketplaceRevenueETH
  );
  collection.save();

  //
  // update marketplace
  //
  const marketplace = getOrCreateMarketplace(
    NetworkConfigs.getMarketplaceAddress()
  );
  marketplace.tradeCount += 1;
  marketplace.cumulativeTradeVolumeETH =
    marketplace.cumulativeTradeVolumeETH.plus(volumeETH);
  marketplace.marketplaceRevenueETH = marketplace.marketplaceRevenueETH.plus(
    deltaMarketplaceRevenueETH
  );
  marketplace.totalRevenueETH = marketplace.totalRevenueETH.plus(
    deltaMarketplaceRevenueETH
  );
  const buyerAccountID = "MARKETPLACE_ACCOUNT-".concat(buyer);
  let buyerAccount = _Item.load(buyerAccountID);
  if (!buyerAccount) {
    buyerAccount = new _Item(buyerAccountID);
    buyerAccount.save();
    marketplace.cumulativeUniqueTraders += 1;
  }
  const sellerAccountID = "MARKETPLACE_ACCOUNT-".concat(seller);
  let sellerAccount = _Item.load(sellerAccountID);
  if (!sellerAccount) {
    sellerAccount = new _Item(sellerAccountID);
    sellerAccount.save();
    marketplace.cumulativeUniqueTraders += 1;
  }
  marketplace.save();

  // prepare for updating dailyTradedItemCount
  let newDailyTradedItem = false;
  const dailyTradedItemID = "DAILY_TRADED_ITEM-"
    .concat(collectionAddr)
    .concat("-")
    .concat(tokenId.toString())
    .concat("-")
    .concat((event.block.timestamp.toI32() / SECONDS_PER_DAY).toString());
  let dailyTradedItem = _Item.load(dailyTradedItemID);
  if (!dailyTradedItem) {
    dailyTradedItem = new _Item(dailyTradedItemID);
    dailyTradedItem.save();
    newDailyTradedItem = true;
  }
  //
  // take collection snapshot
  //
  const collectionSnapshot = getOrCreateCollectionDailySnapshot(
    collectionAddr,
    event.block.timestamp
  );
  collectionSnapshot.blockNumber = event.block.number;
  collectionSnapshot.timestamp = event.block.timestamp;
  collectionSnapshot.royaltyFee = collection.royaltyFee;
  collectionSnapshot.dailyMinSalePrice = min(
    collectionSnapshot.dailyMinSalePrice,
    priceETH
  );
  collectionSnapshot.dailyMaxSalePrice = max(
    collectionSnapshot.dailyMaxSalePrice,
    priceETH
  );
  collectionSnapshot.cumulativeTradeVolumeETH =
    collection.cumulativeTradeVolumeETH;
  collectionSnapshot.marketplaceRevenueETH = collection.marketplaceRevenueETH;
  collectionSnapshot.creatorRevenueETH = collection.creatorRevenueETH;
  collectionSnapshot.totalRevenueETH = collection.totalRevenueETH;
  collectionSnapshot.tradeCount = collection.tradeCount;
  collectionSnapshot.dailyTradeVolumeETH =
    collectionSnapshot.dailyTradeVolumeETH.plus(volumeETH);
  if (newDailyTradedItem) {
    collectionSnapshot.dailyTradedItemCount += 1;
  }
  collectionSnapshot.save();

  //
  // take marketplace snapshot
  //
  const marketplaceSnapshot = getOrCreateMarketplaceDailySnapshot(
    event.block.timestamp
  );
  marketplaceSnapshot.blockNumber = event.block.number;
  marketplaceSnapshot.timestamp = event.block.timestamp;
  marketplaceSnapshot.collectionCount = marketplace.collectionCount;
  marketplaceSnapshot.cumulativeTradeVolumeETH =
    marketplace.cumulativeTradeVolumeETH;
  marketplaceSnapshot.marketplaceRevenueETH = marketplace.marketplaceRevenueETH;
  marketplaceSnapshot.creatorRevenueETH = marketplace.creatorRevenueETH;
  marketplaceSnapshot.totalRevenueETH = marketplace.totalRevenueETH;
  marketplaceSnapshot.tradeCount = marketplace.tradeCount;
  marketplaceSnapshot.cumulativeUniqueTraders =
    marketplace.cumulativeUniqueTraders;
  const dailyBuyerID = "DAILY_MARKERPLACE_ACCOUNT-".concat(buyer);
  let dailyBuyer = _Item.load(dailyBuyerID);
  if (!dailyBuyer) {
    dailyBuyer = new _Item(dailyBuyerID);
    dailyBuyer.save();
    marketplaceSnapshot.dailyActiveTraders += 1;
  }
  const dailySellerID = "DAILY_MARKETPLACE_ACCOUNT-".concat(seller);
  let dailySeller = _Item.load(dailySellerID);
  if (!dailySeller) {
    dailySeller = new _Item(dailySellerID);
    dailySeller.save();
    marketplaceSnapshot.dailyActiveTraders += 1;
  }
  const dailyTradedCollectionID = "DAILY_TRADED_COLLECTION-"
    .concat(collectionAddr)
    .concat("-")
    .concat((event.block.timestamp.toI32() / SECONDS_PER_DAY).toString());
  let dailyTradedCollection = _Item.load(dailyTradedCollectionID);
  if (!dailyTradedCollection) {
    dailyTradedCollection = new _Item(dailyTradedCollectionID);
    dailyTradedCollection.save();
    marketplaceSnapshot.dailyTradedCollectionCount += 1;
  }
  if (newDailyTradedItem) {
    marketplaceSnapshot.dailyTradedItemCount += 1;
  }
  marketplaceSnapshot.save();
}

function getOrCreateCollection(collectionID: string): Collection {
  let collection = Collection.load(collectionID);
  if (!collection) {
    collection = new Collection(collectionID);
    collection.nftStandard = getNftStandard(collectionID);
    const contract = NftMetadata.bind(Address.fromString(collectionID));
    const nameResult = contract.try_name();
    if (!nameResult.reverted) {
      collection.name = nameResult.value;
    }
    const symbolResult = contract.try_symbol();
    if (!symbolResult.reverted) {
      collection.symbol = symbolResult.value;
    }
    const totalSupplyResult = contract.try_totalSupply();
    if (!totalSupplyResult.reverted) {
      collection.totalSupply = totalSupplyResult.value;
    }
    collection.royaltyFee = BIGDECIMAL_ZERO;
    collection.cumulativeTradeVolumeETH = BIGDECIMAL_ZERO;
    collection.marketplaceRevenueETH = BIGDECIMAL_ZERO;
    collection.creatorRevenueETH = BIGDECIMAL_ZERO;
    collection.totalRevenueETH = BIGDECIMAL_ZERO;
    collection.tradeCount = 0;
    collection.buyerCount = 0;
    collection.sellerCount = 0;
    collection.save();

    const marketplace = getOrCreateMarketplace(
      NetworkConfigs.getMarketplaceAddress()
    );
    marketplace.collectionCount += 1;
    marketplace.save();
  }
  return collection;
}

function getOrCreateMarketplace(marketplaceID: string): Marketplace {
  let marketplace = Marketplace.load(marketplaceID);
  if (!marketplace) {
    marketplace = new Marketplace(marketplaceID);
    marketplace.name = NetworkConfigs.getProtocolName();
    marketplace.slug = NetworkConfigs.getProtocolSlug();
    marketplace.network = NetworkConfigs.getNetwork();
    marketplace.schemaVersion = NetworkConfigs.getSchemaVersion();
    marketplace.subgraphVersion = NetworkConfigs.getSubgraphVersion();
    marketplace.methodologyVersion = NetworkConfigs.getMethodologyVersion();
    marketplace.collectionCount = 0;
    marketplace.tradeCount = 0;
    marketplace.cumulativeTradeVolumeETH = BIGDECIMAL_ZERO;
    marketplace.marketplaceRevenueETH = BIGDECIMAL_ZERO;
    marketplace.creatorRevenueETH = BIGDECIMAL_ZERO;
    marketplace.totalRevenueETH = BIGDECIMAL_ZERO;
    marketplace.cumulativeUniqueTraders = 0;
    marketplace.save();
  }
  return marketplace;
}

function getOrCreateExecutionStrategy(address: Address): _ExecutionStrategy {
  let strategy = _ExecutionStrategy.load(address.toHexString());
  if (!strategy) {
    strategy = new _ExecutionStrategy(address.toHexString());
    if (STRATEGY_STANDARD_SALE_ADDRESSES.includes(address)) {
      strategy.saleStrategy = SaleStrategy.STANDARD_SALE;
    } else if (STRATEGY_ANY_ITEM_FROM_COLLECTION_ADDRESSES.includes(address)) {
      strategy.saleStrategy = SaleStrategy.ANY_ITEM_FROM_COLLECTION;
    } else if (STRATEGY_PRIVATE_SALE_ADDRESSES.includes(address)) {
      strategy.saleStrategy = SaleStrategy.PRIVATE_SALE;
    }
    const contract = ExecutionStrategy.bind(address);
    strategy.protocolFee = contract
      .viewProtocolFee()
      .toBigDecimal()
      .div(BIGDECIMAL_HUNDRED);
    strategy.save();
  }
  return strategy;
}

function getOrCreateCollectionDailySnapshot(
  collection: string,
  timestamp: BigInt
): CollectionDailySnapshot {
  const snapshotID = collection
    .concat("-")
    .concat((timestamp.toI32() / SECONDS_PER_DAY).toString());
  let snapshot = CollectionDailySnapshot.load(snapshotID);
  if (!snapshot) {
    snapshot = new CollectionDailySnapshot(snapshotID);
    snapshot.collection = collection;
    snapshot.blockNumber = BIGINT_ZERO;
    snapshot.timestamp = BIGINT_ZERO;
    snapshot.royaltyFee = BIGDECIMAL_ZERO;
    snapshot.dailyMinSalePrice = BIGDECIMAL_MAX;
    snapshot.dailyMaxSalePrice = BIGDECIMAL_ZERO;
    snapshot.cumulativeTradeVolumeETH = BIGDECIMAL_ZERO;
    snapshot.dailyTradeVolumeETH = BIGDECIMAL_ZERO;
    snapshot.marketplaceRevenueETH = BIGDECIMAL_ZERO;
    snapshot.creatorRevenueETH = BIGDECIMAL_ZERO;
    snapshot.totalRevenueETH = BIGDECIMAL_ZERO;
    snapshot.tradeCount = 0;
    snapshot.dailyTradedItemCount = 0;
    snapshot.save();
  }
  return snapshot;
}

function getOrCreateMarketplaceDailySnapshot(
  timestamp: BigInt
): MarketplaceDailySnapshot {
  const snapshotID = (timestamp.toI32() / SECONDS_PER_DAY).toString();
  let snapshot = MarketplaceDailySnapshot.load(snapshotID);
  if (!snapshot) {
    snapshot = new MarketplaceDailySnapshot(snapshotID);
    snapshot.marketplace = NetworkConfigs.getMarketplaceAddress();
    snapshot.blockNumber = BIGINT_ZERO;
    snapshot.timestamp = BIGINT_ZERO;
    snapshot.collectionCount = 0;
    snapshot.cumulativeTradeVolumeETH = BIGDECIMAL_ZERO;
    snapshot.marketplaceRevenueETH = BIGDECIMAL_ZERO;
    snapshot.creatorRevenueETH = BIGDECIMAL_ZERO;
    snapshot.totalRevenueETH = BIGDECIMAL_ZERO;
    snapshot.tradeCount = 0;
    snapshot.cumulativeUniqueTraders = 0;
    snapshot.dailyTradedItemCount = 0;
    snapshot.dailyActiveTraders = 0;
    snapshot.dailyTradedCollectionCount = 0;
    snapshot.save();
  }
  return snapshot;
}

function getNftStandard(collectionID: string): string {
  const erc165 = ERC165.bind(Address.fromString(collectionID));

  const isERC721Result = erc165.try_supportsInterface(
    Bytes.fromHexString(ERC721_INTERFACE_IDENTIFIER)
  );
  if (isERC721Result.reverted) {
    log.warning("[getNftStandard] isERC721 reverted", []);
  } else {
    if (isERC721Result.value) {
      return NftStandard.ERC721;
    }
  }

  const isERC1155Result = erc165.try_supportsInterface(
    Bytes.fromHexString(ERC1155_INTERFACE_IDENTIFIER)
  );
  if (isERC1155Result.reverted) {
    log.warning("[getNftStandard] isERC1155 reverted", []);
  } else {
    if (isERC1155Result.value) {
      return NftStandard.ERC1155;
    }
  }

  return NftStandard.UNKNOWN;
}
