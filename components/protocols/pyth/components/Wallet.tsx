import {
  Col,
  Space,
  Switch,
  message,
  Statistic,
  Card,
  Button,
  InputNumber,
  Table,
  Row,
  Input,
  Tag,
  notification,
  Tooltip,
} from 'antd';
import {useGlobalState} from 'context';
import {SyncOutlined} from '@ant-design/icons';
import React, {useEffect, useState} from 'react';
import {Cluster, clusterApiUrl, Connection} from '@solana/web3.js';
import {PythConnection, getPythProgramKeyForCluster} from '@pythnetwork/client';
import {DollarCircleFilled} from '@ant-design/icons';
import {EventEmitter} from 'events';
import {PYTH_NETWORKS, SOLANA_NETWORKS} from 'types/index';
import {
  ORCA_DECIMAL,
  SOL_DECIMAL,
  USDC_DECIMAL,
  useExtendedWallet,
} from '@figment-pyth/lib/wallet';
import _ from 'lodash';
import * as Rx from 'rxjs';

const connection = new Connection(clusterApiUrl(PYTH_NETWORKS.DEVNET));
const pythPublicKey = getPythProgramKeyForCluster(PYTH_NETWORKS.DEVNET);
const pythConnection = new PythConnection(connection, pythPublicKey);

const signalListener = new EventEmitter();

