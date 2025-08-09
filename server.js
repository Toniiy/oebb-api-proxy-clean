const express = require('express');
const cors = require('cors');
const { createClient } = require('hafas-client');
  const oebbProfile = require('hafas-client/p/oebb/index.js');

  const app = express();
  app.use(cors());

  // Create a new profile object with locale
  const customProfile = {
    ...oebbProfile,
    locale: 'de-AT'
  };
  const hafas = createClient(customProfile, 'oebb-proxy');

  The problem: You can't modify properties on the imported profile object. We need to create a new object that includes
   the locale.

  Alternative approach if that doesn't work:
  const oebbProfile = require('hafas-client/p/oebb/index.js');

  const app = express();
  app.use(cors());

  // Clone and modify the profile
  const customProfile = Object.assign({}, oebbProfile, { locale: 'de-AT' });
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
    console.error(err);
    return [];
  }
}

// transform journey to simplified object
function transformJourney(journey) {
  const leg = journey.legs[0];
  const depDelay = leg.departureDelay || 0;
  const status = depDelay <= 0 ? 'on-time' : depDelay <= 5 * 60 ? 'slightly-delayed' : 'delayed';
  return {
    train: leg.line && leg.line.name ? leg.line.name : '',
    trainType: leg.line && leg.line.product && leg.line.product.type ? leg.line.product.type : '',
    departure: leg.departure,
    arrival: leg.arrival,
    departurePlatform: leg.departurePlatform,
    arrivalPlatform: leg.arrivalPlatform,
    delayMinutes: depDelay / 60,
    status: status,
  };
}

async function handleRoute(req, res, fromId, toId) {
  const journeys = await getJourneys(fromId, toId);
  res.json(journeys);
}

app.get('/trains/stpoelten-linz', async (req, res) => {
  await handleRoute(req, res, '8103002', '8100009');
});

app.get('/trains/linz-stpoelten', async (req, res) => {
  await handleRoute(req, res, '8100009', '8103002');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server is running on port ' + PORT);
});
