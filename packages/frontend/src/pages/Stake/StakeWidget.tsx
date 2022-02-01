import React, { FC, useState, useMemo } from 'react'
import { BigNumber, Contract } from 'ethers'
import { formatUnits } from 'ethers/lib/utils'
import { makeStyles } from '@material-ui/core/styles'
import { HopBridge, Token } from '@hop-protocol/sdk'
import { useApp } from 'src/contexts/AppContext'
import { useWeb3Context } from 'src/contexts/Web3Context'
import AmountSelectorCard from 'src/components/AmountSelectorCard'
import Button from 'src/components/buttons/Button'
import Network from 'src/models/Network'
import Transaction from 'src/models/Transaction'
import useStakeBalance from 'src/pages/Stake/useStakeBalance'
import { shiftBNDecimals, amountToBN, sanitizeNumericalString } from 'src/utils'
import Alert from 'src/components/alert/Alert'
import usePollValue from 'src/hooks/usePollValue'
import DetailRow from 'src/components/DetailRow'
import { useTransactionReplacement, useApprove, useAsyncMemo, useBalance } from 'src/hooks'
import { Div, Flex } from 'src/components/ui'
import { ButtonsWrapper } from 'src/components/buttons/ButtonsWrapper'
import { formatStakingValues } from './formatStakingValues'

const useStyles = makeStyles(theme => ({
  root: {
    marginBottom: '10.4rem',
  },
  buttons: {
    marginTop: theme.padding.default,
  },
  button: {
    width: '16rem',
  },
  claimButton: {
    marginTop: theme.padding.default,
  },
  alert: {
    marginTop: theme.padding.default,
  },
  withdrawButton: {
    marginTop: theme.padding.light,
  },
  rewardsDetails: {
    width: '30.0rem',
  },
  details: {
    marginTop: '4.2rem',
    width: '46.0rem',
    [theme.breakpoints.down('xs')]: {
      width: '100%',
    },
  },
}))

type Props = {
  network: Network | undefined
  bridge: HopBridge | undefined
  stakingToken: Token | undefined
  rewardsToken: Token | undefined
  stakingRewards: Contract | undefined
}

const TOTAL_AMOUNTS_DECIMALS = 18

