import * as hl from "@nktkas/hyperliquid";
import * as fs from "fs/promises";
import * as path from "path";
import WebSocket from "ws";

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

let isRunning = true;
const spotSymbolMapping = new Map<string, string>();
const reverseLookup = new Map<string, string>();
let allMidsCache: Record<string, string> = {};
let outputDir: string;

// 병렬 처리를 위한 큐
const saveQueue = new Set<Promise<void>>();

// Ctrl+C 처리
process.on('SIGINT', async () => {
  console.log('\n\n🛑 종료 신호 받음. 대기 중인 작업 완료 후 종료...');
  isRunning = false;
  
  // 모든 저장 작업 완료 대기
  if (saveQueue.size > 0) {
    console.log(`⏳ ${saveQueue.size}개 작업 완료 대기 중...`);
    await Promise.all(Array.from(saveQueue));
  }
  
  console.log('✅ 모든 작업 완료. 프로그램 종료.');
  process.exit(0);
});

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
    
  } catch (error) {
    console.error('❌ 현물 메타데이터 로드 실패:', error);
    return [];
  }
}

async function updateMidPrices(): Promise<void> {
  try {
    const transport = new hl.HttpTransport();
    const client = new hl.PublicClient({ transport });
    allMidsCache = await client.allMids();
  } catch (error) {
    console.error('❌ 중간가 업데이트 실패:', error);
  }
}

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

