import * as hl from "@nktkas/hyperliquid";
import WebSocket from "ws";

// 오더북 데이터 구조 (기존과 동일)
interface OrderbookLevel {
  level: number;
  price: string;
  size: string;
  cumulative: string;
  timestamp: string;
}

interface CoinOrderbook {
  symbol: string;
  displaySymbol: string;
  lastUpdate: string;
  midPrice: string;
  spread: string;
  spreadPercentage: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
}

// 전역 변수
let isRunning = true;
const spotSymbolMapping = new Map<string, string>();
const reverseLookup = new Map<string, string>();
let allMidsCache: Record<string, string> = {};

// [수정] 최신 오더북 데이터를 저장할 메모리 캐시
const latestOrderbooks = new Map<string, CoinOrderbook>();

// Ctrl+C 처리 (단순화)
process.on('SIGINT', () => {
  console.log('\n\n🛑 종료 신호 받음. 프로그램 종료.');
  isRunning = false;
  process.exit(0);
});

// 메타데이터 로드 함수 (기존과 동일)
async function initSpotMetadata(): Promise<string[]> {
  try {
    const response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotMeta' })
    });
    
    const spotMetadata = await response.json();
    
    const tokenMap = new Map<number, string>();
    spotMetadata.tokens.forEach((token: any) => {
      tokenMap.set(token.index, token.name);
    });
    
    const spotCoins: string[] = [];
    
    spotMetadata.universe.forEach((pair: any) => {
      if (pair.name.startsWith('@')) {
        spotCoins.push(pair.name);
        
        const tokenNames = pair.tokens.map((tokenIndex: number) => 
          tokenMap.get(tokenIndex) || `Token${tokenIndex}`
        );
        
        if (tokenNames.length === 2) {
          const displayName = `${tokenNames[0]}-${tokenNames[1]}`;
          spotSymbolMapping.set(pair.name, displayName);
          reverseLookup.set(displayName, pair.name);
        }
      }
    });
    
    console.log(`✅ ${spotCoins.length}개 현물 페어 로드 완료`);
    return spotCoins;
    
  } catch (error)
    {
    console.error('❌ 현물 메타데이터 로드 실패:', error);
    return [];
  }
}

// 중간가 업데이트 함수 (기존과 동일)
async function updateMidPrices(): Promise<void> {
  try {
    const transport = new hl.HttpTransport();
    const client = new hl.PublicClient({ transport });
    allMidsCache = await client.allMids();
  } catch (error) {
    console.error('❌ 중간가 업데이트 실패:', error);
  }
}

// 오더북 데이터 처리 함수 (기존과 동일)
function processOrderbookData(
  coin: string,
  l2Data: any
): CoinOrderbook | null {
  try {
    const displaySymbol = spotSymbolMapping.get(coin) || coin;
    const midPrice = allMidsCache[coin] || '0';
    
    const bids = l2Data.levels[0].map((level: any) => ({
      price: level.px,
      size: level.sz,
    }));

    const asks = l2Data.levels[1].map((level: any) => ({
      price: level.px,
      size: level.sz,
    }));

    const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 0;
    const spread = bestAsk - bestBid;
    const spreadPercentage = bestBid > 0 ? ((spread / bestBid) * 100).toFixed(4) : "0";

    const timestamp = new Date().toISOString();
    const topBidsCount = Math.min(10, bids.length);
    const topAsksCount = Math.min(10, asks.length);

    let bidCumulative = 0;
    const topBids: OrderbookLevel[] = bids.slice(0, topBidsCount).map((bid: any, idx: number) => {
      bidCumulative += parseFloat(bid.size);
      return {
        level: idx + 1,
        price: bid.price,
        size: bid.size,
        cumulative: bidCumulative.toFixed(4),
        timestamp: timestamp,
      };
    });

    let askCumulative = 0;
    const topAsks: OrderbookLevel[] = asks.slice(0, topAsksCount).map((ask: any, idx: number) => {
      askCumulative += parseFloat(ask.size);
      return {
        level: idx + 1,
        price: ask.price,
        size: ask.size,
        cumulative: askCumulative.toFixed(4),
        timestamp: timestamp,
      };
    });

    return {
      symbol: coin,
      displaySymbol,
      lastUpdate: timestamp,
      midPrice,
      spread: spread.toFixed(8),
      spreadPercentage: `${spreadPercentage}%`,
      bids: topBids,
      asks: topAsks,
    };
  } catch (error) {
    console.error(`✗ ${coin} 처리 실패:`, error);
    return null;
  }
}