const StakeWidget: FC<Props> = props => {
  const styles = useStyles()
  const { network, bridge, stakingToken, rewardsToken, stakingRewards } = props

  const { txConfirm, sdk } = useApp()
  const { checkConnectedNetworkId, address } = useWeb3Context()
  const { waitForTransaction, addTransaction } = useTransactionReplacement()
  const { stakeBalance } = useStakeBalance(stakingRewards, address)
  const { balance: lpBalance, loading: loadingLpBalance } = useBalance(
    stakingToken,
    network,
    address
  )
  const { balance: totalStaked } = useBalance(stakingToken, network, stakingRewards?.address)
  const { approve } = useApprove(stakingToken)

  const [amount, setAmount] = useState('')

  const parsedAmount =
    amount && stakingToken ? amountToBN(amount, stakingToken.decimals) : undefined

  function handleOnChangeAmount(value) {
    const amt = sanitizeNumericalString(value)
    setAmount(amt)
  }

  // Fetched prices

  const tokenUsdPrice = useAsyncMemo(async () => {
    try {
      if (!bridge?.signer) {
        return
      }
      const token = await bridge.getL1Token()
      return bridge.priceFeed.getPriceByTokenSymbol(token.symbol)
    } catch (err) {
      console.error(err)
    }
  }, [bridge])

  const rewardTokenUsdPrice = useAsyncMemo(async () => {
    try {
      if (!bridge?.signer) {
        return
      }
      const tokenSymbol = network?.slug === 'gnosis' ? 'GNO' : 'MATIC'
      return bridge.priceFeed.getPriceByTokenSymbol(tokenSymbol)
    } catch (err) {
      console.error(err)
    }
  }, [bridge, network?.slug])

  const earned = usePollValue<BigNumber>(
    async () => {
      if (!address) return undefined
      const _ern = await stakingRewards?.earned(address.toString())
      return _ern
    },
    5 * 1000,
    [stakingRewards, address]
  )

  const allowance = usePollValue(
    async () => {
      if (!(address && stakingRewards && stakingToken?.signer)) {
        return undefined
      }
      return stakingToken?.allowance(stakingRewards.address)
    },
    5 * 1000,
    [stakingToken, stakingRewards]
  )

  // Sync checks

  const needsApproval = useMemo(() => {
    if (!(address && allowance && parsedAmount)) {
      return undefined
    }
    return allowance.lt(parsedAmount)
  }, [allowance?.toString(), parsedAmount])

  const isStakeEnabled = useMemo(() => {
    if (!parsedAmount || !lpBalance) return false
    if (needsApproval) return false
    if (parsedAmount.gt(lpBalance)) return false
    return true
  }, [parsedAmount, lpBalance, needsApproval])

  const warning = useMemo(() => {
    if (!parsedAmount || !lpBalance) return undefined
    if (parsedAmount.gt(lpBalance)) {
      return 'Insufficient balance'
    }
  }, [parsedAmount, lpBalance])

  // Async checks

  const expireDate = useAsyncMemo(async () => {
    try {
      if (!stakingRewards) return undefined
      const timestamp = await stakingRewards?.periodFinish()
      return Number(timestamp.toString())
    } catch (err: any) {
      console.error(err)
    }
  }, [stakingRewards])

  const rewardsExpired = useMemo(() => {
    if (!expireDate) {
      return
    }
    const now = (Date.now() / 1000) | 0
    return now > expireDate
  }, [expireDate])

  const totalRewardsPerDay = useAsyncMemo(async () => {
    try {
      if (!(stakingRewards && rewardsExpired !== undefined)) {
        return
      }
      if (rewardsExpired) {
        return BigNumber.from('0')
      }
      const rewardRate = await stakingRewards?.rewardRate()
      return rewardRate.mul(86400) // multiply by 1 day
    } catch (err: any) {
      console.error(err)
    }
  }, [stakingRewards, rewardsExpired])

  const userRewardsPerDay = useAsyncMemo(async () => {
    try {
      if (
        !(
          stakingRewards &&
          stakeBalance &&
          totalStaked &&
          stakeBalance.gt(0) &&
          typeof rewardsExpired === 'boolean'
        )
      ) {
        return
      }
      if (rewardsExpired) {
        return 0
      }
      let rewardRate = await stakingRewards?.rewardRate()
      rewardRate = rewardRate.mul(86400) // multiply by 1 day
      rewardRate = rewardRate.mul(stakeBalance).div(totalStaked)
      return rewardRate
    } catch (err) {
      return ''
    }
  }, [stakingRewards, stakeBalance, totalStaked, rewardsExpired])

  // ((REWARD-TOKEN_PER_DAY * REWARD-TOKEN_PRICE)/((STAKED_USDC + STAKED_HUSDC)*STAKED_TOKEN_PRICE)) * DAYS_PER_YEAR
  const apr = useAsyncMemo(async () => {
    try {
      if (
        !(
          bridge &&
          network &&
          totalStaked &&
          totalRewardsPerDay &&
          rewardTokenUsdPrice &&
          tokenUsdPrice
        )
      ) {
        return
      }

      const rewardTokenUsdPriceBn = amountToBN(rewardTokenUsdPrice.toString(), 18)
      const tokenUsdPriceBn = amountToBN(tokenUsdPrice.toString(), 18)
      const token = await bridge.getCanonicalToken(network.slug)
      const amm = bridge.getAmm(network.slug)
      const stakedTotal = await amm.calculateTotalAmountForLpToken(totalStaked)
      if (stakedTotal.lte(0)) {
        return BigNumber.from(0)
      }
      const stakedTotal18d = shiftBNDecimals(stakedTotal, TOTAL_AMOUNTS_DECIMALS - token.decimals)
      const precision = amountToBN('1', 18)
      const oneYear = 365

      return totalRewardsPerDay
        .mul(rewardTokenUsdPriceBn)
        .mul(precision)
        .div(stakedTotal18d.mul(tokenUsdPriceBn))
        .mul(oneYear)
    } catch (err) {
      console.error(err)
    }
  }, [bridge, network, totalStaked, totalRewardsPerDay, rewardTokenUsdPrice, tokenUsdPrice])

  const stakedPosition = useAsyncMemo(async () => {
    if (
      !(
        bridge &&
        network &&
        earned &&
        rewardTokenUsdPrice &&
        tokenUsdPrice &&
        stakingToken &&
        stakeBalance &&
        stakeBalance.gt(0)
      )
    ) {
      return
    }

    const rewardTokenUsdPriceBn = amountToBN(rewardTokenUsdPrice.toString(), stakingToken.decimals)
    const tokenUsdPriceBn = amountToBN(tokenUsdPrice.toString(), stakingToken.decimals)
    const token = await bridge.getCanonicalToken(network.slug)
    const amm = bridge.getAmm(network.slug)
    const userStakedTotal = await amm.calculateTotalAmountForLpToken(stakeBalance)
    const userStakedTotal18d = shiftBNDecimals(
      userStakedTotal,
      TOTAL_AMOUNTS_DECIMALS - token.decimals
    )
    return userStakedTotal18d
      .mul(tokenUsdPriceBn)
      .add(earned.mul(rewardTokenUsdPriceBn))
      .div(BigNumber.from(10).pow(stakingToken?.decimals))
  }, [bridge, network, stakeBalance, stakingToken, earned, rewardTokenUsdPrice, tokenUsdPrice])

  // Actions

  const approveToken = async () => {
    if (!stakingRewards || !network || !stakingToken) {
      throw new Error('Undefined approval parameter')
    }

    const networkId = Number(network.networkId)
    const isNetworkConnected = await checkConnectedNetworkId(networkId)
    if (!isNetworkConnected || !parsedAmount) return

    const tx = await approve(parsedAmount, stakingToken, stakingRewards?.address)

    await tx?.wait()
  }

  const stake = async () => {
    try {
      if (!stakingRewards) {
        throw new Error('StakingRewards not instantiated')
      }

      if (!network) {
        throw new Error('Network must be defined')
      }

      const networkId = Number(network.networkId)
      const isNetworkConnected = await checkConnectedNetworkId(networkId)
      if (!isNetworkConnected) return

      const tx = await txConfirm?.show({
        kind: 'stake',
        inputProps: {
          amount: amount,
          token: stakingToken,
        },
        onConfirm: async () => {
          const signer = await sdk.getSignerOrProvider(network.slug)
          return stakingRewards.connect(signer).stake(parsedAmount)
        },
      })

      if (tx?.hash && network) {
        setAmount('')
        addTransaction(
          new Transaction({
            hash: tx.hash,
            networkName: network.slug,
            token: stakingToken,
          })
        )

        await waitForTransaction(tx, { networkName: network.slug, token: stakingToken })
      }
    } catch (err: any) {
      console.error(err)
    }
  }

  const claim = async () => {
    try {
      if (!stakingRewards) {
        throw new Error('StakingRewards not instantiated')
      }

      if (!network) {
        throw new Error('Network must be defined')
      }

      const networkId = Number(network.networkId)
      const isNetworkConnected = await checkConnectedNetworkId(networkId)
      if (!isNetworkConnected) return

      const signer = await sdk.getSignerOrProvider(network.slug)
      await stakingRewards.connect(signer).getReward()
    } catch (err: any) {
      console.error(err)
    }
  }

  const withdraw = async () => {
    try {
      if (!stakingRewards || !network || !stakeBalance) {
        throw new Error('Missing withdraw param')
      }

      const networkId = Number(network.networkId)
      const isNetworkConnected = await checkConnectedNetworkId(networkId)
      if (!isNetworkConnected) return

      const signer = await sdk.getSignerOrProvider(network.slug)
      const _stakingRewards = stakingRewards.connect(signer)

      const tx = await txConfirm?.show({
        kind: 'withdrawStake',
        inputProps: {
          token: stakingToken,
          amount: Number(formatUnits(stakeBalance, stakingToken?.decimals)),
        },
        onConfirm: async (amountPercent: number) => {
          if (!amountPercent) return

          if (amountPercent === 100) {
            return _stakingRewards.exit()
          }

          const withdrawAmount = stakeBalance.mul(amountPercent).div(100)

          return _stakingRewards.withdraw(withdrawAmount)
        },
      })

      if (tx?.hash && network) {
        addTransaction(
          new Transaction({
            hash: tx.hash,
            networkName: network.slug,
            token: stakingToken,
          })
        )

        await waitForTransaction(tx, { networkName: network.slug, token: stakingToken })
      }
    } catch (err: any) {
      console.error(err)
    }
  }

  // Formatting

  const {
    formattedStakeBalance,
    formattedEarned,
    totalStakedFormatted,
    totalRewardsPerDayFormatted,
    userRewardsPerDayFormatted,
    aprFormatted,
    stakedPositionFormatted,
  } = formatStakingValues(
    stakingToken,
    rewardsToken,
    stakeBalance,
    earned,
    totalStaked,
    totalRewardsPerDay,
    userRewardsPerDay,
    apr,
    stakedPosition,
    rewardsExpired
  )

  return (
    <Flex column alignCenter>
      <AmountSelectorCard
        label={`Staked: ${formattedStakeBalance}`}
        value={amount}
        token={stakingToken}
        onChange={handleOnChangeAmount}
        titleIconUrl={network?.imageUrl}
        title={`${network?.name} ${stakingToken?.name}`}
        balance={lpBalance}
        loadingBalance={loadingLpBalance}
        hideSymbol
      />

      <Div>Staking Rewards: {stakingRewards?.address}</Div>
      <Div>Rewards Token: {rewardsToken?.address}</Div>
      <Div>Staking Token: {stakingToken?.address}</Div>

      <div className={styles.details}>
        <DetailRow
          title="APR"
          tooltip="Annual Percentage Rate (APR) from staking LP tokens"
          value={aprFormatted}
        />
        <DetailRow
          title="Total Staked"
          tooltip="The total amount of LP tokens staked for rewards"
          value={totalStakedFormatted}
        />
        {totalRewardsPerDay?.gt(0) && (
          <DetailRow
            title={'Total Rewards'}
            tooltip={'The total rewards being distributed per day'}
            value={`${totalRewardsPerDayFormatted} / day`}
          />
        )}
      </div>
      <div className={styles.details}>
        {!!userRewardsPerDay && (
          <DetailRow
            title={'Your Rewards'}
            tooltip={"The rewards you're earning per day"}
            value={`${userRewardsPerDayFormatted} / day`}
          />
        )}
        {!!stakedPosition && (
          <DetailRow
            title="Your Total"
            tooltip="The total worth of your staked LP position in USD"
            value={stakedPositionFormatted}
          />
        )}
      </div>
      <Alert severity="warning" text={warning} className={styles.alert} />
      <Flex column alignCenter fullWidth mt={2} mb={4}>
        {earned?.gt(0) && (
          <Button className={styles.claimButton} large highlighted onClick={claim}>
            Claim {formattedEarned}
          </Button>
        )}

        <ButtonsWrapper>
          <Div mb={[3]}>
            <Button
              className={styles.button}
              large
              highlighted={!!needsApproval}
              disabled={!needsApproval}
              onClick={approveToken}
            >
              Approve
            </Button>
          </Div>
          <Div mb={[3]}>
            <Button
              className={styles.button}
              large
              highlighted={needsApproval === false}
              disabled={!isStakeEnabled}
              onClick={stake}
            >
              Stake
            </Button>
          </Div>
        </ButtonsWrapper>
        {stakeBalance?.gt(0) && (
          <Button className={styles.withdrawButton} large onClick={withdraw}>
            Withdraw
          </Button>
        )}
      </Flex>
    </Flex>
  )
}

export default StakeWidget