// 비동기 병렬 저장
async function saveOrderbookToFile(coinData: CoinOrderbook): Promise<void> {
  const safeFolderName = coinData.displaySymbol.replace(/[\/\\:*?"<>|]/g, '-');
  const coinDir = path.join(outputDir, safeFolderName);
  
  try {
    // 폴더 존재 확인 및 생성 (비동기)
    await fs.mkdir(coinDir, { recursive: true });

    // JSON, CSV, Summary 병렬 저장
    const jsonPath = path.join(coinDir, `${safeFolderName}_orderbook.json`);
    const csvPath = path.join(coinDir, `${safeFolderName}_orderbook.csv`);
    const summaryPath = path.join(coinDir, `${safeFolderName}_summary.txt`);

    // CSV 데이터 준비
    const csvHeader = "Side,Level,Price,Size,Cumulative,Timestamp\n";
    const csvRows: string[] = [];
    
    coinData.bids.forEach((bid) => {
      csvRows.push(`BID,${bid.level},${bid.price},${bid.size},${bid.cumulative},${bid.timestamp}`);
    });
    coinData.asks.forEach((ask) => {
      csvRows.push(`ASK,${ask.level},${ask.price},${ask.size},${ask.cumulative},${ask.timestamp}`);
    });
    
    const csvContent = csvHeader + csvRows.join("\n");

    // Summary 데이터 준비
    const summary = `
${coinData.displaySymbol} 오더북 요약 (현물)
===================
원본 심볼: ${coinData.symbol}
표시 심볼: ${coinData.displaySymbol}
마지막 업데이트: ${coinData.lastUpdate}
중간가: ${coinData.midPrice}
스프레드: ${coinData.spread} (${coinData.spreadPercentage})

매수 1호가: ${coinData.bids[0]?.price || 'N/A'} (수량: ${coinData.bids[0]?.size || 'N/A'})
매도 1호가: ${coinData.asks[0]?.price || 'N/A'} (수량: ${coinData.asks[0]?.size || 'N/A'})

상위 10호가 매수 누적: ${coinData.bids[coinData.bids.length - 1]?.cumulative || 'N/A'}
상위 10호가 매도 누적: ${coinData.asks[coinData.asks.length - 1]?.cumulative || 'N/A'}
`;

    // 3개 파일 병렬 저장 (await 하지 않음 - fire and forget)
    await Promise.all([
      fs.writeFile(jsonPath, JSON.stringify(coinData, null, 2)),
      fs.writeFile(csvPath, csvContent),
      fs.writeFile(summaryPath, summary)
    ]);

  } catch (error) {
    console.error(`✗ ${coinData.displaySymbol} 파일 저장 실패:`, error);
  }
}

async function connectWebSocket(spotCoins: string[]): Promise<void> {
  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
  let reconnectTimeout: NodeJS.Timeout;
  let updateCount = 0;
  let processCount = 0;
  const startTime = Date.now();
  const updatedCoins = new Set<string>();

  ws.on('open', () => {
    console.log('🔌 WebSocket 연결 성공!');

    // 모든 현물 코인에 대한 L2 Book 구독
    spotCoins.forEach(coin => {
      ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: {
          type: 'l2Book',
          coin: coin
        }
      }));
    });

    console.log(`📡 ${spotCoins.length}개 현물 페어 구독 완료\n`);
    console.log('⚡ 실시간 업데이트 시작... (병렬 처리 모드)');
    console.log('='.repeat(70));
  });

  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      
      // l2Book 채널 메시지만 처리
      if (message.channel === 'l2Book' && message.data) {
        const coin = message.data.coin;
        
        // 현물 코인만 처리
        if (!coin.startsWith('@')) return;

        processCount++;

        // 오더북 데이터 처리 (동기)
        const coinData = processOrderbookData(coin, message.data);
        
        if (coinData) {
          updatedCoins.add(coinData.displaySymbol);
          updateCount++;

          // 비동기 저장 시작 (병렬 처리 - await 하지 않음)
          const savePromise = saveOrderbookToFile(coinData)
            .finally(() => {
              saveQueue.delete(savePromise);
            });
          
          saveQueue.add(savePromise);

          // 너무 많은 병렬 작업 방지 (메모리 보호)
          if (saveQueue.size > 100) {
            Promise.race(Array.from(saveQueue));
          }

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          const updatesPerSec = (processCount / parseFloat(elapsed)).toFixed(2);
          const queueSize = saveQueue.size;
          
          process.stdout.write(
            `\r⚡ ${processCount.toString().padStart(6)}건 | ` +
            `${coinData.displaySymbol.padEnd(20)} | ` +
            `매수: ${coinData.bids[0]?.price.padEnd(12)} | ` +
            `매도: ${coinData.asks[0]?.price.padEnd(12)} | ` +
            `${updatesPerSec}/초 | 큐: ${queueSize.toString().padStart(3)}   `
          );
        }
      }
    } catch (error) {
      // 파싱 에러 무시 (heartbeat 등)
    }
  });

  ws.on('error', (error) => {
    console.error('\n❌ WebSocket 오류:', error.message);
  });

  ws.on('close', () => {
    console.log('\n🔌 WebSocket 연결 종료');

    if (isRunning) {
      console.log('🔄 5초 후 재연결 시도...');
      reconnectTimeout = setTimeout(() => {
        connectWebSocket(spotCoins);
      }, 5000);
    }
  });

  // 30초마다 통계 출력
  const statsInterval = setInterval(() => {
    if (!isRunning) {
      clearInterval(statsInterval);
      return;
    }

    const total = spotCoins.length;
    const updated = updatedCoins.size;
    const coverage = ((updated / total) * 100).toFixed(1);
    const queueSize = saveQueue.size;
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`📊 [${new Date().toLocaleTimeString()}] 업데이트: ${updated}/${total} (${coverage}%) | 총: ${processCount}건 | 대기: ${queueSize}`);
    console.log(`${'='.repeat(70)}`);
  }, 30000);

  // 10초마다 중간가 갱신
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
    ws.close();
  });
}

async function runWebSocketCollector() {
  console.log("🚀 WebSocket 실시간 현물 오더북 수집기 (병렬 처리)\n");
  console.log("⚠️  종료하려면 Ctrl+C를 누르세요\n");

  outputDir = path.join(process.cwd(), "realtime-spot-orderbooks");
  await fs.mkdir(outputDir, { recursive: true });

  console.log("📊 현물 메타데이터 로드 중...");
  const spotCoins = await initSpotMetadata();

  if (spotCoins.length === 0) {
    console.error('❌ 현물 코인을 찾을 수 없습니다.');
    return;
  }

  console.log(`📁 저장 경로: ${outputDir}\n`);

  // 초기 중간가 로드
  console.log("💰 중간가 데이터 로드 중...");
  await updateMidPrices();
  console.log("✅ 중간가 로드 완료\n");

  await connectWebSocket(spotCoins);
}

runWebSocketCollector()
  .catch((error) => {
    console.error("💥 치명적 오류:", error);
    process.exit(1);
  });
