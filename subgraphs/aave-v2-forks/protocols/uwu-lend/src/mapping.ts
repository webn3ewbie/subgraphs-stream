import { Address, BigDecimal, BigInt, log } from "@graphprotocol/graph-ts";
import { PriceOracleUpdated } from "../../../generated/LendingPoolAddressesProvider/LendingPoolAddressesProvider";
import {
  getNetworkSpecificConstant,
  Protocol,
  UWU_DECIMALS,
  UWU_TOKEN_ADDRESS,
  UWU_WETH_LP,
  WETH_TOKEN_ADDRESS,
} from "./constants";
import {
  BorrowingDisabledOnReserve,
  BorrowingEnabledOnReserve,
  CollateralConfigurationChanged,
  ReserveActivated,
  ReserveDeactivated,
  ReserveFactorChanged,
  ReserveInitialized,
} from "../../../generated/LendingPoolConfigurator/LendingPoolConfigurator";
import {
  Borrow,
  Deposit,
  LiquidationCall,
  Paused,
  Repay,
  ReserveDataUpdated,
  ReserveUsedAsCollateralDisabled,
  ReserveUsedAsCollateralEnabled,
  Unpaused,
  Withdraw,
} from "../../../generated/LendingPool/LendingPool";
import { AToken } from "../../../generated/LendingPool/AToken";
import {
  ProtocolData,
  _handleBorrow,
  _handleBorrowingDisabledOnReserve,
  _handleBorrowingEnabledOnReserve,
  _handleCollateralConfigurationChanged,
  _handleDeposit,
  _handleLiquidate,
  _handlePaused,
  _handlePriceOracleUpdated,
  _handleRepay,
  _handleReserveActivated,
  _handleReserveDataUpdated,
  _handleReserveDeactivated,
  _handleReserveFactorChanged,
  _handleReserveInitialized,
  _handleReserveUsedAsCollateralDisabled,
  _handleReserveUsedAsCollateralEnabled,
  _handleTransfer,
  _handleUnpaused,
  _handleWithdraw,
} from "../../../src/mapping";
import {
  getOrCreateLendingProtocol,
  getOrCreateRewardToken,
  getOrCreateToken,
} from "../../../src/helpers";
import {
  BIGDECIMAL_ZERO,
  BIGINT_ZERO,
  exponentToBigDecimal,
  readValue,
  RewardTokenType,
  SECONDS_PER_DAY,
} from "../../../src/constants";
import { Market } from "../../../generated/schema";
import { ChefIncentivesController } from "../../../generated/LendingPool/ChefIncentivesController";
import { SushiSwapLP } from "../../../generated/LendingPool/SushiSwapLP";
import { IPriceOracleGetter } from "../../../generated/LendingPool/IPriceOracleGetter";
import { Transfer } from "../../../generated/templates/AToken/AToken";

function getProtocolData(): ProtocolData {
  const constants = getNetworkSpecificConstant();
  return new ProtocolData(
    constants.protocolAddress.toHexString(),
    Protocol.NAME,
    Protocol.SLUG,
    Protocol.SCHEMA_VERSION,
    Protocol.SUBGRAPH_VERSION,
    Protocol.METHODOLOGY_VERSION,
    constants.network
  );
}

///////////////////////////////////////////////
///// LendingPoolAddressProvider Handlers /////
///////////////////////////////////////////////

export function handlePriceOracleUpdated(event: PriceOracleUpdated): void {
  _handlePriceOracleUpdated(event.params.newAddress, getProtocolData());
}

//////////////////////////////////////
///// Lending Pool Configuration /////
//////////////////////////////////////

export function handleReserveInitialized(event: ReserveInitialized): void {
  // This function handles market entity from reserve creation event
  // Attempt to load or create the market implementation

  _handleReserveInitialized(
    event,
    event.params.asset,
    event.params.aToken,
    event.params.variableDebtToken,
    getProtocolData(),
    event.params.stableDebtToken
  );
}

export function handleCollateralConfigurationChanged(
  event: CollateralConfigurationChanged
): void {
  _handleCollateralConfigurationChanged(
    event.params.asset,
    event.params.liquidationBonus,
    event.params.liquidationThreshold,
    event.params.ltv,
    getProtocolData()
  );
}

export function handleBorrowingEnabledOnReserve(
  event: BorrowingEnabledOnReserve
): void {
  _handleBorrowingEnabledOnReserve(event.params.asset, getProtocolData());
}

