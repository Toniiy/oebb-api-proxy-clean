const express = require('express');
const cors = require('cors');
const { createClient } = require('hafas-client');
const oebbProfile = require('hafas-client/p/oebb/index.js');

const app = express();
app.use(cors());

// Create a new profile object with required locale and timezone
const customProfile = {
  ...oebbProfile,
  locale: 'de-AT',
  timezone: 'Europe/Vienna'
};
const hafas = createClient(customProfile, 'oebb-proxy');

// caching settings
const CACHE_DURATION = parseInt(process.env.CACHE_DURATION || '300000');
const cache = {
  stpLinz: { data: null, timestamp: 0 },
  linzStp: { data: null, timestamp: 0 },
};

// helper to fetch and cache journeys
async function getJourneys(fromId, toId) {
  const now = Date.now();
  let cacheKey;
  if (fromId === '8103002' && toId === '8100009') {
    cacheKey = 'stpLinz';
  } else if (fromId === '8100009' && toId === '8103002') {
    cacheKey = 'linzStp';
  }
  
  if (cacheKey && cache[cacheKey].data && now - cache[cacheKey].timestamp < CACHE_DURATION) {
    return cache[cacheKey].data;
  }
  
  try {
    const results = await hafas.journeys(fromId, toId, {
      results: 5,
      departure: new Date(),
      stopovers: true,
    });
    
    const journeys = results.journeys || [];
    
    // filter for next four hours and limit to three journeys
    const filtered = journeys.filter(j => {
      const depDate = new Date(j.legs[0].departure);
      return depDate.getTime() - Date.now() <= 4 * 60 * 60 * 1000;
    }).slice(0, 3);
    
    const transformed = filtered.map(j => transformJourney(j));
    
    if (cacheKey) {
      cache[cacheKey].data = transformed;
      cache[cacheKey].timestamp = now;
    }
    
    return transformed;
  } catch (err) {
    console.error('Error fetching journeys:', err);
    return getFallbackData(fromId, toId);
  }
}

// transform journey to simplified object
function transformJourney(journey) {
  const leg = journey.legs[0];
  const depDelay = leg.departureDelay || 0;
  const status = depDelay <= 0 ? 'on-time' : depDelay <= 5 * 60 ? 'slightly-delayed' : 'delayed';
  
  return {
    train: leg.line && leg.line.name ? leg.line.name : 'Unknown',
    trainType: leg.line && leg.line.product && leg.line.product.type ? leg.line.product.type : 'Train',
    departure: leg.departure,
    arrival: leg.arrival,
    departurePlatform: leg.departurePlatform || '?',
    arrivalPlatform: leg.arrivalPlatform || '?',
    delayMinutes: Math.round(depDelay / 60),
    status: status,
  };
}

// fallback data if API fails
function getFallbackData(fromId, toId) {
  if (fromId === '8103002' && toId === '8100009') {
    // St. Pölten to Linz fallback
    return [
      {
        train: 'RJ 542',
        trainType: 'RJ',
        departure: new Date(Date.now() + 30 * 60000).toISOString(),
        arrival: new Date(Date.now() + 101 * 60000).toISOString(),
        departurePlatform: '2',
        arrivalPlatform: '1',
        delayMinutes: 0,
        status: 'scheduled'
      },
      {
        train: 'RJ 544',
        trainType: 'RJ',
        departure: new Date(Date.now() + 90 * 60000).toISOString(),
        arrival: new Date(Date.now() + 161 * 60000).toISOString(),
        departurePlatform: '2',
        arrivalPlatform: '1',
        delayMinutes: 0,
        status: 'scheduled'
      },
      {
        train: 'RJ 546',
        trainType: 'RJ',
        departure: new Date(Date.now() + 150 * 60000).toISOString(),
        arrival: new Date(Date.now() + 221 * 60000).toISOString(),
        departurePlatform: '2',
        arrivalPlatform: '1',
        delayMinutes: 0,
        status: 'scheduled'
      }
    ];
  } else {
    // Linz to St. Pölten fallback
    return [
      {
        train: 'RJ 543',
        trainType: 'RJ',
        departure: new Date(Date.now() + 25 * 60000).toISOString(),
        arrival: new Date(Date.now() + 96 * 60000).toISOString(),
        departurePlatform: '1',
        arrivalPlatform: '2',
        delayMinutes: 0,
        status: 'scheduled'
      },
      {
        train: 'RJ 545',
        trainType: 'RJ',
        departure: new Date(Date.now() + 85 * 60000).toISOString(),
        arrival: new Date(Date.now() + 156 * 60000).toISOString(),
        departurePlatform: '1',
        arrivalPlatform: '2',
        delayMinutes: 0,
        status: 'scheduled'
      },
      {
        train: 'RJ 547',
        trainType: 'RJ',
        departure: new Date(Date.now() + 145 * 60000).toISOString(),
        arrival: new Date(Date.now() + 216 * 60000).toISOString(),
        departurePlatform: '1',
        arrivalPlatform: '2',
        delayMinutes: 0,
        status: 'scheduled'
      }
    ];
  }
}

async function handleRoute(req, res, fromId, toId) {
  try {
    const journeys = await getJourneys(fromId, toId);
    res.json({
      route: fromId === '8103002' ? 'St. Pölten → Linz' : 'Linz → St. Pölten',
      timestamp: new Date().toISOString(),
      trains: journeys
    });
  } catch (error) {
    console.error('Route handler error:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to fetch train data',
      fallback: getFallbackData(fromId, toId)
    });
  }
}

app.get('/trains/stpoelten-linz', async (req, res) => {
  await handleRoute(req, res, '8103002', '8100009');
});

app.get('/trains/linz-stpoelten', async (req, res) => {
  await handleRoute(req, res, '8100009', '8103002');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'ÖBB API Proxy',
    endpoints: [
      '/trains/stpoelten-linz',
      '/trains/linz-stpoelten',
      '/health'
    ]
  });
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ÖBB API Proxy server running on port ${PORT}`);
  console.log('Available endpoints:');
  console.log('  /trains/stpoelten-linz');
  console.log('  /trains/linz-stpoelten');
  console.log('  /health');
});