// [삭제] saveOrderbookToFile 함수 전체 삭제

async function connectWebSocket(spotCoins: string[]): Promise<void> {
  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
  let reconnectTimeout: NodeJS.Timeout;
  let processCount = 0;
  const startTime = Date.now();

  ws.on('open', () => {
    console.log('🔌 WebSocket 연결 성공!');

    spotCoins.forEach(coin => {
      ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'l2Book', coin: coin }
      }));
    });

    console.log(`📡 ${spotCoins.length}개 현물 페어 구독 완료\n`);
    console.log('⚡ 실시간 오더북 캐시 시작... (메모리 모드)');
    console.log('='.repeat(70));
  });

  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.channel === 'l2Book' && message.data) {
        const coin = message.data.coin;
        if (!coin.startsWith('@')) return;

        processCount++;
        const coinData = processOrderbookData(coin, message.data);
        
        if (coinData) {
          // [수정] 파일 저장 대신 메모리 캐시에 최신 데이터 덮어쓰기
          latestOrderbooks.set(coinData.symbol, coinData);

          // =================================================================
          // TODO: 여기에 프라이스 임팩트 계산 및 거래 로직을 추가하세요.
          // 예: findArbitrageOpportunity(coinData, latestOrderbooks);
          // =================================================================

          // [수정] 콘솔 출력에서 큐 관련 내용 제거
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          const updatesPerSec = (parseFloat(elapsed) > 0 ? (processCount / parseFloat(elapsed)) : 0).toFixed(2);
          
          process.stdout.write(
            `\r⚡ ${processCount.toString().padStart(7)}건 | ` +
            `${coinData.displaySymbol.padEnd(20)} | ` +
            `매수: ${coinData.bids[0]?.price.padEnd(12)} | ` +
            `매도: ${coinData.asks[0]?.price.padEnd(12)} | ` +
            `${updatesPerSec}/초`
          );
        }
      }
    } catch (error) {
      // 파싱 에러는 무시
    }
  });

  ws.on('error', (error) => {
    console.error('\n❌ WebSocket 오류:', error.message);
  });

  ws.on('close', () => {
    console.log('\n🔌 WebSocket 연결 종료');
    if (isRunning) {
      console.log('🔄 5초 후 재연결 시도...');
      reconnectTimeout = setTimeout(() => connectWebSocket(spotCoins), 5000);
    }
  });

  // 30초마다 통계 출력 (수정)
  const statsInterval = setInterval(() => {
    if (!isRunning) {
      clearInterval(statsInterval);
      return;
    }
    const memoryUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`📊 [${new Date().toLocaleTimeString()}] 총 수신: ${processCount}건 | 캐시된 페어: ${latestOrderbooks.size}/${spotCoins.length} | 메모리: ${memoryUsage} MB`);
    console.log(`${'='.repeat(70)}`);
  }, 30000);

  // 10초마다 중간가 갱신 (기존과 동일)
  const midPriceInterval = setInterval(() => {
    if (!isRunning) {
      clearInterval(midPriceInterval);
      return;
    }
    updateMidPrices();
  }, 10000);

  // 종료 시 정리
  process.on('SIGINT', () => {
    clearInterval(statsInterval);
    clearInterval(midPriceInterval);
    clearTimeout(reconnectTimeout);
    if (ws) ws.close();
  });
}

async function run() {
  console.log("🚀 실시간 현물 오더북 수집기 (메모리 캐시 모드)\n");
  console.log("⚠️  종료하려면 Ctrl+C를 누르세요\n");

  console.log("📊 현물 메타데이터 로드 중...");
  const spotCoins = await initSpotMetadata();

  if (spotCoins.length === 0) {
    console.error('❌ 현물 코인을 찾을 수 없습니다.');
    return;
  }

  console.log("💰 중간가 데이터 로드 중...");
  await updateMidPrices();
  console.log("✅ 중간가 로드 완료\n");

  await connectWebSocket(spotCoins);
}

run().catch((error) => {
  console.error("💥 치명적 오류:", error);
  process.exit(1);
});