export function handleBorrowingDisabledOnReserve(
  event: BorrowingDisabledOnReserve
): void {
  _handleBorrowingDisabledOnReserve(event.params.asset, getProtocolData());
}

export function handleReserveActivated(event: ReserveActivated): void {
  _handleReserveActivated(event.params.asset, getProtocolData());
}

export function handleReserveDeactivated(event: ReserveDeactivated): void {
  _handleReserveDeactivated(event.params.asset, getProtocolData());
}

export function handleReserveFactorChanged(event: ReserveFactorChanged): void {
  _handleReserveFactorChanged(
    event.params.asset,
    event.params.factor,
    getProtocolData()
  );
}

/////////////////////////////////
///// Lending Pool Handlers /////
/////////////////////////////////

export function handleReserveDataUpdated(event: ReserveDataUpdated): void {
  const protocolData = getProtocolData();
  const protocol = getOrCreateLendingProtocol(protocolData);

  // update rewards if there is an incentive controller
  const market = Market.load(event.params.reserve.toHexString());
  if (!market) {
    log.warning("[handleReserveDataUpdated] Market not found", [
      event.params.reserve.toHexString(),
    ]);
    return;
  }

  // Get UWU rewards for the given pool
  const aTokenContract = AToken.bind(Address.fromString(market.outputToken!));
  const tryIncentiveController = aTokenContract.try_getIncentivesController();
  if (!tryIncentiveController.reverted) {
    let rewardTokens: string[] = [];
    let rewardEmissionsAmount = [BIGINT_ZERO, BIGINT_ZERO];
    let rewardEmissionsUSD = [BIGDECIMAL_ZERO, BIGDECIMAL_ZERO];

    const incentiveControllerContract = ChefIncentivesController.bind(
      tryIncentiveController.value
    );
    const tryPoolInfo = incentiveControllerContract.try_poolInfo(
      Address.fromString(market.outputToken!)
    );
    const tryAllocPoints = incentiveControllerContract.try_totalAllocPoint();
    const tryRewardsPerSecond =
      incentiveControllerContract.try_rewardsPerSecond();

    if (
      !tryPoolInfo.reverted &&
      !tryAllocPoints.reverted &&
      !tryRewardsPerSecond.reverted
    ) {
      // create reward toke if it does not exist
      if (market.rewardTokens == null || market.rewardTokens!.length != 2) {
        const depositRewardToken = getOrCreateRewardToken(
          Address.fromString(UWU_TOKEN_ADDRESS),
          RewardTokenType.DEPOSIT
        );
        const borrowRewardToken = getOrCreateRewardToken(
          Address.fromString(UWU_TOKEN_ADDRESS),
          RewardTokenType.BORROW
        );
        rewardTokens = [borrowRewardToken.id, depositRewardToken.id]; // borrow first bc alphabetized
      }

      const uwuToken = getOrCreateToken(Address.fromString(UWU_TOKEN_ADDRESS));
      const poolAllocPoints = tryPoolInfo.value.value1;

      // calculate rewards per pool
      // depositRewards = rewardsPerSecond * poolAllocPoints / totalAllocPoints
      // TODO: figure out borrow rewards
      const uwuPerPoolPerDay = tryRewardsPerSecond.value
        .times(BigInt.fromI32(SECONDS_PER_DAY))
        .toBigDecimal()
        .div(exponentToBigDecimal(uwuToken.decimals))
        .times(
          poolAllocPoints
            .toBigDecimal()
            .div(tryAllocPoints.value.toBigDecimal())
        );
      const uwuPerPoolBI = BigInt.fromString(
        uwuPerPoolPerDay
          .times(exponentToBigDecimal(uwuToken.decimals))
          .truncate(0)
          .toString()
      );

      const uwuPriceUSD = getUwuPriceUSD();
      rewardEmissionsAmount = [uwuPerPoolBI, uwuPerPoolBI];
      rewardEmissionsUSD = [
        uwuPerPoolPerDay.times(uwuPriceUSD),
        uwuPerPoolPerDay.times(uwuPriceUSD),
      ];
    }

    market.rewardTokens = rewardTokens;
    market.rewardTokenEmissionsAmount = rewardEmissionsAmount;
    market.rewardTokenEmissionsUSD = rewardEmissionsUSD;
    market.save();
  }

  const assetPriceUSD = getAssetPriceInUSDC(
    Address.fromString(market.inputToken),
    Address.fromString(protocol.priceOracle)
  );

  _handleReserveDataUpdated(
    event,
    event.params.liquidityRate,
    event.params.liquidityIndex,
    event.params.variableBorrowRate,
    event.params.stableBorrowRate,
    protocolData,
    event.params.reserve,
    assetPriceUSD
  );
}