const Wallet = () => {
  const {state, dispatch} = useGlobalState();
  const [cluster, setCluster] = useState<Cluster>('devnet');

  const [useLive, setUseLive] = useState(false);
  const [price, setPrice] = useState<number | undefined>(undefined);
  const {setSecretKey, keyPair, balance, addOrder, orderBook, resetWallet} =
    useExtendedWallet(useLive, cluster, price);

  const [yieldExpectation, setYield] = useState<number>(0.001); // amount of ema to buy/sell signal
  const [orderSizeUSDC, setOrderSizeUSDC] = useState<number>(20); // USDC
  const [orderSizeSOL, setOrderSizeSOL] = useState<number>(0.14); // SOL
  const [symbol, setSymbol] = useState<string | undefined>(undefined);

  // Shorten the public key for display purposes
  const displayAddress = `${keyPair.publicKey
    .toString()
    .slice(0, 6)}...${keyPair.publicKey.toString().slice(38, 44)}`;

  // State for tracking user worth with current Market Price.
  const [worth, setWorth] = useState({initial: 0, current: 0});

  useEffect(() => {
    if (cluster === SOLANA_NETWORKS.MAINNET) {
      notification.warn({
        message: '⚠️ WARNING! ⚠️',
        description:
          'Swaps on mainnet-beta use real funds. Use extreme caution!',
      });
    } else if (cluster === SOLANA_NETWORKS.DEVNET) {
      notification.info({
        message: 'On devnet ✅',
        description: 'Swaps on devnet have no actual value!',
      });
    }
  }, [cluster]);

  useEffect(() => {
    if (price) {
      dispatch({
        type: 'SetIsCompleted',
      });
      // Set ordersize Amount in Sol respect to USDC.
      setOrderSizeSOL(orderSizeUSDC / price!);
    }

    // update the current worth each price update.
    const currentWorth = balance?.sol_balance * price! + balance.usdc_balance;
    setWorth({...worth, current: currentWorth});
  }, [price, orderSizeUSDC, setPrice]);

  useEffect(() => {
    signalListener.once('*', () => {
      resetWallet(); // Reset the wallet to the initial state. Destructured from useExtendedWallet.
    });
    const buy = Rx.fromEvent(signalListener, 'buy').pipe(Rx.mapTo(1)); // for reduce sum function to understand the operation.
    const sell = Rx.fromEvent(signalListener, 'sell').pipe(Rx.mapTo(-1)); /// for reduce sum function to understand the operation.
    Rx.merge(buy, sell)
      .pipe(
        Rx.tap((v: any) => console.log(v)),
        Rx.bufferTime(10000), // Wait 10 seconds
        Rx.map((orders: number[]) => {
          return orders.reduce((prev, curr) => prev + curr, 0); // sum of the orders in the buffer.
        }),
        Rx.filter((v) => v !== 0), // if we have equivalent orders, don't put any order.
        Rx.map((val: number) => {
          if (val > 0) {
            // buy.
            return {
              side: 'buy',
              size: val * orderSizeUSDC,
              fromToken: 'usdc',
              toToken: 'sol',
            };
          } else if (val <= 0) {
            return {
              side: 'sell',
              size: Math.abs(val) * orderSizeSOL,
              fromToken: 'sol',
              toToken: 'usdc',
            };
          }
        }),
      )
      .subscribe(async (v: any) => {
        await addOrder({
          ...v,
          cluster,
        });
      });
    return () => {
      signalListener.removeAllListeners();
    };
  }, [
    yieldExpectation,
    orderSizeUSDC,
    orderSizeSOL,
    useLive,
    cluster,
    keyPair,
  ]);

  const [data, setData] = useState<any[]>([]);
  const getPythData = async (checked: boolean) => {
    pythConnection.onPriceChange((product, price) => {
      if (
        product.symbol === 'Crypto.SOL/USD' &&
        price.price &&
        price.confidence
      ) {
        console.log(
          `${product.symbol}: $${price.price} \xB1$${price.confidence}`,
        );
        setPrice(price.price);

        const newData: {
          price: number;
          priceConfidenceRange: number[];
          ts: number;
          sma: undefined | number;
          ema: undefined | number;
          trend: undefined | boolean;
        } = {
          price: price.price,
          priceConfidenceRange: [
            price?.price! - price?.confidence!,
            price?.price! + price?.confidence!,
          ],
          ts: +new Date(),
          sma: undefined,
          ema: undefined,
          trend: undefined,
        };

        /**
         * Calculate Simple moving average:
         *   https://en.wikipedia.org/wiki/Moving_average#Simple_moving_average
         * Calculate Exponential moving average:
         *   https://en.wikipedia.org/wiki/Moving_average#Exponential_moving_average
         * The Exponential moving average has a better reaction to price changes.
         *
         * Ref: https://blog.oliverjumpertz.dev/the-moving-average-simple-and-exponential-theory-math-and-implementation-in-javascript
         */
        const window = 10;
        const smoothingFactor = 2 / (window + 1);

        setData((data) => {
          if (data.length > window) {
            const windowSlice = data.slice(data.length - window, data.length);
            const sum = windowSlice.reduce(
              (prev, curr) => prev + curr.price,
              0,
            );
            newData.sma = sum / window;

            const previousEma = newData.ema || newData.sma;
            const currentEma =
              (newData.price - previousEma) * smoothingFactor + previousEma;
            newData.ema = currentEma;

            /**
             * trend of the price respect to preview ema.
             * if the price is higher than the ema, it is a positive trend.
             * if the price is lower than the ema, it is a negative trend.
             * prev 10 ema trend:
             * curr 11 ema  this will yield as trend to be % 110 up which is BUY signal.
             */
            const trend = newData.ema / data[data.length - 1].ema;
            if (trend * 100 > 100 + yieldExpectation) {
              signalListener.emit('buy');
            } else if (trend * 100 < 100 - yieldExpectation) {
              signalListener.emit('sell');
            }
          }
          return [...data, newData];
        });
        setSymbol('Crypto.SOL/USD');
      } else if (product.symbol === 'Crypto.SOL/USD' && !price.price) {
        console.log(`${product.symbol}: price currently unavailable`);
        setPrice(0);
        setSymbol('Crypto.SOL/USD');
      }
    });

    if (!checked) {
      message.info('Stopping Pyth price feed!');
      pythConnection.stop();
    } else {
      message.info('Starting Pyth price feed!');
      pythConnection.start();
    }
  };
  console.log(orderBook);
  return (
    <Col>
      <Space direction="vertical" size="large">
        <Space direction="horizontal" size="large">
          <Card
            style={{width: 550}}
            title={
              !useLive ? (
                'Mock Wallet'
              ) : (
                <Tooltip
                  title={keyPair.publicKey.toString()}
                  color={'purple'}
                  arrowPointAtCenter
                >
                  {displayAddress}
                </Tooltip>
              )
            }
            extra={
              <>
                <Switch
                  checked={useLive}
                  onChange={(val) => setUseLive(val)}
                  checkedChildren={'Live'}
                  unCheckedChildren={'Mock'}
                />{' '}
                {useLive ? (
                  <Switch
                    checked={cluster === 'mainnet-beta'}
                    onChange={(val) =>
                      setCluster(val ? 'mainnet-beta' : 'devnet')
                    }
                    checkedChildren={'Mainnet'}
                    unCheckedChildren={'Devnet'}
                  />
                ) : (
                  <>
                    <Button onClick={() => resetWallet()} disabled={useLive}>
                      Reset Wallet
                    </Button>
                  </>
                )}
              </>
            }
          >
            <Row>
              <Col span={12}>
                <Statistic
                  value={balance?.sol_balance / SOL_DECIMAL}
                  title={'SOL'}
                />
              </Col>
              <Col span={12}>
                <Statistic
                  value={balance?.usdc_balance / USDC_DECIMAL}
                  title={'USDC'}
                />
              </Col>
              <Col span={12}>
                <Statistic
                  value={balance?.orca_balance / ORCA_DECIMAL}
                  title={'ORCA'}
                />
              </Col>

              <Col span={12}>
                <Statistic
                  value={
                    (balance?.sol_balance / SOL_DECIMAL) * price! +
                    balance.usdc_balance / USDC_DECIMAL
                  }
                  title={'TOTAL WORTH'}
                />
              </Col>

              <Col span={12}>
                <Statistic
                  value={(worth.initial / worth.current) * 100 - 100}
                  prefix={'%'}
                  title={'Change'}
                />
              </Col>
            </Row>
            <Row>
              {useLive ? (
                <>
                  <Row>
                    <label htmlFor="secretKey">Public Key:&nbsp;</label>
                    {keyPair?.publicKey && displayAddress}
                  </Row>
                  <Row>
                    <label htmlFor="secretKey">Wallet Key:&nbsp;</label>
                    <Input
                      id="secretKey"
                      type="password"
                      onChange={(e) => setSecretKey(e.target.value)}
                      placeholder="Paste a Solana private key into this textbox"
                      style={{width: 320}}
                    />
                  </Row>
                </>
              ) : null}
            </Row>
          </Card>
        </Space>
      </Space>
    </Col>
  );
};

export default Wallet;