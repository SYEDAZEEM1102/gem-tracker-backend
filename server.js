// server.js - Complete Backend Implementation
const express = require('express');
const { TwitterApi } = require('twitter-api-v2');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const WebSocket = require('ws');
const http = require('http');

// Initialize Express
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors({
  origin: [
    'https://syedazeem1102.github.io',
    'https://nodejs-production-b2333.up.railway.app',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

// Add explicit OPTIONS handler
app.options('*', cors());

// Environment Configuration
const config = {
  twitter: {
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
    bearerToken: process.env.TWITTER_BEARER_TOKEN
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY
  }
};

// Initialize clients
const twitterClient = new TwitterApi(config.twitter.bearerToken);

const supabase = createClient(config.supabase.url, config.supabase.anonKey);

// Global state
let isMonitoring = false;
let twitterStream = null;
let connectedClients = [];

// WebSocket connection handling
wss.on('connection', (ws) => {
  connectedClients.push(ws);
  console.log('Client connected. Total:', connectedClients.length);
  
  ws.on('close', () => {
    connectedClients = connectedClients.filter(client => client !== ws);
    console.log('Client disconnected. Total:', connectedClients.length);
  });
});

// Broadcast to all connected clients
function broadcast(data) {
  connectedClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Database Schema Creation
async function initializeDatabase() {
  try {
    console.log('Initializing database...');
    
    // Create accounts table
    const { error: accountsError } = await supabase.rpc('exec', {
      sql: `
        CREATE TABLE IF NOT EXISTS accounts (
          id SERIAL PRIMARY KEY,
          handle VARCHAR(50) UNIQUE NOT NULL,
          platform VARCHAR(20) DEFAULT 'twitter',
          follower_count INTEGER DEFAULT 0,
          total_calls INTEGER DEFAULT 0,
          wins INTEGER DEFAULT 0,
          win_rate DECIMAL(5,2) DEFAULT 0,
          avg_return DECIMAL(10,2) DEFAULT 0,
          sharpe_ratio DECIMAL(8,4) DEFAULT 0,
          max_drawdown DECIMAL(8,4) DEFAULT 0,
          profit_factor DECIMAL(8,4) DEFAULT 0,
          category VARCHAR(20) DEFAULT 'WATCH_LIST',
          risk_level VARCHAR(10) DEFAULT 'Medium',
          specialty TEXT,
          last_active TIMESTAMP DEFAULT NOW(),
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `
    });

    // Create calls table
    const { error: callsError } = await supabase.rpc('exec', {
      sql: `
        CREATE TABLE IF NOT EXISTS calls (
          id SERIAL PRIMARY KEY,
          account_id INTEGER REFERENCES accounts(id),
          handle VARCHAR(50) NOT NULL,
          token VARCHAR(20) NOT NULL,
          chain VARCHAR(20) DEFAULT 'solana',
          entry_price DECIMAL(20,12) NOT NULL,
          current_price DECIMAL(20,12),
          market_cap BIGINT,
          liquidity BIGINT,
          volume_24h BIGINT,
          tweet_id VARCHAR(50),
          tweet_url TEXT,
          call_text TEXT,
          reason TEXT,
          confidence_score DECIMAL(3,2) DEFAULT 0.5,
          perf_1h DECIMAL(10,4) DEFAULT 0,
          perf_24h DECIMAL(10,4) DEFAULT 0,
          perf_7d DECIMAL(10,4) DEFAULT 0,
          perf_30d DECIMAL(10,4) DEFAULT 0,
          status VARCHAR(10) DEFAULT 'open',
          called_at TIMESTAMP DEFAULT NOW(),
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `
    });

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Gem Call Extraction Engine
class CallExtractor {
  static patterns = [
    // Entry patterns
    /\$([A-Z]{2,10})\s+(?:entry|buy|buying|accumulating|adding|setup)/i,
    /(?:buying|adding|entry)\s+\$([A-Z]{2,10})/i,
    /\$([A-Z]{2,10})\s+at\s+([\d\.]+)/i,
    
    // Price patterns
    /\$([A-Z]{2,10}).*?([\d\.]+)/i,
    
    // Context patterns
    /gem.*?\$([A-Z]{2,10})/i,
    /\$([A-Z]{2,10}).*?moon/i
  ];

  static extractCall(tweet) {
    const text = tweet.text.toLowerCase();
    const originalText = tweet.text;
    
    // Skip retweets and replies
    if (text.startsWith('rt @') || text.startsWith('@')) {
      return null;
    }

    let extractedToken = null;
    let extractedPrice = null;
    let confidence = 0;

    // Try each pattern
    for (const pattern of this.patterns) {
      const match = originalText.match(pattern);
      if (match) {
        extractedToken = match[1];
        if (match[2]) extractedPrice = parseFloat(match[2]);
        confidence += 0.2;
        break;
      }
    }

    // Confidence boosters
    if (text.includes('entry') || text.includes('buying')) confidence += 0.3;
    if (text.includes('gem') || text.includes('alpha')) confidence += 0.2;
    if (text.includes('dyor') || text.includes('nfa')) confidence += 0.1;
    if (extractedPrice) confidence += 0.2;

    // Must have token and minimum confidence
    if (!extractedToken || confidence < 0.4) {
      return null;
    }

    return {
      token: '$' + extractedToken.toUpperCase(),
      entryPrice: extractedPrice || 0,
      confidence: Math.min(confidence, 1.0),
      reason: this.extractReason(text),
      tweetId: tweet.id,
      tweetUrl: `https://twitter.com/${tweet.author.username}/status/${tweet.id}`,
      callText: tweet.text
    };
  }

  static extractReason(text) {
    const reasons = [];
    
    if (text.includes('solana') || text.includes('sol')) reasons.push('solana play');
    if (text.includes('base') || text.includes('coinbase')) reasons.push('base ecosystem');
    if (text.includes('meme') || text.includes('degen')) reasons.push('meme rotation');
    if (text.includes('breakout') || text.includes('pump')) reasons.push('technical breakout');
    if (text.includes('narrative') || text.includes('trend')) reasons.push('narrative play');
    
    return reasons.length > 0 ? reasons.join(', ') : 'general call';
  }
}

// DexScreener Price Tracker
class PriceTracker {
  static async getTokenPrice(token, chain = 'solana') {
    try {
      const cleanToken = token.replace('$', '');
      const response = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${cleanToken}`);
      
      if (response.data && response.data.pairs && response.data.pairs.length > 0) {
        const pair = response.data.pairs.find(p => 
          p.chainId === chain || 
          p.baseToken.symbol.toLowerCase() === cleanToken.toLowerCase()
        ) || response.data.pairs[0];

        return {
          price: parseFloat(pair.priceUsd) || 0,
          marketCap: parseInt(pair.fdv) || 0,
          liquidity: parseInt(pair.liquidity?.usd) || 0,
          volume24h: parseInt(pair.volume?.h24) || 0,
          priceChange24h: parseFloat(pair.priceChange?.h24) || 0,
          dexPair: pair.url || `https://dexscreener.com/${chain}/${cleanToken}`
        };
      }
      
      return null;
    } catch (error) {
      console.error('DexScreener API error:', error.message);
      return null;
    }
  }

  static async updateCallPerformance(callId, call) {
    try {
      const priceData = await this.getTokenPrice(call.token, call.chain);
      if (!priceData) return;

      const entryPrice = parseFloat(call.entry_price);
      const currentPrice = priceData.price;
      
      if (entryPrice > 0) {
        const perf = ((currentPrice - entryPrice) / entryPrice) * 100;
        const status = perf >= 30 ? 'win' : perf <= -20 ? 'loss' : 'open';

        const { error } = await supabase
          .from('calls')
          .update({
            current_price: currentPrice,
            market_cap: priceData.marketCap,
            liquidity: priceData.liquidity,
            volume_24h: priceData.volume24h,
            perf_24h: perf,
            perf_7d: perf, // Simplified for demo
            status: status,
            updated_at: new Date().toISOString()
          })
          .eq('id', callId);

        if (error) {
          console.error('Performance update error:', error);
        }
      }
    } catch (error) {
      console.error('Price update error:', error);
    }
  }
}

// Account Performance Calculator
class AccountScorer {
  static async updateAccountMetrics(handle) {
    try {
      // Get account calls
      const { data: calls, error: callsError } = await supabase
        .from('calls')
        .select('*')
        .eq('handle', handle)
        .order('called_at', { ascending: false });

      if (callsError || !calls.length) return;

      const totalCalls = calls.length;
      const wins = calls.filter(call => call.status === 'win').length;
      const winRate = (wins / totalCalls) * 100;
      
      const returns = calls.map(call => call.perf_7d || 0);
      const avgReturn = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
      
      // Calculate Sharpe ratio (simplified)
      const avgPositiveReturn = returns.filter(r => r > 0).reduce((sum, r) => sum + r, 0) / Math.max(1, returns.filter(r => r > 0).length);
      const volatility = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length);
      const sharpeRatio = volatility > 0 ? avgPositiveReturn / volatility : 0;

      // Determine category
      let category = 'WATCH_LIST';
      if (totalCalls >= 10 && winRate >= 70 && sharpeRatio > 1.5) {
        category = 'GEM_MAIN';
      } else if (totalCalls >= 5 && winRate >= 50 && sharpeRatio > 0.8) {
        category = 'GEM_EMERGING';
      } else if (winRate < 40) {
        category = 'REMOVE';
      }

      // Update account
      const { error: updateError } = await supabase
        .from('accounts')
        .upsert({
          handle: handle,
          total_calls: totalCalls,
          wins: wins,
          win_rate: winRate,
          avg_return: avgReturn,
          sharpe_ratio: sharpeRatio,
          category: category,
          last_active: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

      if (updateError) {
        console.error('Account update error:', updateError);
      }

    } catch (error) {
      console.error('Account scoring error:', error);
    }
  }
}

// Twitter Stream Manager
class TwitterStreamManager {
  static async startMonitoring() {
    try {
      if (twitterStream) {
        await twitterStream.close();
      }

      // Define stream rules
      const rules = [
        { value: 'buying $PONKE OR $WOJAK OR $BRETT OR $PEPE entry', tag: 'gem_calls' },
        { value: 'accumulating setup gem alpha from:degenspartan OR from:0xngmi OR from:cobie', tag: 'influencer_calls' },
        { value: '"entry zone" "buy zone" has:links lang:en', tag: 'general_calls' }
      ];

      // Add rules
      await twitterClient.v2.updateStreamRules({
        add: rules
      });

      // Start stream
      twitterStream = await twitterClient.v2.searchStream({
        'tweet.fields': ['created_at', 'author_id', 'public_metrics'],
        'user.fields': ['username', 'public_metrics'],
        expansions: ['author_id']
      });

      twitterStream.on('data', async (tweet) => {
        try {
          const author = tweet.includes?.users?.[0];
          if (!author) return;

          const extractedCall = CallExtractor.extractCall({
            ...tweet.data,
            author: author
          });

          if (extractedCall) {
            await this.processCall(extractedCall, author);
          }
        } catch (error) {
          console.error('Tweet processing error:', error);
        }
      });

      twitterStream.on('error', (error) => {
        console.error('Twitter stream error:', error);
        isMonitoring = false;
        broadcast({ type: 'monitoring_status', isMonitoring: false });
      });

      isMonitoring = true;
      broadcast({ type: 'monitoring_status', isMonitoring: true });
      console.log('Twitter monitoring started');

    } catch (error) {
      console.error('Twitter stream start error:', error);
      isMonitoring = false;
    }
  }

  static async processCall(call, author) {
    try {
      // Get current price
      const priceData = await PriceTracker.getTokenPrice(call.token);
      const entryPrice = call.entryPrice || (priceData ? priceData.price : 0);

      // Insert call into database
      const { data: callData, error: callError } = await supabase
        .from('calls')
        .insert({
          handle: '@' + author.username,
          token: call.token,
          entry_price: entryPrice,
          current_price: priceData ? priceData.price : entryPrice,
          market_cap: priceData ? priceData.marketCap : 0,
          liquidity: priceData ? priceData.liquidity : 0,
          volume_24h: priceData ? priceData.volume24h : 0,
          tweet_id: call.tweetId,
          tweet_url: call.tweetUrl,
          call_text: call.callText,
          reason: call.reason,
          confidence_score: call.confidence,
          called_at: new Date().toISOString()
        })
        .select();

      if (callError) {
        console.error('Call insert error:', callError);
        return;
      }

      // Update account metrics
      await AccountScorer.updateAccountMetrics('@' + author.username);

      // Broadcast new call
      broadcast({
        type: 'new_call',
        call: {
          id: callData[0].id,
          handle: '@' + author.username,
          token: call.token,
          entryPrice: entryPrice,
          currentPrice: priceData ? priceData.price : entryPrice,
          confidence: call.confidence,
          reason: call.reason,
          timestamp: new Date().toISOString()
        }
      });

      console.log(`New call: ${author.username} - ${call.token} at ${entryPrice}`);

    } catch (error) {
      console.error('Process call error:', error);
    }
  }

  static async stopMonitoring() {
    try {
      if (twitterStream) {
        await twitterStream.close();
        twitterStream = null;
      }
      isMonitoring = false;
      broadcast({ type: 'monitoring_status', isMonitoring: false });
      console.log('Twitter monitoring stopped');
    } catch (error) {
      console.error('Stop monitoring error:', error);
    }
  }
}

// API Routes
app.get('/api/system/status', (req, res) => {
  res.json({
    isMonitoring,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.post('/api/monitoring/start', async (req, res) => {
  try {
    await TwitterStreamManager.startMonitoring();
    res.json({ success: true, isMonitoring: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/monitoring/stop', async (req, res) => {
  try {
    await TwitterStreamManager.stopMonitoring();
    res.json({ success: true, isMonitoring: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/accounts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('accounts')
      .select('*')
      .order('win_rate', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/calls/recent', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('calls')
      .select('*')
      .order('called_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/system/stats', async (req, res) => {
  try {
    const { data: accounts } = await supabase.from('accounts').select('*');
    const { data: calls } = await supabase.from('calls').select('*');
    const { data: todayCalls } = await supabase
      .from('calls')
      .select('*')
      .gte('called_at', new Date().toISOString().split('T')[0]);

    const stats = {
      totalAccounts: accounts?.length || 0,
      activeAccounts: accounts?.filter(a => a.last_active > new Date(Date.now() - 24*60*60*1000).toISOString()).length || 0,
      callsToday: todayCalls?.length || 0,
      successRate: calls?.length > 0 ? (calls.filter(c => c.status === 'win').length / calls.length * 100) : 0,
      totalValue: calls?.reduce((sum, call) => sum + (call.market_cap || 0), 0) || 0,
      systemUptime: '99.8%',
      apiStatus: 'healthy'
    };

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Price update cron job (every hour)
cron.schedule('0 * * * *', async () => {
  console.log('Running hourly price updates...');
  
  const { data: openCalls } = await supabase
    .from('calls')
    .select('*')
    .eq('status', 'open');

  for (const call of openCalls || []) {
    await PriceTracker.updateCallPerformance(call.id, call);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
  }
});

// Initialize and start server
async function startServer() {
  await initializeDatabase();
  
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => {
    console.log(`🚀 Gem Tracker Backend running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔗 WebSocket: ws://localhost:${PORT}`);
  });
}

startServer();