export function handleReserveUsedAsCollateralEnabled(
  event: ReserveUsedAsCollateralEnabled
): void {
  // This Event handler enables a reserve/market to be used as collateral
  _handleReserveUsedAsCollateralEnabled(
    event.params.reserve,
    event.params.user,
    getProtocolData()
  );
}

export function handleReserveUsedAsCollateralDisabled(
  event: ReserveUsedAsCollateralDisabled
): void {
  // This Event handler disables a reserve/market being used as collateral
  _handleReserveUsedAsCollateralDisabled(
    event.params.reserve,
    event.params.user,
    getProtocolData()
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function handlePaused(event: Paused): void {
  _handlePaused(getProtocolData());
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function handleUnpaused(event: Unpaused): void {
  _handleUnpaused(getProtocolData());
}

export function handleDeposit(event: Deposit): void {
  _handleDeposit(
    event,
    event.params.amount,
    event.params.reserve,
    getProtocolData(),
    event.params.onBehalfOf
  );
}

export function handleWithdraw(event: Withdraw): void {
  _handleWithdraw(
    event,
    event.params.amount,
    event.params.reserve,
    getProtocolData(),
    event.params.to
  );
}

export function handleBorrow(event: Borrow): void {
  _handleBorrow(
    event,
    event.params.amount,
    event.params.reserve,
    getProtocolData(),
    event.params.onBehalfOf
  );
}

export function handleRepay(event: Repay): void {
  _handleRepay(
    event,
    event.params.amount,
    event.params.reserve,
    getProtocolData(),
    event.params.user
  );
}

export function handleLiquidationCall(event: LiquidationCall): void {
  _handleLiquidate(
    event,
    event.params.liquidatedCollateralAmount,
    event.params.collateralAsset,
    getProtocolData(),
    event.params.liquidator,
    event.params.user,
    event.params.debtAsset
  );
}

//////////////////////
//// UToken Event ////
//////////////////////

export function handleTransfer(event: Transfer): void {
  _handleTransfer(event, event.params.to, event.params.from, getProtocolData());
}

///////////////////
///// Helpers /////
///////////////////

function getAssetPriceInUSDC(
  tokenAddress: Address,
  priceOracle: Address
): BigDecimal {
  const oracle = IPriceOracleGetter.bind(priceOracle);
  let oracleResult = readValue<BigInt>(
    oracle.try_getAssetPrice(tokenAddress),
    BIGINT_ZERO
  );

  // if the result is zero or less, try the fallback oracle
  if (!oracleResult.gt(BIGINT_ZERO)) {
    const tryFallback = oracle.try_getFallbackOracle();
    if (tryFallback) {
      const fallbackOracle = IPriceOracleGetter.bind(tryFallback.value);
      oracleResult = readValue<BigInt>(
        fallbackOracle.try_getAssetPrice(tokenAddress),
        BIGINT_ZERO
      );
    }
  }

  return oracleResult.toBigDecimal().div(exponentToBigDecimal(UWU_DECIMALS));
}

//
// get UWU price based off WETH price
function getUwuPriceUSD(): BigDecimal {
  const sushiContract = SushiSwapLP.bind(Address.fromString(UWU_WETH_LP));
  const tryReserves = sushiContract.try_getReserves();
  if (tryReserves.reverted) {
    log.warning("[getUwuPriceUSD] failed to get reserves for UWU-WETH LP", []);
    return BIGDECIMAL_ZERO;
  }

  const uwuReserveBalance = tryReserves.value.value0;
  const wethReserveBalance = tryReserves.value.value1;

  if (
    uwuReserveBalance.equals(BIGINT_ZERO) ||
    wethReserveBalance.equals(BIGINT_ZERO)
  ) {
    log.warning("[getUwuPriceUSD] UWU or WETH reserve balance is zero", []);
    return BIGDECIMAL_ZERO;
  }

  // get WETH price in USD
  const protocol = getOrCreateLendingProtocol(getProtocolData());
  const wethPriceUSD = getAssetPriceInUSDC(
    Address.fromString(WETH_TOKEN_ADDRESS),
    Address.fromString(protocol.priceOracle)
  );

  const uwuPriceUSD = wethPriceUSD.div(
    uwuReserveBalance.toBigDecimal().div(wethReserveBalance.toBigDecimal())
  );
  return uwuPriceUSD;
}
